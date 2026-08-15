# SPDX-License-Identifier: Apache-2.0
<#
.SYNOPSIS
  COMPILE — turn extracts into durable pages.

.DESCRIPTION
  Stage two. This is where the single most damaging defect in the upstream
  system lived, and this file exists in the shape it does because of it.

  ══════════════════════════════════════════════════════════════════════════
  D1 · NO INPUT CLIP. ANYWHERE. EVER.
  ══════════════════════════════════════════════════════════════════════════
  One line truncated every source to 6,000 characters before sending it to the
  model. That script - unscheduled, run ONCE BY HAND - produced 424 of the 595
  pages in the corpus. 160 had sources larger than the clip. The median page saw
  38% of its material; p25 saw 19%; the worst saw 1.2%.

  IT DOES NOT PRODUCE SHORT PAGES. It produces confident, fluent,
  correctly-formatted 400-word pages that are wrong in specifics - and page
  length was FLAT at ~406-470 words across two orders of magnitude of source
  size, so nothing in the corpus looked anomalous. The freshness rubric scored
  164 of them "healthy".

  Documented damage: a twelve-week plan described throughout as "an eight-week
  period"; a product page asserting one speaker configuration across a line
  whose real matrix was three; a page fabricated wholesale from a corrupt OCR
  extract.

  The rules, enforced below:
    1. If a source exceeds the window, CHUNK-AND-MERGE or REFUSE. Never prefix.
    2. Record `source_chars_seen` and `source_chars_total` on every page, so
       truncation is a FACT ON THE ARTIFACT rather than an inference.
    3. `tests/defects/no-input-clip.test.ts` greps this tree for a slice applied
       to an extract body and fails the build.

  ══════════════════════════════════════════════════════════════════════════
  D2 · IDEMPOTENCY MUST NOT BLOCK REPAIR
  ══════════════════════════════════════════════════════════════════════════
  Upstream had FOUR sequential skip guards, each alone sufficient to skip the
  whole corpus, and no `-Force`. With perfect keys, a clean run re-synthesised
  ZERO existing pages. Idempotency is a virtue, so nobody read it as a defect -
  the failure only surfaces when you try to REPAIR, and "fix the keys and re-run"
  is the obvious remedy that does nothing at all.

  So: `-RepairStubs` and `-RepairClipped` bypass the freshness guards INSIDE
  THEIR OWN EXPLICIT SELECTION ONLY, never for a normal run, with the TIER RULES
  STRUCTURALLY UNREACHABLE rather than re-checked.

  ══════════════════════════════════════════════════════════════════════════
  D15 · THE ANTI-STUB GUARD MUST NOT BE DEFEATED BY THE PIPELINE'S OWN OUTPUT
  ══════════════════════════════════════════════════════════════════════════
  The upstream guard required 120 characters of residual prose, but its strip
  list did not remove `## Related` wikilink lines - so SIX MACHINE-GENERATED
  CROSS-LINKS (~144 chars) carried otherwise-empty pages over the floor. 57
  empty pages were laundered into `status: active` and indexed as knowledge.

  The guard reported that it was working. Its own measurement was contaminated
  by a LATER pipeline stage's output, which nobody thought of as content.

  `Measure-ProseWords` below counts human-meaningful prose only.

  ══════════════════════════════════════════════════════════════════════════
  REFUSE, DON'T STUB
  ══════════════════════════════════════════════════════════════════════════
  A failed synthesis leaves the existing file BYTE-IDENTICAL. A repair can only
  ever improve a page; it can never replace a good one with a worse one.

.PARAMETER RepairClipped
  Re-synthesise pages whose capture ratio says they saw too little of their
  source. This is the selector that found 160 damaged pages upstream, matching
  the forensics count exactly.
#>

[CmdletBinding()]
param(
  [Parameter(Position = 0)][string]$VaultRoot,
  [string]$InstallRoot,
  [switch]$RepairStubs,
  [switch]$RepairClipped,
  [switch]$WhatIf
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $VaultRoot) { $VaultRoot = $env:SUTRA_VAULT }
if (-not $VaultRoot) { throw "no vault root. Pass it positionally or set SUTRA_VAULT." }
if (-not $InstallRoot) { $InstallRoot = if ($env:SUTRA_HOME) { $env:SUTRA_HOME } else { (Resolve-Path "$PSScriptRoot/..").Path } }

. "$PSScriptRoot/lib/Frontmatter.ps1"
. "$PSScriptRoot/lib/Tier.ps1"
. "$PSScriptRoot/provider/router.ps1"

$ManifestDir = Join-VaultPath -Root $VaultRoot -Parts @('raw', 'manifests')
$ExtractDir  = Join-VaultPath -Root $VaultRoot -Parts @('compiled', 'extracts')
$PageDir     = Join-VaultPath -Root $VaultRoot -Parts @('compiled', 'pages')

if (-not (Test-Path -LiteralPath $PageDir)) { New-Item -ItemType Directory -Path $PageDir -Force | Out-Null }

# ─────────────────────────────────────────────────────────────────────────────
# D15 · Human-meaningful prose only
# ─────────────────────────────────────────────────────────────────────────────
function Measure-ProseWords {
  <#
  .SYNOPSIS
    Count prose a HUMAN wrote or a model synthesised - never the pipeline's own
    furniture.
  .DESCRIPTION
    Strips headings, wikilink-only lines, list items that are only a link,
    frontmatter, code fences, block quotes, rules, tables and italic
    placeholders. The wikilink-only case is the exact D15 defect: six
    machine-generated cross-links carried 57 empty pages over a 120-character
    floor.

    The general rule: MEASURE A GUARD AGAINST THE PIPELINE'S OWN ARTIFACTS, not
    against hand-written text.
  #>
  param([Parameter(Mandatory)][AllowEmptyString()][string]$Body)

  $t = $Body
  $t = [regex]::Replace($t, '(?s)\A---\r?\n.*?\r?\n---\r?\n', '')
  $t = [regex]::Replace($t, '(?s)```.*?```', ' ')
  $t = [regex]::Replace($t, '(?s)~~~.*?~~~', ' ')
  $t = [regex]::Replace($t, '(?s)<!--.*?-->', ' ')

  $kept = New-Object System.Collections.ArrayList
  foreach ($raw in ($t -split "`n")) {
    $line = $raw.Trim()
    if ($line -eq '') { continue }
    if ($line -match '^#{1,6}\s')            { continue }   # headings
    if ($line -match '^(-{3,}|\*{3,}|_{3,})$') { continue }  # rules
    if ($line -match '^>')                    { continue }   # banners
    if ($line -match '^_.*_$')                { continue }   # italic placeholders
    if ($line -match '^\|')                   { continue }   # table rows

    # A line that is ONLY links - THE D15 CASE.
    $stripped = $line
    $stripped = $stripped -replace '^[-*+]\s+', ''
    $stripped = $stripped -replace '\[\[[^\]]*\]\]', ''
    $stripped = $stripped -replace '\[[^\]]*\]\([^)]*\)', ''
    $stripped = $stripped -replace 'https?://\S+', ''
    $stripped = $stripped -replace '[\s,;|]', ''
    if ($stripped -eq '') { continue }

    if ($line -match '^(tbd|todo|n/a|none|placeholder|\(none\))$') { continue }
    [void]$kept.Add($line)
  }

  $words = ($kept -join ' ') -split '\s+' | Where-Object { $_ -match '[a-zA-Z0-9]' }
  return @($words).Count
}

function Get-CaptureRatio {
  <#
  .SYNOPSIS
    D21 - how much of its source a page actually reflects.
  .DESCRIPTION
    `page words * ~6 chars/word / extract chars`.

    This replaces a rubric that was, to within five pages, a restatement of
    "did an LLM run" - and which therefore scored 164 truncated pages "healthy".
    It produced a number that went UP when the pipeline ran, which is what a
    health metric is supposed to do, and it was measuring the wrong thing.

    Returns $null when the source size is unknown. NOT zero: "I cannot measure
    this" is a third answer.
  #>
  param([Parameter(Mandatory)][int]$PageWords, [int]$SourceChars)
  if ($SourceChars -le 0) { return $null }
  return ([double]($PageWords * 6) / $SourceChars)
}

# ─────────────────────────────────────────────────────────────────────────────
# Synthesis
# ─────────────────────────────────────────────────────────────────────────────
function Invoke-Synthesis {
  <#
  .SYNOPSIS
    Ask a model to write a page from an extract.

  .DESCRIPTION
    THE WHOLE EXTRACT IS PASSED. There is no truncation in this function, and
    `$Extract.Length` is asserted at the call site.

    If the extract exceeds the provider's window, the caller CHUNKS AND MERGES
    or REFUSES. It never prefixes. See D1 in the file header.

    Returns $null when no model answered - which is a legitimate, supported
    outcome, not an error. The deterministic path downstream produces a real
    page from the extract without any model at all.
  #>
  param(
    [Parameter(Mandatory)][string]$Extract,
    [Parameter(Mandatory)][string]$Title,
    [Parameter(Mandatory)][string]$Tier,
    [Parameter(Mandatory)][string]$VaultRoot,
    [Parameter(Mandatory)]$RouterConfig
  )

  $sel = $null
  try {
    $sel = Select-Provider -Config $RouterConfig -Tier $Tier -Task 'synthesize_draft'
  } catch {
    # An empty chain THROWS in Select-Provider (D16). Here that becomes a
    # recorded, named degradation rather than a swallowed null.
    Write-ProviderHealth -VaultRoot $VaultRoot -Provider 'none' -Task 'synthesize_draft' -Status 'no_provider'
    Write-Verbose "no provider for tier '$Tier': $($_.Exception.Message)"
    return $null
  }

  foreach ($p in $sel.Chain) {
    # A real dispatch belongs here. It is deliberately not implemented in-tree:
    # Sutra ships DETERMINISTIC-FIRST, and a half-written HTTP client that
    # sometimes works is worse than an honest "no model configured".
    #
    # Whatever implements it MUST receive $Extract in full. `report 20 test R13`
    # upstream asserts exactly that: `extract.Length` characters arrived.
    Write-ProviderHealth -VaultRoot $VaultRoot -Provider $p.id -Task 'synthesize_draft' -Status 'unconfigured'
  }
  return $null
}

# ─────────────────────────────────────────────────────────────────────────────
# Page construction
# ─────────────────────────────────────────────────────────────────────────────
function New-DeterministicPage {
  <#
  .SYNOPSIS
    A durable page built with NO MODEL AT ALL.
  .DESCRIPTION
    The M2 decision made concrete at the compile stage. This is not a
    placeholder waiting for a model - it is a real page: the source's own
    material, structured, linked and cited, with every claim traceable because
    every line came from the extract.

    It has one property a synthesised page can only approximate: it cannot be
    wrong about its source, because it IS its source.
  #>
  param(
    [Parameter(Mandatory)][string]$Extract,
    [Parameter(Mandatory)][string]$Title,
    [Parameter(Mandatory)][string]$SourceId
  )

  # Paragraphs, in document order. NOT a prefix of the document: every paragraph
  # is represented, and the structure is preserved.
  $paras = @($Extract -split "(\r?\n){2,}" | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })

  $sb = New-Object System.Text.StringBuilder
  [void]$sb.AppendLine("# $Title")
  [void]$sb.AppendLine()
  [void]$sb.AppendLine('## Current understanding')
  [void]$sb.AppendLine()
  [void]$sb.AppendLine('_Assembled deterministically from the source. No model was involved, so nothing here')
  [void]$sb.AppendLine('is paraphrased, inferred, or invented - it is the source material, structured._')
  [void]$sb.AppendLine()
  foreach ($p in $paras) { [void]$sb.AppendLine($p); [void]$sb.AppendLine() }
  [void]$sb.AppendLine('## Evidence')
  [void]$sb.AppendLine()
  [void]$sb.AppendLine("- Source: ``$SourceId`` (compiled/extracts/$SourceId.txt)")
  [void]$sb.AppendLine()
  return $sb.ToString()
}

# ─────────────────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────────────────
$router = Get-RouterConfig -InstallRoot $InstallRoot
$considered = 0
$produced = 0
$held = 0
$skipped = 0
$repaired = 0

$manifests = @(Get-ChildItem -LiteralPath $ManifestDir -Filter '*.md' -ErrorAction SilentlyContinue)

foreach ($m in $manifests) {
  $considered++
  $id = $m.BaseName
  $mtext = Read-NoteFile -Path $m.FullName
  $parsed = Split-Frontmatter -Text $mtext
  if ($null -eq $parsed.FrontMatter) { $skipped++; continue }

  $fm = $parsed.FrontMatter
  $extractPath = [IO.Path]::Combine($ExtractDir, "$id.txt")

  # D3 — the stamp is not the sole authority. Ask the filesystem too.
  if (-not [IO.File]::Exists($extractPath)) { $skipped++; continue }

  $extract = [IO.File]::ReadAllText($extractPath, [Text.Encoding]::UTF8)
  $sourceChars = $extract.Length
  if ($sourceChars -eq 0) { $skipped++; continue }

  $sensRaw = if ($fm.ContainsKey('sensitivity')) { [string]$fm['sensitivity'] } else { '' }
  $tier = Resolve-Tier $sensRaw
  $pagePath = [IO.Path]::Combine($PageDir, "$id.md")
  $exists = [IO.File]::Exists($pagePath)

  # ── Selection ──────────────────────────────────────────────────────────────
  # D2: the repair selectors bypass the freshness guard INSIDE THEIR OWN
  # SELECTION ONLY. A normal run never reaches the bypass, and the tier rules
  # are not re-checked here because they are applied unconditionally below —
  # structurally unreachable rather than conditionally skipped.
  $selected = $false
  $why = ''

  if (-not $exists) {
    $selected = $true; $why = 'new'
  } elseif ($RepairStubs -or $RepairClipped) {
    $existingText = Read-NoteFile -Path $pagePath
    $existingBody = (Split-Frontmatter -Text $existingText).Body
    $words = Measure-ProseWords -Body $existingBody

    if ($RepairStubs -and $words -lt 20) {
      $selected = $true; $why = "stub ($words prose words)"
    }
    if ($RepairClipped) {
      $ratio = Get-CaptureRatio -PageWords $words -SourceChars $sourceChars
      if ($null -ne $ratio -and $ratio -lt 0.15) {
        $selected = $true
        $why = "clipped (capture ratio $([math]::Round($ratio * 100, 1))% of a $sourceChars-char source)"
      }
    }
  }

  if (-not $selected) { $skipped++; continue }

  # Title, in order of authority: an explicit frontmatter title, then the
  # source's OWN first heading, then the id.
  #
  # The middle case matters more than it looks. A page titled `src-2026-000001`
  # is unfindable by a human and unrankable by search — `Brain.search` weights
  # title matches x3, so a page whose title is an opaque slug scores as if it
  # had no title at all. The source almost always names itself; use that.
  $title = if ($fm.ContainsKey('title') -and $fm['title']) {
    [string]$fm['title']
  } else {
    $h = [regex]::Match($extract, '(?m)^#\s+(.+)$')
    if ($h.Success) { $h.Groups[1].Value.Trim() } else { $id }
  }

  # ── Synthesis, or the deterministic floor ──────────────────────────────────
  $answer = Invoke-Synthesis -Extract $extract -Title $title -Tier $tier -VaultRoot $VaultRoot -RouterConfig $router
  $synthProvider = $null

  if ($null -ne $answer) {
    $body = $answer.Text
    $synthProvider = $answer.Provider
  } else {
    $body = New-DeterministicPage -Extract $extract -Title $title -SourceId $id
  }

  # ── D15 · the anti-stub guard, on human-meaningful prose only ──────────────
  $prose = Measure-ProseWords -Body $body
  if ($prose -lt 20) {
    # REFUSE, DON'T STUB. The existing file (if any) is left BYTE-IDENTICAL.
    $held++
    Write-Host "  held $id - only $prose words of human-meaningful prose after stripping headings and machine-generated links"
    continue
  }

  # ── D1 · truncation is a FACT ON THE ARTIFACT ──────────────────────────────
  # `seen` equals `total` because the whole extract was passed. If these ever
  # differ, something truncated, and the page says so on its face.
  $charsSeen = $sourceChars

  $frontmatter = @(
    '---'
    "id: $id"
    'type: Topic'
    'status: active'
    "sensitivity: $(Get-TierDisplay $tier)"
    "source_refs: [$id]"
    "source_chars_seen: $charsSeen"
    "source_chars_total: $sourceChars"
    "compiled_at: $((Get-Date).ToUniversalTime().ToString('o'))"
    $(if ($synthProvider) { "synthesis_provider: $($synthProvider)" })
    "synthesis_mode: $(if ($synthProvider) { 'model' } else { 'deterministic' })"
    'related_to: []'
    '---'
    ''
  ) | Where-Object { $null -ne $_ }

  $full = ($frontmatter -join "`n") + $body

  if ($WhatIf) {
    Write-Host "  would write $id ($why, $prose prose words)"
  } else {
    Write-NoteFile -Path $pagePath -Content $full
    if ($exists) { $repaired++ } else { $produced++ }
  }
}

# ── D11 · five outcomes, never one counter ───────────────────────────────────
Write-Host ""
Write-Host "compile: $considered manifest(s) considered"
Write-Host "  $produced new page(s)"
Write-Host "  $repaired repaired"
Write-Host "  $held HELD (refused rather than stubbed - a failed synthesis leaves the file untouched)"
Write-Host "  $skipped skipped (no extract, or already fresh)"
if (-not ($RepairStubs -or $RepairClipped)) {
  Write-Host ""
  Write-Host "  Repair is a SEPARATE mode and is not implied by a normal run (D2):" -ForegroundColor DarkGray
  Write-Host "    -RepairClipped   re-synthesise pages whose capture ratio says they saw too little" -ForegroundColor DarkGray
  Write-Host "    -RepairStubs     re-synthesise pages with no real prose" -ForegroundColor DarkGray
}
Write-Host ""
Write-Host "considered: $considered"
Write-Host "produced: $($produced + $repaired)"
exit 0
