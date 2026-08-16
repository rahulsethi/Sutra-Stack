// SPDX-License-Identifier: Apache-2.0
//
// Shared interactivity for every diagram: pan, zoom, hover-highlight.
//
// GENERIC over the hand-laid SVG. It auto-tags any <rect> carrying both a
// stroke and an rgba()/rgb() fill and wider than 30px — which is exactly the
// standard opaque-masked box pattern. Keep to that pattern and interactivity
// comes for free; there is no per-diagram JavaScript anywhere in this set.
(function () {
  const container = document.querySelector(".diagram-container");
  const svg = container && container.querySelector("svg");
  if (!svg) return;

  // ── Tag the typed boxes ──────────────────────────────────────────────────
  for (const rect of svg.querySelectorAll("rect")) {
    const fill = rect.getAttribute("fill") || "";
    const stroke = rect.getAttribute("stroke");
    const w = parseFloat(rect.getAttribute("width") || "0");
    if (!stroke || !/^rgba?\(/.test(fill) || w <= 30) continue;
    rect.classList.add("nc-box");
    rect.style.color = stroke; // so drop-shadow(currentColor) picks up the type
  }

  for (const box of svg.querySelectorAll(".nc-box")) {
    box.addEventListener("mouseenter", () => {
      container.classList.add("has-hover");
      box.classList.add("nc-hover");
    });
    box.addEventListener("mouseleave", () => {
      container.classList.remove("has-hover");
      box.classList.remove("nc-hover");
    });
  }

  // ── Pan and zoom ─────────────────────────────────────────────────────────
  let scale = 1, tx = 0, ty = 0, dragging = false, sx = 0, sy = 0;

  const apply = () => { svg.style.transform = "translate(" + tx + "px," + ty + "px) scale(" + scale + ")"; };
  const reset = () => { scale = 1; tx = 0; ty = 0; apply(); };

  const bar = document.createElement("div");
  bar.className = "zoom-bar";
  bar.innerHTML =
    '<button title="Zoom in">+</button>' +
    '<button title="Zoom out">−</button>' +
    '<button title="Reset view">○</button>' +
    '<span class="hint">drag to pan · wheel to zoom · hover a box to isolate it</span>';
  container.parentNode.insertBefore(bar, container);

  const buttons = bar.querySelectorAll("button");
  buttons[0].onclick = () => { scale = Math.min(scale * 1.25, 6); apply(); };
  buttons[1].onclick = () => { scale = Math.max(scale / 1.25, 0.3); apply(); };
  buttons[2].onclick = reset;

  container.addEventListener("wheel", (e) => {
    e.preventDefault();
    const next = e.deltaY < 0 ? scale * 1.1 : scale / 1.1;
    scale = Math.min(Math.max(next, 0.3), 6);
    apply();
  }, { passive: false });

  container.addEventListener("mousedown", (e) => {
    dragging = true; sx = e.clientX - tx; sy = e.clientY - ty;
    container.classList.add("dragging");
  });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    tx = e.clientX - sx; ty = e.clientY - sy; apply();
  });
  window.addEventListener("mouseup", () => {
    dragging = false;
    container.classList.remove("dragging");
  });

  // An export must capture the WHOLE diagram, not the panned viewport.
  for (const b of document.querySelectorAll(".toolbar-actions button")) {
    b.addEventListener("click", reset, true);
  }

  // ── Honest degradation when the export libraries are absent (offline) ─────
  //
  // The DIAGRAM renders fully offline; only PNG/PDF export needs the CDN. Say
  // exactly that, rather than letting a click report a mysterious failure.
  //
  // This runs on `load`, NOT immediately: the export libraries are `defer`red so
  // they cannot block first paint, and a deferred script has not executed by the
  // time this file runs. Checking too early would report "offline" on every
  // machine — a degradation notice that is always wrong is worse than none,
  // because it teaches people to ignore the one time it is right.
  window.addEventListener("load", () => {
    if (typeof window.html2canvas !== "undefined") return;
    for (const b of document.querySelectorAll(".toolbar-actions button")) {
      b.classList.add("unavailable");
      b.title =
        "Export needs html2canvas/jsPDF, which load from a CDN. You are offline or they are blocked. " +
        "The diagram itself renders fully offline — only PNG/PDF export is affected.";
      const label = b.textContent;
      b.onclick = (e) => {
        e.preventDefault();
        b.textContent = "offline — no export";
        setTimeout(() => { b.textContent = label; }, 2200);
      };
    }
  });
})();
