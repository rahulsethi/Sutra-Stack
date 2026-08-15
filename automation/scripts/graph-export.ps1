# SPDX-License-Identifier: Apache-2.0
<#
.SYNOPSIS
  GRAPH EXPORT — build the cytoscape graph from wikilinks between visible notes.

.DESCRIPTION
  Stage three. A derived artifact: disposable, rebuildable, and carrying no
  history of its own (invariant 1).

  ══════════════════════════════════════════════════════════════════════════
  D18 · THE ANTI-REGRESSION GUARD LIVES INSIDE THE BUILDER
  ══════════════════════════════════════════════════════════════════════════
  Upstream, the caller pointed the builder at a directory THAT DOES NOT EXIST,
  so every run rebuilt from nothing. The knowledge graph froze for a week with a
  2-byte state file. The guard lived only in the CALLER - which is exactly how
  the earlier total loss happened.

  And the guard WORKED: it correctly rejected the empty result, every night,
  SILENTLY. A guard that fires constantly and says nothing is indistinguishable
  from a healthy system.

  So, here:
    * the guard is INSIDE this builder, not in whatever calls it;
    * a resolved input path that does not exist is a STARTUP ASSERTION, not a
      zero-result run;
    * a firing guard is an ALERT, counted and reported.

  ══════════════════════════════════════════════════════════════════════════
  D13 / I18 · THE HEADER MUST AGREE WITH THE BODY
  ══════════════════════════════════════════════════════════════════════════
  An enrichment pass upstream added edges and updated only its own three meta
  keys, leaving `meta.edge_count` at the pre-enrich value. Measured on the live
  export: header 16,291 vs `edges[]` 29,286 - 44% low.

  It hid because both numbers are individually plausible AND THE CHEAP READER IS
  THE ONE THAT IS WRONG: the metrics counter does a 2 KB head read, so the fix
  that finally made the graph observable inherited a lying header.

  Every counter here is COMPUTED AT WRITE TIME from the collection it
  summarises - never copied forward. `Test-GraphHeader` asserts it, and
  `sutra doctor` runs that assertion.

  ══════════════════════════════════════════════════════════════════════════
  D36 / I19 · THE INPUT STORE IS TRACKED
  ══════════════════════════════════════════════════════════════════════════
  This builder's inputs are the notes themselves, inside the user's vault repo.
  Nothing it reads is gitignored. If an artifact is a pure function of an input,
  THE INPUT IS THE THING YOU MUST NOT LOSE - committing only the output is a
  backup illusion, and it made the upstream graph permanently unreproducible off
  one laptop.
#>

[CmdletBinding()]
param(
  [Parameter(Position = 0)][string]$VaultRoot,
  [string]$InstallRoot,
  [switch]$Force,
  [double]$ShrinkTolerance = 0.10
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $VaultRoot) { $VaultRoot = $env:SUTRA_VAULT }
if (-not $VaultRoot) { throw "no vault root. Pass it positionally or set SUTRA_VAULT." }

. "$PSScriptRoot/lib/Frontmatter.ps1"
. "$PSScriptRoot/lib/Tier.ps1"

# ── D18 · resolved inputs are a STARTUP ASSERTION ────────────────────────────
# A builder pointed at a non-existent directory must FAIL, not produce zero.
$inputRoots = @(
  (Join-VaultPath -Root $VaultRoot -Parts @('vault')),
  (Join-VaultPath -Root $VaultRoot -Parts @('compiled', 'pages'))
)
$liveRoots = @($inputRoots | Where-Object { Test-Path -LiteralPath $_ })
if ($liveRoots.Count -eq 0) {
  throw "graph-export: NONE of its input directories exist: $($inputRoots -join ', '). Refusing to build from nothing - this is exactly how a graph gets silently rebuilt as empty, every night, for a week."
}

$OutPath = Join-VaultPath -Root $VaultRoot -Parts @('graph', 'exports', 'cytoscape.json')
$outDir = Split-Path -Parent $OutPath
if (-not (Test-Path -LiteralPath $outDir)) { New-Item -ItemType Directory -Path $outDir -Force | Out-Null }

# ── Walk ─────────────────────────────────────────────────────────────────────
# `config` is excluded for the same reason the retrieval layer excludes it:
# structure is not knowledge, and a template is not a node.
$ExcludedDirs = @('config', '.git', '.obsidian', '.trash', 'node_modules', '.sutra')

function Get-NoteFiles {
  param([Parameter(Mandatory)][string]$Root)
  $out = New-Object System.Collections.ArrayList
  $stack = New-Object System.Collections.Stack
  $stack.Push($Root)
  while ($stack.Count -gt 0) {
    $dir = $stack.Pop()
    foreach ($e in (Get-ChildItem -LiteralPath $dir -Force -ErrorAction SilentlyContinue)) {
      if ($e.PSIsContainer) {
        if ($ExcludedDirs -contains $e.Name) { continue }
        $stack.Push($e.FullName)
      } elseif ($e.Extension -eq '.md') {
        [void]$out.Add($e.FullName)
      }
    }
  }
  return @($out)
}

$nodes = New-Object System.Collections.ArrayList
$edges = New-Object System.Collections.ArrayList
$byTitle = @{}
$byId = @{}
$withheldDnl = 0

foreach ($root in $liveRoots) {
  foreach ($file in (Get-NoteFiles -Root $root)) {
    $text = Read-NoteFile -Path $file
    $parsed = Split-Frontmatter -Text $text
    $fm = if ($null -ne $parsed.FrontMatter) { $parsed.FrontMatter } else { @{} }

    # `do_not_learn` notes are not nodes AT ALL. A node carries a title and a
    # degree, and both are information about a note the user excluded.
    $dnlRaw = if ($fm.ContainsKey('do_not_learn')) { $fm['do_not_learn'] } else { $null }
    if (Test-DoNotLearn $dnlRaw) {
      $withheldDnl++
      continue
    }

    $rel = $file.Substring($VaultRoot.Length).TrimStart([IO.Path]::DirectorySeparatorChar, '/') -replace '\\', '/'
    $id = if ($fm.ContainsKey('id') -and $fm['id']) { [string]$fm['id'] } else { [IO.Path]::GetFileNameWithoutExtension($file) }
    $titleMatch = [regex]::Match($parsed.Body, '(?m)^#\s+(.+)$')
    $label = if ($titleMatch.Success) { $titleMatch.Groups[1].Value.Trim() }
             elseif ($fm.ContainsKey('title') -and $fm['title']) { [string]$fm['title'] }
             else { $id }

    # EVERY NODE CARRIES ITS TIER. The graph is gated at READ time by whoever
    # loads it, at their ceiling - so the artifact holds every tier and the
    # reader decides. That is why `mirror-export` copies named directories
    # rather than relying on this file being safe.
    $sensRaw = if ($fm.ContainsKey('sensitivity')) { [string]$fm['sensitivity'] } else { '' }
    $tier = Get-TierDisplay $sensRaw

    $node = @{
      data = @{
        id          = $id
        label       = $label
        path        = $rel
        type        = $(if ($fm.ContainsKey('type')) { [string]$fm['type'] } else { 'Untyped' })
        sensitivity = $tier
      }
    }
    [void]$nodes.Add($node)
    $byId[$id] = $id
    $byTitle[$label.ToLowerInvariant()] = $id
    $byTitle[[IO.Path]::GetFileNameWithoutExtension($file).ToLowerInvariant()] = $id
  }
}

# ── Edges from wikilinks ─────────────────────────────────────────────────────
$seenEdges = @{}
foreach ($root in $liveRoots) {
  foreach ($file in (Get-NoteFiles -Root $root)) {
    $text = Read-NoteFile -Path $file
    $parsed = Split-Frontmatter -Text $text
    $fm = if ($null -ne $parsed.FrontMatter) { $parsed.FrontMatter } else { @{} }
    $dnlRaw2 = if ($fm.ContainsKey('do_not_learn')) { $fm['do_not_learn'] } else { $null }
    if (Test-DoNotLearn $dnlRaw2) { continue }

    $sourceId = if ($fm.ContainsKey('id') -and $fm['id']) { [string]$fm['id'] } else { [IO.Path]::GetFileNameWithoutExtension($file) }

    foreach ($target in (Get-Wikilink -Text $parsed.Body)) {
      $key = $target.ToLowerInvariant()
      if (-not $byTitle.ContainsKey($key)) { continue }   # a link to a note that does not exist yet
      $targetId = $byTitle[$key]
      if ($targetId -eq $sourceId) { continue }           # self-links are not edges

      $edgeId = "$sourceId->$targetId"
      if ($seenEdges.ContainsKey($edgeId)) { continue }
      $seenEdges[$edgeId] = $true
      [void]$edges.Add(@{ data = @{ id = $edgeId; source = $sourceId; target = $targetId; kind = 'wikilink' } })
    }
  }
}

# ── D18 · the anti-regression guard, INSIDE the builder ──────────────────────
$existing = $null
if ([IO.File]::Exists($OutPath)) {
  try { $existing = [IO.File]::ReadAllText($OutPath) | ConvertFrom-Json } catch { $existing = $null }
}

$guardFired = $false
if ($nodes.Count -eq 0) {
  Write-Host ""
  Write-Host "  REFUSING to write a graph with 0 nodes." -ForegroundColor Red
  Write-Host "  A builder pointed at an empty or wrong input directory produces exactly this," -ForegroundColor DarkGray
  Write-Host "  and the existing artifact is the only copy. It has NOT been touched." -ForegroundColor DarkGray
  Write-Host ""
  Write-Host "considered: 0"
  Write-Host "produced: 0"
  exit 1
}

if ($null -ne $existing -and $null -ne $existing.nodes) {
  $prev = @($existing.nodes).Count
  if ($prev -gt 0) {
    $shrink = [double]($prev - $nodes.Count) / $prev
    if ($shrink -gt $ShrinkTolerance -and -not $Force) {
      $guardFired = $true
      Write-Host ""
      Write-Host "  REFUSING to replace a $prev-node graph with a $($nodes.Count)-node one" -ForegroundColor Red
      Write-Host "  ($([math]::Round($shrink * 100, 1))% smaller; tolerance $([math]::Round($ShrinkTolerance * 100))%)." -ForegroundColor Red
      Write-Host ""
      Write-Host "  The existing artifact is untouched. Re-run with -Force if the shrink is real." -ForegroundColor DarkGray
      Write-Host "  This guard fired - which is an ALERT, not a quiet success. A guard that fires" -ForegroundColor DarkGray
      Write-Host "  every night and says nothing is indistinguishable from a healthy system (D18)." -ForegroundColor DarkGray
      Write-Host ""
      Write-Host "considered: $($nodes.Count)"
      Write-Host "produced: 0"
      exit 1
    }
    if ($shrink -gt 0 -and $Force) {
      $guardFired = $true
      Write-Host "  guard OVERRIDDEN by -Force: $prev -> $($nodes.Count) nodes" -ForegroundColor Yellow
    }
  }
}

# ── D13 / I18 · every counter computed AT WRITE TIME ─────────────────────────
# Not copied forward from a previous run, not updated by a later pass. The
# collection is measured here, once, as it is written.
$graph = [ordered]@{
  meta = [ordered]@{
    node_count      = $nodes.Count        # == @(nodes).Count, by construction
    edge_count      = $edges.Count        # == @(edges).Count, by construction
    community_count = 0                   # set by the enrichment pass, WHICH MUST UPDATE IT
    built_at        = (Get-Date).ToUniversalTime().ToString('o')
    builder         = 'graph-export.ps1'
    enriched        = $false
  }
  nodes = @($nodes)
  edges = @($edges)
}

$json = $graph | ConvertTo-Json -Depth 8
Write-NoteFile -Path $OutPath -Content ($json + "`n")

# ── Verify what we just wrote. The assertion is cheap; the trap is expensive. ──
$check = [IO.File]::ReadAllText($OutPath) | ConvertFrom-Json
$headerProblems = @()
if ($check.meta.node_count -ne @($check.nodes).Count) { $headerProblems += "node_count $($check.meta.node_count) vs $(@($check.nodes).Count)" }
if ($check.meta.edge_count -ne @($check.edges).Count) { $headerProblems += "edge_count $($check.meta.edge_count) vs $(@($check.edges).Count)" }
if ($headerProblems.Count -gt 0) {
  throw "graph-export wrote a header that disagrees with its body (I18): $($headerProblems -join '; ')"
}

Write-Host ""
Write-Host "graph: $($nodes.Count) nodes, $($edges.Count) edges -> $OutPath"
if ($withheldDnl -gt 0) { Write-Host "  $withheldDnl note(s) excluded as do_not_learn - not nodes at all" }
if ($guardFired) { Write-Host "  NOTE: the anti-regression guard fired this run" -ForegroundColor Yellow }
Write-Host "  header verified against body (I18)"
Write-Host ""
Write-Host "considered: $($nodes.Count)"
Write-Host "produced: $($edges.Count)"
exit 0
