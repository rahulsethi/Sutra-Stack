#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * The diagram cleanliness checklist, asserted rather than eyeballed.
 *
 * Six diagrams that are supposed to look like one system will not stay that way
 * on inspection alone — "they all look fine" is exactly the report you get right
 * up until one of them does not. So the checklist from the diagram standard is
 * mechanical:
 *
 *   1. opens DARK standalone — no white background, no render dependency
 *   2. every typed box is OPAQUE-MASKED, so arrows never bleed through
 *   3. the legend sits OUTSIDE every boundary, and the viewBox fits it
 *   4. no authoring/instruction comments leak into the output
 *   5. the export toolbar, summary cards and footer are present
 *   6. the page renders with NO network — fonts are local-first
 *
 * Run: node scripts/check-diagrams.mjs
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIR = join(ROOT, "docs", "diagrams");

if (!existsSync(DIR)) {
  console.error("check-diagrams: docs/diagrams/ does not exist. Run `node scripts/diagrams.mjs`.");
  process.exit(1);
}

const problems = [];
const fail = (file, msg) => problems.push(`${file}: ${msg}`);

const files = readdirSync(DIR).filter((f) => f.endsWith(".html") && f !== "index.html");
if (files.length === 0) {
  console.error("check-diagrams: no diagrams found. Run `node scripts/diagrams.mjs`.");
  process.exit(1);
}

for (const f of files) {
  const html = readFileSync(join(DIR, f), "utf8");

  // 1 · dark, and self-contained
  if (!/--nc-bg|#020617/.test(html)) fail(f, "no dark canvas token — it would render white");
  if (/mermaid/i.test(html)) fail(f, "references Mermaid — diagrams are hand-laid inline SVG, with no render step");
  if (!/<svg viewBox=/.test(html)) fail(f, "no inline <svg>");

  // 2 · opaque-masked boxes. Every translucent typed rect needs an opaque twin
  //     at the same coordinates, or arrows behind it bleed through.
  //
  //     The >30px width threshold is the SAME ONE `assets/diagram.js` uses to
  //     decide what is a box. Keeping the two in step matters: if this check
  //     and the interactivity disagreed about what a box is, one of them would
  //     be silently wrong about every diagram. Legend swatches are 11×11 and
  //     have nothing drawn behind them.
  const BOX_MIN_WIDTH = 30;
  const typed = [...html.matchAll(/<rect x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)" rx="\d+" fill="rgba\(/g)]
    .filter((m) => Number(m[3]) > BOX_MIN_WIDTH);
  const masks = new Set(
    [...html.matchAll(/<rect x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)" rx="\d+" fill="#0f172a"\/>/g)]
      .map((m) => `${m[1]},${m[2]},${m[3]},${m[4]}`),
  );
  for (const m of typed) {
    const key = `${m[1]},${m[2]},${m[3]},${m[4]}`;
    // Boundary groups are deliberately unmasked — they are translucent frames.
    const isBoundary = html.includes(`<rect x="${m[1]}" y="${m[2]}" width="${m[3]}" height="${m[4]}" rx="12"`);
    if (!masks.has(key) && !isBoundary) {
      fail(f, `box at ${key} has no opaque mask — arrows will bleed through it`);
    }
  }

  // 3 · the legend, and a viewBox that fits it
  const legendMatch = /y="(\d+)" fill="#64748b" font-size="9" font-weight="600">LEGEND</.exec(html);
  if (!legendMatch) {
    fail(f, "no legend — the semantic palette IS the key, so every diagram carries one");
  } else {
    const legendY = Number(legendMatch[1]);
    const vb = /viewBox="0 0 (\d+) (\d+)"/.exec(html);
    if (!vb) fail(f, "unparseable viewBox");
    else {
      const height = Number(vb[2]);
      if (legendY + 30 > height) fail(f, `the legend (y=${legendY}) overflows the viewBox (height ${height})`);
      // The legend must sit BELOW every boundary box, not inside one.
      const boundaries = [...html.matchAll(/<rect x="\d+" y="(\d+)" width="\d+" height="(\d+)" rx="12"/g)];
      for (const b of boundaries) {
        const bottom = Number(b[1]) + Number(b[2]);
        if (legendY < bottom) {
          fail(f, `the legend (y=${legendY}) sits inside a boundary ending at y=${bottom}`);
        }
      }
    }
  }

  // 4 · no authoring comments. The standard lives in the skill, not in the output.
  const comments = [...html.matchAll(/<!--([\s\S]*?)-->/g)].filter((c) => !/^\s*(SPDX|\[if)/.test(c[1]));
  if (comments.length) fail(f, `${comments.length} authoring comment(s) leaked into the output`);

  // 5 · the chrome
  if (!/toolbar-actions/.test(html)) fail(f, "no export toolbar");
  if (!/class="cards"/.test(html)) fail(f, "no summary cards");
  if (!/class="footer"/.test(html)) fail(f, "no footer");
  if (!/assets\/diagram\.js/.test(html)) fail(f, "does not load the shared interactivity");

  // 6 · renders offline. A CDN FONT would leave the page unstyled with no network.
  if (/fonts\.googleapis\.com|fonts\.gstatic\.com/.test(html)) {
    fail(f, "loads a font from a CDN — an offline install must render correctly");
  }

  //     …and no RENDER-BLOCKING remote script. This one was found by opening the
  //     page in a browser, not by reading it: two CDN <script> tags sat in <head>
  //     without `defer`, so with no network the page showed NOTHING until each
  //     request timed out.
  //
  //     The lesson generalises past this file. "The dark token is present" and
  //     "the page renders dark" are DIFFERENT CLAIMS, and this check was only
  //     measuring the first — which is the register's own most common category
  //     of wrong answer: measuring the wrong thing rather than lacking data.
  const head = html.slice(0, html.indexOf("</head>"));
  for (const m of head.matchAll(/<script\b([^>]*)\bsrc="(https?:[^"]+)"/g)) {
    if (!/\bdefer\b|\basync\b/.test(m[1])) {
      fail(f, `render-blocking remote script in <head> (${m[2].split("/").pop()}) — with no network the page shows nothing until it times out. Add \`defer\`.`);
    }
  }

  // Overlap check: stacked boxes in the same column need a real gap.
  const boxes = typed.map((m) => ({ x: +m[1], y: +m[2], w: +m[3], h: +m[4] }));
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      const overlapX = a.x < b.x + b.w && b.x < a.x + a.w;
      const overlapY = a.y < b.y + b.h && b.y < a.y + a.h;
      if (overlapX && overlapY) {
        fail(f, `boxes overlap: (${a.x},${a.y},${a.w},${a.h}) and (${b.x},${b.y},${b.w},${b.h})`);
      }
    }
  }
}

// The gallery must list every diagram — "created ≠ wired" applies here too: a
// diagram nothing links to is one nobody will ever open.
const index = readFileSync(join(DIR, "index.html"), "utf8");
for (const f of files) {
  if (!index.includes(`href="${f}"`)) {
    fail("index.html", `does not link ${f} — a diagram nothing links to is one nobody opens`);
  }
}

if (problems.length) {
  console.error("check-diagrams: FAIL\n");
  for (const p of problems) console.error("  ✗ " + p);
  process.exit(1);
}

console.log(`check-diagrams: OK — ${files.length} diagrams, all dark, masked, legended, offline-safe, and linked from the gallery.`);
