<!-- SPDX-License-Identifier: Apache-2.0 -->
# 12 · Deferred

The parking lot. **Nothing is dropped silently** — if it was postponed, it is
here with a reason and a priority.

| Item | Reason deferred | Priority | Date |
|---|---|---|---|
| **Provider dispatch (the HTTP client)** | Sutra ships deterministic-first. A half-written client that sometimes works is worse than an honest "no model configured". Whatever implements it must receive the extract **in full** (D1). | **H** | 2026-08-16 |
| **`sutra eval` — the retrieval golden set** | M6. Needs a 50-question graded set over a shipped demo corpus. **An unmeasured retrieval layer cannot be improved safely**, so this is the one place "just ship it" is the wrong instinct. | **H** | 2026-08-16 |
| **The remaining defect tests** | 17 of 39 defects have named absence tests. The rest are addressed in code with reasoning but have no test that fails against a planted instance. | **H** | 2026-08-16 |
| **A cross-OS CI run** | Workflows are written but have never executed. Everything so far was verified on Windows only. | **H** | 2026-08-16 |
| Typed knowledge graph (`automation/kg/`) | An optional module in the brief. The wikilink graph covers the core need. | M | 2026-08-16 |
| Multimodal extraction (PDF, OCR) | The classifier's OCR floor (I16) is implemented and tested; the extractors themselves are not. `extract_reason` reports `tool-missing`, which is retryable by design. | M | 2026-08-16 |
| `sutra vault reconcile` | D25's safe reconcile — snapshot to a rescue branch, *then* sync. `backup.ps1` covers the snapshot half. | M | 2026-08-16 |
| Skills (`skills/public`, `skills/trusted`) | The enumeration, trust split and MCP tools exist and are tested. **No skills ship** — they are the user's to write. | L | 2026-08-16 |
| Vendored font binaries | The stack is local-first and degrades to the platform monospace. Shipping the WOFF2 files plus `OFL.txt` is outstanding. | L | 2026-08-16 |
| Dashboard HTML assets | The route table, gating and tests exist; the static assets do not. Shape (c) is optional. | L | 2026-08-16 |
| User ↔ user exchange | An explicit v1 **non-goal**. Retained as the natural second act; the architecture must not foreclose it, so identity, tiering and provenance stay instance-scoped. | — | 2026-08-16 |
| Multi-user, RBAC, SSO, admin console, SOC2 artifacts | v2.0 — they are `ee/`, and a different product. | — | 2026-08-16 |
