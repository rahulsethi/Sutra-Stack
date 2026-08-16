# SPDX-License-Identifier: Apache-2.0
<#
.SYNOPSIS
  PUBLISH — generate `llms.txt` from PUBLIC-TIER notes only.

.DESCRIPTION
  `llms.txt` is the convention for telling a model what a site or a corpus
  contains. Here it is generated from the vault, and the generation is a gate
  decision before it is a formatting one.

  ══════════════════════════════════════════════════════════════════════════
  PUBLIC TIER ONLY, AND THE FILTER IS POSITIVE
  ══════════════════════════════════════════════════════════════════════════
  This file is, by definition, meant to be read by a model — often one the user
  has no relationship with. So it includes a note ONLY when that note is
  explicitly `public`, rather than excluding notes that are explicitly private.

  The difference matters and it is D14's lesson: a negative filter passes
  anything it does not recognise. An unlabelled note, a note whose frontmatter
  failed to parse, a note written by a future feature with a tier this script
  has never heard of — a negative filter lets all three through. A positive one
  lets none of them through.

  ══════════════════════════════════════════════════════════════════════════
  D14 · THE EXPORT ALLOW-LIST IS THE CONTROL, NOT GITIGNORE
  ══════════════════════════════════════════════════════════════════════════
  Upstream, nothing reached the public mirror only because the exporter HAPPENED
  not to copy `compiled/extracts/`. That was a lucky omission, not a control —
  and the thirteen credential-bearing sources were sitting in exactly that
  directory.

  So this script walks a NAMED list of directories and reads the tier of every
  note it finds. It never walks a tree and hopes.
#>

[CmdletBinding()]
param(
  [Parameter(Position = 0)][string]$VaultRoot,
  [string]$InstallRoot,
  [string]$OutFile,
  [string]$Title = 'Sutra vault'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $VaultRoot) { $VaultRoot = $env:SUTRA_VAULT }
if (-not $VaultRoot) { throw "no vault root. Pass it positionally or set SUTRA_VAULT." }

. "$PSScriptRoot/../lib/Frontmatter.ps1"
. "$PSScriptRoot/../lib/Tier.ps1"

if (-not $OutFile) { $OutFile = Join-VaultPath -Root $VaultRoot -Parts @('llms.txt') }

# THE ALLOW-LIST. Named directories, not a tree walk. `raw/` is absent
# deliberately: it is unclassified by definition, and it is where the upstream
# credentials lived.
$ExportRoots = @('vault', 'compiled/pages')
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

function Get-IndexSummary {
  <#
  .SYNOPSIS
    A one-line summary for an INDEX ENTRY. Not a synthesis input.

  .DESCRIPTION
    THIS IS NOT THE D1 CLIP, and the distinction is worth stating because the
    shapes are identical and the guard correctly flags it.

    D1 truncated a source on its way INTO A MODEL, and the resulting page then
    stood in for the whole source: confident, fluent, and wrong in specifics,
    with nothing on the artifact saying it had seen 38% of its material.

    This truncates a one-line summary on its way into an INDEX that links to the
    full note. Three properties make it safe where D1 was not:

      1. It is an ENTRY POINT, not a substitute - the link to the complete note
         is on the same line, and a reader (human or model) follows it.
      2. The truncation is VISIBLE: the ellipsis is appended, so nothing claims
         to be complete when it is not.
      3. Nothing is synthesised FROM it. No page is written from this string.

    If any of those three ever stops being true, this becomes D1 and must go.
  #>
  param([Parameter(Mandatory)][AllowEmptyString()][string]$Body)

  $summary = ''
  foreach ($line in ($Body -split "`n")) {
    $t = $line.Trim()
    if ($t -eq '' -or $t.StartsWith('#') -or $t.StartsWith('>') -or $t.StartsWith('|')) { continue }
    $summary = $t
    break
  }
  # Visible truncation: the ellipsis is the point.
  if ($summary.Length -gt 160) { $summary = $summary.Substring(0, 157) + '...' }
  return $summary
}

$included = New-Object System.Collections.ArrayList
$considered = 0
$withheld = @{ private = 0; secret = 0; do_not_learn = 0; unlabelled = 0 }

foreach ($rel in $ExportRoots) {
  $root = Join-VaultPath -Root $VaultRoot -Parts @($rel)
  foreach ($file in (Get-NoteFiles -Root $root)) {
    $considered++
    $parsed = Split-Frontmatter -Text (Read-NoteFile -Path $file)
    $fm = if ($null -ne $parsed.FrontMatter) { $parsed.FrontMatter } else { @{} }

    $dnlRaw = if ($fm.ContainsKey('do_not_learn')) { $fm['do_not_learn'] } else { $null }
    if (Test-DoNotLearn $dnlRaw) { $withheld.do_not_learn++; continue }

    # THE POSITIVE FILTER. A note is included only if it SAYS it is public.
    if (-not $fm.ContainsKey('sensitivity')) { $withheld.unlabelled++; continue }
    $tier = Resolve-Tier ([string]$fm['sensitivity'])
    if ($tier -ne 'hosted_allowed') {
      if ($tier -eq 'local_only') { $withheld.secret++ } else { $withheld.private++ }
      continue
    }

    $h = [regex]::Match($parsed.Body, '(?m)^#\s+(.+)$')
    $title = if ($h.Success) { $h.Groups[1].Value.Trim() } else { [IO.Path]::GetFileNameWithoutExtension($file) }

    $summary = Get-IndexSummary -Body $parsed.Body

    $relPath = $file.Substring($VaultRoot.Length).TrimStart([IO.Path]::DirectorySeparatorChar, '/') -replace '\\', '/'
    [void]$included.Add([pscustomobject]@{ Title = $title; Path = $relPath; Summary = $summary })
  }
}

$totalWithheld = $withheld.private + $withheld.secret + $withheld.do_not_learn + $withheld.unlabelled

$sb = New-Object System.Text.StringBuilder
[void]$sb.AppendLine("# $Title")
[void]$sb.AppendLine()
[void]$sb.AppendLine("> Generated by Sutra from PUBLIC-TIER notes only. $($included.Count) of $considered notes are listed.")
[void]$sb.AppendLine("> $totalWithheld were withheld: $($withheld.private) private, $($withheld.secret) secret, $($withheld.do_not_learn) do_not_learn, $($withheld.unlabelled) unlabelled.")
[void]$sb.AppendLine('>')
[void]$sb.AppendLine('> A note is listed only if it explicitly says `sensitivity: public`. Anything')
[void]$sb.AppendLine('> unlabelled, unparseable, or carrying a tier this generator does not recognise')
[void]$sb.AppendLine('> is withheld — a positive filter, so an unknown case is excluded rather than')
[void]$sb.AppendLine('> passed through.')
[void]$sb.AppendLine()

if ($included.Count -eq 0) {
  [void]$sb.AppendLine('## Nothing is public')
  [void]$sb.AppendLine()
  [void]$sb.AppendLine('No note in this vault is tagged `sensitivity: public`. That is the default state,')
  [void]$sb.AppendLine('and it is not an error.')
} else {
  [void]$sb.AppendLine('## Notes')
  [void]$sb.AppendLine()
  foreach ($n in ($included | Sort-Object Title)) {
    if ($n.Summary) {
      [void]$sb.AppendLine("- [$($n.Title)]($($n.Path)): $($n.Summary)")
    } else {
      [void]$sb.AppendLine("- [$($n.Title)]($($n.Path))")
    }
  }
}
[void]$sb.AppendLine()

Write-NoteFile -Path $OutFile -Content $sb.ToString()

Write-Host "publish: $($included.Count) public note(s) -> $OutFile"
Write-Host "  withheld: private $($withheld.private), secret $($withheld.secret), do_not_learn $($withheld.do_not_learn), unlabelled $($withheld.unlabelled)"
Write-Host ""
Write-Host "considered: $considered"
Write-Host "produced: $($included.Count)"
exit 0
