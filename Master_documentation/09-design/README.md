<!-- SPDX-License-Identifier: Apache-2.0 -->
# 09 · Design — Nocturne

Dark-first, monospace, semantic-by-type. The tokens are the contract:
[`../../docs/diagrams/assets/tokens.css`](../../docs/diagrams/assets/tokens.css).

## The palette IS the legend

A box's **type** is readable from its colour without consulting a key.

| Type | Meaning | Stroke |
|---|---|---|
| `authored` | a person wrote it | violet `#a78bfa` |
| `derived` | the pipeline produced it | cyan `#22d3ee` |
| `serve` | it answers a question | emerald `#34d399` |
| `ops` | it runs on a schedule | amber `#fbbf24` |
| `gate` | **it REFUSES** | rose `#fb7185` |
| `external` | we do not own it | slate `#94a3b8` |

## The diagram set

Six views plus a gallery:
[`../../docs/diagrams/`](../../docs/diagrams/index.html).

Hand-laid **inline SVG** in self-contained dark HTML. No Mermaid, no
client-side layout engine — so a diagram cannot degrade to a white page or to
haphazard auto-routing.

Regenerate with `npm run diagrams`; verify with `npm run check:diagrams`.

## Two deliberate deviations from the shared template

Both because the release gate is **"an offline install renders correctly"**:

1. **The font stack is local-first**, not a CDN link. A doc set that phones home
   in order to render stops working in exactly the air-gapped environment it was
   chosen for.
2. **The export libraries are `defer`red.** As render-blocking head scripts they
   meant that with no network the page showed *nothing* until each request timed
   out. Found by opening the page in a browser — the static check had passed it,
   because *"the dark token is in the file"* and *"the page renders dark"* are
   different claims.

## Interactivity is generic

`assets/diagram.js` adds pan, zoom and hover-isolate by auto-tagging any
`<rect>` with a stroke, an `rgba()` fill and width > 30. Keep to the standard
opaque-masked box pattern and it works for free — there is no per-diagram
JavaScript anywhere in the set.
