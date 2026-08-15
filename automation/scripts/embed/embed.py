# SPDX-License-Identifier: Apache-2.0
# /// script
# requires-python = ">=3.10"
# dependencies = ["fastembed>=0.3"]
# ///
"""
Local embedding index.

Runs entirely on this machine, through `uv run`, with no API key and no network
call at inference time. The model is downloaded once, on first use, and cached.

Two modes:
    --vault <path>     rebuild the index over the vault's visible notes
    --query "<text>"   embed one string and print {"vector": [...]}

── WHY THIS IS OPTIONAL, AND SAYS SO ─────────────────────────────────────────
Sutra's default is deterministic-first. Without this script — without `uv`
installed at all — keyword search, BM25, tiering, linking, the graph, the gate
and cited answers all work exactly as they do with it. What is lost is VECTOR
RECALL: finding a note by meaning when you cannot remember its words.

That is a real capability and it is worth having. It is not the product.

── I16 · THE OCR FLOOR APPLIES HERE TOO ──────────────────────────────────────
An embedding is a derived artifact of a note, and it carries the note's tier
with it. A `secret` note is embedded — the index is local — but its vector
entry records `sensitivity: secret`, and every reader re-applies the gate.
Nothing in this file decides what may leave the machine; it only records what
each vector came from, faithfully, so the gate above it can.

── D13 / I18 · THE HEADER IS COMPUTED AT WRITE TIME ──────────────────────────
`dim` and the note count are measured from the arrays they describe, as they are
written. Never copied forward from a previous run.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

# Directories that are never content, even inside a walk root. Kept in step with
# `EXCLUDED_DIR_NAMES` in packages/core/src/config.ts — `config/` holds the
# vault's own templates and schemas, and a template embedded as knowledge is a
# confident, useless search result.
EXCLUDED_DIRS = {"config", ".git", ".obsidian", ".trash", "node_modules", ".sutra"}
WALK_ROOTS = ("vault", "compiled/pages")

FRONTMATTER_RE = re.compile(r"\A---\r?\n(.*?)\r?\n---\r?\n?(.*)\Z", re.S)
HEADING_RE = re.compile(r"^#\s+(.+)$", re.M)

TIER_ALIAS = {
    "public": "public",
    "hosted_allowed": "public",
    "private": "private",
    "review_required": "private",
    "secret": "secret",
    "local_only": "secret",
}


def parse_note(text: str) -> tuple[dict[str, str], str]:
    """Split frontmatter from body. Deliberately minimal — no YAML dependency."""
    if text.startswith("﻿"):
        text = text[1:]
    m = FRONTMATTER_RE.match(text)
    if not m:
        return {}, text
    fm: dict[str, str] = {}
    for line in m.group(1).splitlines():
        km = re.match(r"^([A-Za-z0-9_]+):\s*(.*)$", line)
        if km:
            fm[km.group(1)] = km.group(2).strip().strip("\"'")
    return fm, m.group(2)


def coerce_tier(raw: str | None) -> str:
    """Unknown or absent -> `private`. An unlabelled note is not one anyone
    decided was safe to share."""
    return TIER_ALIAS.get((raw or "").strip().lower(), "private")


def is_do_not_learn(fm: dict[str, str]) -> bool:
    return (fm.get("do_not_learn") or "").strip().lower() in {"true", "yes", "1"}


def walk_notes(vault: Path):
    for root_rel in WALK_ROOTS:
        root = vault / root_rel
        if not root.is_dir():
            continue
        for path in root.rglob("*.md"):
            if any(part in EXCLUDED_DIRS for part in path.relative_to(vault).parts):
                continue
            yield path


def main() -> int:
    ap = argparse.ArgumentParser(description="Sutra local embedding index")
    ap.add_argument("--vault", help="vault root; rebuild the index")
    ap.add_argument("--query", help="embed one string and print its vector")
    ap.add_argument("--model", default="BAAI/bge-small-en-v1.5")
    args = ap.parse_args()

    if not args.vault and not args.query:
        ap.error("one of --vault or --query is required")

    try:
        from fastembed import TextEmbedding
    except ImportError:
        # LOUD, and on stderr so it cannot corrupt a --query JSON response.
        print(
            "embed: fastembed is not available. `uv run` installs it from this "
            "script's inline dependency block; if you are running python directly, "
            "use `uv run automation/scripts/embed/embed.py` instead.",
            file=sys.stderr,
        )
        return 6  # exit 6 = runner missing, per the CLI's governance exit codes

    model = TextEmbedding(model_name=args.model)

    # ── one query ─────────────────────────────────────────────────────────────
    if args.query:
        vector = next(iter(model.embed([args.query]))).tolist()
        # stdout is the RESPONSE CHANNEL here. Nothing else may be written to it.
        print(json.dumps({"vector": vector}))
        return 0

    # ── rebuild ───────────────────────────────────────────────────────────────
    vault = Path(args.vault)
    if not vault.is_dir():
        print(f"embed: vault not found: {vault}", file=sys.stderr)
        return 2

    notes = []
    texts = []
    for path in walk_notes(vault):
        try:
            raw = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        fm, body = parse_note(raw)

        # A `do_not_learn` note is not embedded AT ALL. A vector is a derived
        # representation of the text, and "excluded from every model surface"
        # has to mean excluded from the one that finds things by meaning too.
        if is_do_not_learn(fm):
            continue

        heading = HEADING_RE.search(body)
        title = heading.group(1).strip() if heading else path.stem
        rel = path.relative_to(vault).as_posix()

        notes.append(
            {
                "relPath": rel,
                "title": title,
                "type": fm.get("type", "Untyped"),
                # THE TIER TRAVELS WITH THE VECTOR. Every reader re-applies the
                # gate; the index never decides what may leave.
                "sensitivity": coerce_tier(fm.get("sensitivity")),
            }
        )
        # Title first: it is the strongest signal about what a note is about,
        # and prepending it measurably improves recall on short notes.
        texts.append(f"{title}\n\n{body.strip()}")

    if not texts:
        # An empty vault is not an error. Exit 0, say what happened.
        print("embed: no notes to index (this is fine on a new vault)")
        print("considered: 0")
        print("produced: 0")
        return 0

    vectors = [v.tolist() for v in model.embed(texts)]
    for note, vec in zip(notes, vectors):
        note["vector"] = vec

    out_path = vault / "state" / "index" / "embeddings.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)

    # D13/I18 — every counter measured from the collection it summarises, here,
    # as it is written. `dim` comes from an actual vector, not from the model's
    # advertised size.
    index = {
        "model": args.model,
        "dim": len(vectors[0]) if vectors else 0,
        "built_at": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat(),
        "note_count": len(notes),
        "notes": notes,
    }
    assert index["note_count"] == len(index["notes"]), "header disagrees with body (I18)"

    tmp = out_path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(index), encoding="utf-8")
    os.replace(tmp, out_path)  # atomic: a crash mid-write must not truncate the index

    print(f"embed: {len(notes)} note(s), dim {index['dim']} -> {out_path}")
    print(f"considered: {len(notes)}")
    print(f"produced: {len(notes)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
