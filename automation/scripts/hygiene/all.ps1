# SPDX-License-Identifier: Apache-2.0
<#
.SYNOPSIS
  HYGIENE — the checks that keep a corpus from rotting quietly.

.DESCRIPTION
  Reports; it does not mutate. Every finding names a file and a remedy.

  ══════════════════════════════════════════════════════════════════════════
  D22 · A REVIEW QUEUE THAT IS 97% MACHINE ARTIFACTS IS NOT A REVIEW QUEUE
  ══════════════════════════════════════════════════════════════════════════
  Of 1,972 open items upstream, 1,919 (97.3%) were near-duplicate artifacts
  between opaque `src-2026-NNNNNN` slugs - INCLUDING page-versus-its-own-extract
  pairs, which are structural, not duplicates. The operator review was faithfully
  reporting garbage, and the output looked plausible enough that the queue
  appeared to be in use.

  So, here:
    * STRUCTURAL PAIRS ARE EXCLUDED from the duplicate detector by construction
      (a page and the extract it was written from are not duplicates of each
      other, and never were);
    * NO SINGLE CATEGORY MAY EXCEED A SHARE of the rendered surface;
    * DECISION-BEARING items lead, with a bounded sample of the rest.

  A review surface nobody can act on is not a review surface - it is a place
  findings go to be ignored.

  ══════════════════════════════════════════════════════════════════════════
  INVARIANT 7 · REVERSIBLE-AUTO
  ══════════════════════════════════════════════════════════════════════════
  Nothing here deletes. If a future check removes something, removal is a MOVE
  TO QUARANTINE, never a hard delete - which is what makes it safe for
  maintenance to act without asking.
#>

[CmdletBinding()]
param(
  [Parameter(Position = 0)][string]$VaultRoot,
  [string]$InstallRoot,
  [int]$MaxPerCategory = 12,
  [int]$StaleDays = 180
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $VaultRoot) { $VaultRoot = $env:SUTRA_VAULT }
if (-not $VaultRoot) { throw "no vault root. Pass it positionally or set SUTRA_VAULT." }

. "$PSScriptRoot/../lib/Frontmatter.ps1"
. "$PSScriptRoot/../lib/Tier.ps1"

$ExcludedDirs = @('config', '.git', '.obsidian', '.trash', 'node_modules', '.sutra')

function Get-NoteFiles {
  param([Parameter(Mandatory)][string]$Root)
  $out = New-Object System.Collections.ArrayList
  if (-not (Test-Path -LiteralPath $Root)) { return @() }
  $stack = New-Object System.Collections.Stack
  $stack.Push($Root)
  while ($stack.Count -gt 0) {
    $dir = $stack.Pop()
    foreach ($e in (Get-ChildItem -LiteralPath $dir -Force -ErrorAction SilentlyContinue)) {
      if ($e.PSIsContainer) {
        if ($ExcludedDirs -contains $e.Name) { continue }
        $stack.Push($e.FullName)
      } elseif ($e.Extension -eq '.md') { [void]$out.Add($e.FullName) }
    }
  }
  return @($out)
}

$roots = @(
  (Join-VaultPath -Root $VaultRoot -Parts @('vault')),
  (Join-VaultPath -Root $VaultRoot -Parts @('compiled', 'pages'))
) | Where-Object { Test-Path -LiteralPath $_ }

$files = @()
foreach ($r in $roots) { $files += Get-NoteFiles -Root $r }

$notes = @()
$titles = @{}
foreach ($f in $files) {
  $text = Read-NoteFile -Path $f
  $parsed = Split-Frontmatter -Text $text
  $fm = if ($null -ne $parsed.FrontMatter) { $parsed.FrontMatter } else { @{} }
  $h = [regex]::Match($parsed.Body, '(?m)^#\s+(.+)$')
  $rel = $f.Substring($VaultRoot.Length).TrimStart([IO.Path]::DirectorySeparatorChar, '/') -replace '\\', '/'
  $id = if ($fm.ContainsKey('id') -and $fm['id']) { [string]$fm['id'] } else { [IO.Path]::GetFileNameWithoutExtension($f) }
  $title = if ($h.Success) { $h.Groups[1].Value.Trim() } else { [IO.Path]::GetFileNameWithoutExtension($f) }

  $notes += [pscustomobject]@{
    Path = $f; Rel = $rel; Id = $id; Title = $title
    Body = $parsed.Body; Fm = $fm
    Modified = (Get-Item -LiteralPath $f).LastWriteTime
  }
  if (-not $titles.ContainsKey($title.ToLowerInvariant())) { $titles[$title.ToLowerInvariant()] = @() }
  $titles[$title.ToLowerInvariant()] += $rel
}

# ─────────────────────────────────────────────────────────────────────────────
# The categories. Each is DECISION-BEARING or it does not belong here.
# ─────────────────────────────────────────────────────────────────────────────
$findings = @{}
function Add-Finding {
  param([string]$Category, [string]$Item, [string]$Remedy)
  if (-not $findings.ContainsKey($Category)) { $findings[$Category] = New-Object System.Collections.ArrayList }
  [void]$findings[$Category].Add([pscustomobject]@{ Item = $Item; Remedy = $Remedy })
}

# ── Broken wikilinks ─────────────────────────────────────────────────────────
# Decision-bearing: either the target should exist, or the link is wrong.
$known = @{}
foreach ($n in $notes) {
  $known[$n.Title.ToLowerInvariant()] = $true
  $known[[IO.Path]::GetFileNameWithoutExtension($n.Path).ToLowerInvariant()] = $true
  $known[$n.Id.ToLowerInvariant()] = $true
}
foreach ($n in $notes) {
  foreach ($link in (Get-Wikilink -Text $n.Body)) {
    if (-not $known.ContainsKey($link.ToLowerInvariant())) {
      Add-Finding 'broken-link' "$($n.Rel) -> [[$link]]" 'create the target, or fix the link text'
    }
  }
}

# ── Duplicate titles ─────────────────────────────────────────────────────────
# D22 - STRUCTURAL PAIRS ARE EXCLUDED BY CONSTRUCTION. A compiled page and the
# manifest it came from share an id and a title BY DESIGN; reporting them as
# duplicates is exactly the noise that made the upstream queue 97% unusable.
foreach ($t in $titles.Keys) {
  $paths = @($titles[$t])
  if ($paths.Count -lt 2) { continue }
  $structural = @($paths | Where-Object { $_ -like 'compiled/*' }).Count -gt 0 -and
                @($paths | Where-Object { $_ -like 'raw/*' }).Count -gt 0
  if ($structural) { continue }
  # Two compiled pages of the same source are also structural.
  $roots = @($paths | ForEach-Object { ($_ -split '/')[0] } | Sort-Object -Unique)
  if ($roots.Count -gt 1 -and ($roots -contains 'compiled')) { continue }
  Add-Finding 'duplicate-title' "'$t' -> $($paths -join ', ')" 'merge them, or retitle one'
}

# ── Untiered notes ───────────────────────────────────────────────────────────
# Decision-bearing, and the highest-value category here: these default to
# private, which is safe, but the user has not actually decided.
foreach ($n in $notes) {
  if (-not $n.Fm.ContainsKey('sensitivity') -or [string]::IsNullOrWhiteSpace([string]$n.Fm['sensitivity'])) {
    Add-Finding 'untiered' $n.Rel 'add `sensitivity:` — it defaults to private, which is safe but undecided'
  }
}

# ── Stale ────────────────────────────────────────────────────────────────────
$cutoff = (Get-Date).AddDays(-$StaleDays)
foreach ($n in $notes) {
  if ($n.Modified -lt $cutoff -and $n.Rel -notlike 'vault/08-daily/*' -and $n.Rel -notlike 'vault/09-reviews/*') {
    Add-Finding 'stale' "$($n.Rel) (last touched $($n.Modified.ToString('yyyy-MM-dd')))" 'review, archive, or leave deliberately'
  }
}

# ── Orphans ──────────────────────────────────────────────────────────────────
$linkedTo = @{}
foreach ($n in $notes) {
  foreach ($link in (Get-Wikilink -Text $n.Body)) { $linkedTo[$link.ToLowerInvariant()] = $true }
}
foreach ($n in $notes) {
  if ($n.Rel -like 'vault/00-inbox/*') { continue }   # an inbox item is expected to be unlinked
  $hasIn = $linkedTo.ContainsKey($n.Title.ToLowerInvariant())
  $hasOut = @(Get-Wikilink -Text $n.Body).Count -gt 0
  if (-not $hasIn -and -not $hasOut) {
    Add-Finding 'orphan' $n.Rel 'link it to something, or accept it as standalone'
  }
}

# ─────────────────────────────────────────────────────────────────────────────
# Render. D22: decision-bearing first, each category CAPPED.
# ─────────────────────────────────────────────────────────────────────────────
$priority = @('untiered', 'broken-link', 'duplicate-title', 'orphan', 'stale')
$total = 0
foreach ($k in $findings.Keys) { $total += $findings[$k].Count }

Write-Host ""
Write-Host "hygiene: $($notes.Count) note(s) checked, $total finding(s)"

foreach ($cat in $priority) {
  if (-not $findings.ContainsKey($cat)) { continue }
  $items = @($findings[$cat])
  Write-Host ""
  Write-Host "  $cat ($($items.Count))"
  foreach ($i in ($items | Select-Object -First $MaxPerCategory)) {
    Write-Host "    - $($i.Item)"
  }
  if ($items.Count -gt $MaxPerCategory) {
    # A BOUNDED SAMPLE, and it says so. Rendering 1,919 near-dups is how a
    # review surface becomes something nobody reads.
    Write-Host "    ... and $($items.Count - $MaxPerCategory) more (capped so this stays readable - D22)"
  }
  Write-Host "    remedy: $($items[0].Remedy)"
}

if ($total -eq 0) { Write-Host "  clean" }

Write-Host ""
Write-Host "considered: $($notes.Count)"
Write-Host "produced: $total"
exit 0
