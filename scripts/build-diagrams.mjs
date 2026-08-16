#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Build the Sutra diagram set — self-contained dark HTML with HAND-LAID inline
 * SVG. No Mermaid, no client-side layout engine, so a diagram cannot degrade to
 * a white page or to haphazard auto-routing.
 *
 * WHY A GENERATOR RATHER THAN SIX HAND-WRITTEN FILES
 * The discipline this set is held to is "a structural change is not done until
 * its diagram follows". That only holds if updating a diagram is cheap. Six
 * hand-maintained HTML files share one shell and one palette, and keeping them
 * visually identical by hand is exactly the kind of chore that silently stops
 * happening. The LAYOUTS below are still hand-placed coordinates — the part
 * that needs judgement — while the shell, the palette and the legend are
 * generated, so they cannot drift apart.
 *
 * FONT AND EXPORT POLICY — a deliberate deviation from the shared template.
 * The template loads JetBrains Mono from a CDN. Sutra's release gate requires
 * that an offline install renders correctly, so the font stack is local-first.
 * The export libraries stay on a CDN because they are a convenience rather than
 * a rendering dependency — and `diagram.js` makes the buttons SAY they are
 * unavailable offline rather than failing mysteriously.
 *
 *   node scripts/build-diagrams.mjs
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT = join(ROOT, "docs", "diagrams");
mkdirSync(OUT, { recursive: true });

// ─────────────────────────────────────────────────────────────────────────────
// The semantic palette. A box's TYPE is readable from its colour.
// ─────────────────────────────────────────────────────────────────────────────
const T = {
  authored: { fill: "rgba(76,29,149,0.4)",  stroke: "#a78bfa", dot: "violet",  label: "authored — a person wrote it" },
  derived:  { fill: "rgba(8,51,68,0.4)",    stroke: "#22d3ee", dot: "cyan",    label: "derived — the pipeline produced it" },
  serve:    { fill: "rgba(6,78,59,0.4)",    stroke: "#34d399", dot: "emerald", label: "serve — it answers a question" },
  ops:      { fill: "rgba(120,53,15,0.3)",  stroke: "#fbbf24", dot: "amber",   label: "ops — it runs on a schedule" },
  gate:     { fill: "rgba(136,19,55,0.4)",  stroke: "#fb7185", dot: "rose",    label: "gate — it REFUSES" },
  external: { fill: "rgba(30,41,59,0.5)",   stroke: "#94a3b8", dot: "slate",   label: "external — we do not own it" },
};

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The standard opaque-masked box. The mask goes first so arrows never bleed through. */
function box(x, y, w, h, type, label, sub, sub2) {
  const t = T[type];
  const cx = x + w / 2;
  const parts = [
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" fill="#0f172a"/>`,
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" fill="${t.fill}" stroke="${t.stroke}" stroke-width="1.5"/>`,
    `<text x="${cx}" y="${y + 22}" fill="white" font-size="11" font-weight="600" text-anchor="middle">${esc(label)}</text>`,
  ];
  if (sub) parts.push(`<text x="${cx}" y="${y + 38}" fill="#94a3b8" font-size="9" text-anchor="middle">${esc(sub)}</text>`);
  if (sub2) parts.push(`<text x="${cx}" y="${y + 51}" fill="#94a3b8" font-size="9" text-anchor="middle">${esc(sub2)}</text>`);
  return parts.join("\n      ");
}

/** A dashed boundary with a title at its top-left. */
function group(x, y, w, h, type, title) {
  const t = T[type];
  return [
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12" fill="${t.stroke}0d" stroke="${t.stroke}" stroke-width="1" stroke-dasharray="8,4" opacity="0.6"/>`,
    `<text x="${x + 14}" y="${y + 20}" fill="${t.stroke}" font-size="10" font-weight="600" opacity="0.9">${esc(title)}</text>`,
  ].join("\n      ");
}

function arrow(x1, y1, x2, y2, type = "external", dashed = false, label = "") {
  const t = T[type];
  const out = [
    `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${t.stroke}" stroke-width="1.5"` +
    `${dashed ? ' stroke-dasharray="5,5"' : ""} marker-end="url(#arrowhead)" opacity="0.85"/>`,
  ];
  if (label) {
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    out.push(
      `<rect x="${mx - label.length * 3 - 4}" y="${my - 15}" width="${label.length * 6 + 8}" height="14" rx="3" fill="#020617" opacity="0.9"/>`,
      `<text x="${mx}" y="${my - 5}" fill="${t.stroke}" font-size="8.5" text-anchor="middle">${esc(label)}</text>`,
    );
  }
  return out.join("\n      ");
}

/** The legend. ALWAYS placed outside every boundary; the viewBox is sized to fit it. */
function legend(x, y, types) {
  const parts = [`<text x="${x}" y="${y}" fill="#64748b" font-size="9" font-weight="600">LEGEND</text>`];
  let cx = x;
  for (const k of types) {
    const t = T[k];
    parts.push(
      `<rect x="${cx}" y="${y + 10}" width="11" height="11" rx="2" fill="${t.fill}" stroke="${t.stroke}" stroke-width="1.5"/>`,
      `<text x="${cx + 17}" y="${y + 19}" fill="#94a3b8" font-size="9">${esc(t.label)}</text>`,
    );
    cx += 24 + t.label.length * 5.4;
  }
  return parts.join("\n      ");
}

function card(dot, title, items) {
  return `<div class="card">
        <div class="card-header"><div class="card-dot ${dot}"></div><h3>${esc(title)}</h3></div>
        <ul>${items.map((i) => `<li>${i}</li>`).join("")}</ul>
      </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// THE SHELL.
//
// Note `defer` on the two export libraries. It is load-bearing, not a
// micro-optimisation: they exist only for the user-initiated PNG/PDF export, and
// as render-blocking head scripts they meant that on a machine with no network
// the page showed NOTHING until each request timed out — precisely backwards for
// a documentation set whose release gate is "an offline install renders
// correctly".
//
// It was found by opening the page in a browser and screenshotting it. The
// static check had passed it, because "the dark token is present in the file"
// and "the page renders dark" are DIFFERENT CLAIMS and only the first was being
// measured. `check-diagrams.mjs` now asserts the second.
//
// The explanation lives here rather than in the generated HTML because the
// diagram standard requires the output carry no authoring comments — the
// reasoning belongs with the thing that makes the decision.
// ─────────────────────────────────────────────────────────────────────────────
const SHELL = (d) => `<!DOCTYPE html>
<!-- SPDX-License-Identifier: Apache-2.0 -->
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(d.title)}</title>
  <link rel="stylesheet" href="assets/diagram.css">
  <script defer src="https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js" integrity="sha384-ZZ1pncU3bQe8y31yfZdMFdSpttDoPmOZg2wguVK9almUodir1PghgT0eY7Mrty8H" crossorigin="anonymous"></script>
  <script defer src="https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js" integrity="sha384-en/ztfPSRkGfME4KIm05joYXynqzUgbsG5nMrj/xEFAHXkeZfO3yMK8QQ+mP7p1/" crossorigin="anonymous"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: var(--nc-font-mono); background: var(--nc-bg); min-height: 100vh; padding: 2rem; color: var(--nc-text); }
    .container { max-width: 1280px; margin: 0 auto; }
    .header { margin-bottom: 2rem; }
    .header-row { display: flex; align-items: center; gap: 1rem; margin-bottom: 0.5rem; }
    .pulse-dot { width: 12px; height: 12px; background: ${T[d.accent].stroke}; border-radius: 50%; animation: pulse 2s infinite; }
    @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.5; } }
    h1 { font-size: 1.5rem; font-weight: 700; letter-spacing: -0.025em; }
    .subtitle { color: var(--nc-text-muted); font-size: 0.875rem; margin-left: 1.75rem; max-width: 92ch; line-height: 1.6; }
    .diagram-container { background: var(--nc-surface); border-radius: var(--nc-radius-lg); border: 1px solid var(--nc-border); padding: 1.5rem; overflow: hidden; }
    svg { width: 100%; display: block; }
    .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px,1fr)); gap: 1rem; margin-top: 2rem; }
    .card { background: var(--nc-surface); border-radius: var(--nc-radius); border: 1px solid var(--nc-border); padding: 1.25rem; }
    .card-header { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.75rem; }
    .card-dot { width: 8px; height: 8px; border-radius: 50%; }
    .card-dot.violet { background: #a78bfa; } .card-dot.cyan { background: #22d3ee; } .card-dot.emerald { background: #34d399; }
    .card-dot.amber { background: #fbbf24; } .card-dot.rose { background: #fb7185; } .card-dot.slate { background: #94a3b8; }
    .card h3 { font-size: 0.875rem; font-weight: 600; }
    .card ul { list-style: none; color: var(--nc-text-muted); font-size: 0.75rem; line-height: 1.55; }
    .card li { margin-bottom: 0.5rem; }
    .footer { text-align: center; margin-top: 1.5rem; color: var(--nc-text-faint); font-size: 0.75rem; }
    .toolbar { display: flex; gap: 0.5rem; margin-left: auto; flex-shrink: 0; align-items: center; }
    .toolbar-toggle { background: transparent; border: none; color: var(--nc-text-faint); cursor: pointer; font-size: 1.25rem; line-height: 1; padding: 0.25rem 0.5rem; border-radius: 0.375rem; transition: color .2s, background .2s; }
    .toolbar-toggle:hover { color: var(--nc-text-muted); background: rgba(30,41,59,0.5); }
    .toolbar-actions { display: none; gap: 0.5rem; }
    .toolbar.expanded .toolbar-actions { display: flex; }
    .toolbar-actions button { background: rgba(30,41,59,0.8); border: 1px solid var(--nc-border-bright); color: var(--nc-text-muted); padding: 0.375rem 0.75rem; border-radius: 0.375rem; font-family: inherit; font-size: 0.75rem; cursor: pointer; transition: all .2s; white-space: nowrap; }
    .toolbar-actions button:hover { background: rgba(51,65,85,0.8); color: white; border-color: #475569; }
    @media print { body { background: #020617; padding: 1rem; } .toolbar, .zoom-bar { display: none !important; } }
  </style>
</head>
<body>
  <div class="container" id="report-container">
    <div class="header">
      <div class="header-row">
        <div class="pulse-dot"></div>
        <h1>${esc(d.h1)}</h1>
        <div class="toolbar">
          <div class="toolbar-actions">
            <button onclick="copyAsImage(this)">📋 Copy</button>
            <button onclick="downloadPNG(this)">🖼️ PNG</button>
            <button onclick="downloadPDF(this)">📄 PDF</button>
          </div>
          <button class="toolbar-toggle" onclick="this.parentElement.classList.toggle('expanded')" title="Export options" aria-label="Export options">⋯</button>
        </div>
      </div>
      <p class="subtitle">${d.subtitle}</p>
    </div>

    <div class="diagram-container">
      <svg viewBox="${d.viewBox}">
        <defs>
          <marker id="arrowhead" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
            <polygon points="0 0, 10 3.5, 0 7" fill="#64748b" />
          </marker>
          <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
            <path d="M 40 0 L 0 0 0 40" fill="none" stroke="#1e293b" stroke-width="0.5"/>
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#grid)" />
      ${d.body}
      </svg>
    </div>

    <div class="cards">
      ${d.cards.join("\n      ")}
    </div>

    <p class="footer">${d.footer}</p>
    <a class="gallery-link" href="index.html">← all diagrams</a>
  </div>

  <script src="assets/diagram.js"></script>
  <script>
    async function shot(){const el=document.getElementById('report-container');const r=el.getBoundingClientRect();const pad=32;return html2canvas(document.body,{backgroundColor:'#020617',scale:2,useCORS:true,ignoreElements:(e)=>e.classList&&(e.classList.contains('toolbar')||e.classList.contains('zoom-bar')),x:r.left+window.scrollX-pad,y:r.top+window.scrollY-pad,width:r.width+pad*2,height:r.height+pad*2});}
    async function copyAsImage(btn){const o=btn.textContent;try{const c=await shot();const b=await new Promise(r=>c.toBlob(r,'image/png'));await navigator.clipboard.write([new ClipboardItem({'image/png':b})]);btn.textContent='✓ Copied!';}catch(e){btn.textContent='✗ '+(e.message||'Failed').slice(0,20);}setTimeout(()=>btn.textContent=o,2200);}
    async function downloadPNG(btn){const o=btn.textContent;btn.textContent='⏳ ...';try{const c=await shot();const a=document.createElement('a');a.download='${d.slug}.png';a.href=c.toDataURL('image/png');a.click();btn.textContent='✓ Done!';}catch(e){btn.textContent='✗ '+(e.message||'Failed').slice(0,20);}setTimeout(()=>btn.textContent=o,2200);}
    async function downloadPDF(btn){const o=btn.textContent;btn.textContent='⏳ ...';try{const c=await shot();const {jsPDF}=window.jspdf;const or=c.width>c.height?'landscape':'portrait';const p=new jsPDF({orientation:or,unit:'px',format:[c.width,c.height],hotfixes:['px_scaling']});p.addImage(c.toDataURL('image/png'),'PNG',0,0,c.width,c.height);p.save('${d.slug}.pdf');btn.textContent='✓ Done!';}catch(e){btn.textContent='✗ '+(e.message||'Failed').slice(0,20);}setTimeout(()=>btn.textContent=o,2200);}
  </script>
</body>
</html>
`;

export { T, box, group, arrow, legend, card, SHELL, esc, OUT };
