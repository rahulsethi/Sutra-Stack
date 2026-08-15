# SPDX-License-Identifier: Apache-2.0
<#
.SYNOPSIS
  REFRESH INDEX — cross-link, then build the embedding index.

.DESCRIPTION
  Stage four, and the 3-hourly job. Two things happen:

  1. CROSS-LINK. Notes that mention each other's titles get `[[wikilinks]]`, so
     the graph has edges to build from.

  2. EMBED. If `uv` is installed, the local embedding model runs and writes
     `state/index/embeddings.json`. If it is not, THAT IS A SUPPORTED STATE and
     this script says so and exits 0 - BM25 and keyword search do not need it.

  ── DEGRADATION IS ALLOWED; SILENT DEGRADATION IS NOT ──────────────────────
  A missing `uv` is reported by name, with the remedy, every run. It is not an
  error and it is not silence. The distinction matters because "no vector
  recall" is a thing a user should be able to notice and fix, and "no vector
  recall, reported as success" is how a capability quietly stops existing.

  ── D13 / I18 · cross-linking MUTATES notes, so it updates what it summarises ─
  Any pass that mutates an artifact updates every counter describing what it
  mutated. Cross-link writes into `related_to`, so it rewrites that key with the
  full set - it does not append and leave a stale count elsewhere.

  ── The write is KEY-SCOPED (D3) ───────────────────────────────────────────
  Only `related_to` changes. The rest of the user's note is byte-identical.
#>

[CmdletBinding()]
param(
  [Parameter(Position = 0)][string]$VaultRoot,
  [string]$InstallRoot,
  [switch]$SkipEmbed
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $VaultRoot) { $VaultRoot = $env:SUTRA_VAULT }
if (-not $VaultRoot) { throw "no vault root. Pass it positionally or set SUTRA_VAULT." }
if (-not $InstallRoot) { $InstallRoot = if ($env:SUTRA_HOME) { $env:SUTRA_HOME } else { (Resolve-Path "$PSScriptRoot/../..").Path } }

. "$PSScriptRoot/lib/Frontmatter.ps1"
. "$PSScriptRoot/lib/Tier.ps1"

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

$considered = $files.Count
$produced = 0

# ── 1 · cross-link ───────────────────────────────────────────────────────────
# Title -> relPath, for titles distinctive enough to be worth matching. A
# two-word title like "The Plan" would match half the corpus and produce a
# hairball, so short titles are excluded: a cross-link that connects everything
# to everything carries no information.
$titles = @{}
foreach ($f in $files) {
  $parsed = Split-Frontmatter -Text (Read-NoteFile -Path $f)
  $h = [regex]::Match($parsed.Body, '(?m)^#\s+(.+)$')
  $title = if ($h.Success) { $h.Groups[1].Value.Trim() } else { [IO.Path]::GetFileNameWithoutExtension($f) }
  if ($title.Length -lt 8) { continue }
  if (-not $titles.ContainsKey($title)) { $titles[$title] = $f }
}

foreach ($f in $files) {
  $text = Read-NoteFile -Path $f
  $parsed = Split-Frontmatter -Text $text
  if ($null -eq $parsed.FrontMatter) { continue }

  $body = $parsed.Body
  $existing = @(Get-Wikilink -Text $body)
  $found = New-Object System.Collections.ArrayList

  foreach ($t in $titles.Keys) {
    if ($titles[$t] -eq $f) { continue }                     # never link to yourself
    if ($existing -contains $t) { [void]$found.Add($t); continue }
    # Word-boundary match on the title, outside an existing wikilink.
    if ($body -match "(?<!\[\[)\b$([regex]::Escape($t))\b(?!\]\])") { [void]$found.Add($t) }
  }

  if ($found.Count -eq 0) { continue }
  $value = '[' + (($found | Sort-Object -Unique) -join ', ') + ']'

  # D3 - KEY-SCOPED. Only `related_to` changes.
  $new = Set-FrontmatterKey -Text $text -Key 'related_to' -Value $value -Verify
  if ($null -eq $new) { continue }   # no such key: refuse rather than restructure
  if ($new -ne $text) {
    Write-NoteFile -Path $f -Content $new
    $produced++
  }
}

Write-Host "cross-link: $produced note(s) updated across $considered"

# ── 2 · embed ────────────────────────────────────────────────────────────────
if ($SkipEmbed) {
  Write-Host "embed: skipped (-SkipEmbed)"
} else {
  $uv = Get-Command uv -ErrorAction SilentlyContinue
  $embedScript = Join-VaultPath -Root $InstallRoot -Parts @('automation', 'scripts', 'embed', 'embed.py')

  if (-not $uv) {
    # NAMED, with the remedy. Not an error, not silence.
    Write-Host ""
    Write-Host "  embed: SKIPPED - 'uv' is not installed on this node." -ForegroundColor Yellow
    Write-Host "    Vector recall is off. Keyword search, BM25, tiering, linking, the graph and" -ForegroundColor DarkGray
    Write-Host "    cited answers are ALL UNAFFECTED - this is a supported configuration." -ForegroundColor DarkGray
    Write-Host "    To enable it: https://docs.astral.sh/uv/" -ForegroundColor DarkGray
  } elseif (-not (Test-Path -LiteralPath $embedScript)) {
    Write-Host "  embed: SKIPPED - $embedScript is not present in this install." -ForegroundColor Yellow
  } else {
    Write-Host ""
    Write-Host "== embed =="
    & uv run --quiet $embedScript --vault $VaultRoot
    if ($LASTEXITCODE -ne 0) {
      # A FAILURE, not a skip (D11). The exit code says so.
      Write-Host "  embed: FAILED (exit $LASTEXITCODE)" -ForegroundColor Red
      Write-Host ""
      Write-Host "considered: $considered"
      Write-Host "produced: $produced"
      exit 1
    }
  }
}

Write-Host ""
Write-Host "considered: $considered"
Write-Host "produced: $produced"
exit 0
