# SPDX-License-Identifier: Apache-2.0
<#
.SYNOPSIS
  D3 · `pipeline/stamp-reconcile` — the key-scoped write.

.DESCRIPTION
  The defect: a shared frontmatter helper re-serialised whole files on every
  stamp and had already dirtied 660 manifests before anyone noticed. A script
  whose job was to add ONE key rewrote the user's notes as a side effect.

  So the guarantee is narrow and testable: exactly one line changes, and every
  other byte is identical. These tests assert the refusals too, because a
  stamper that INVENTS a key it did not find is a stamper that restructures
  files it did not understand.

  Also D26: a backslash is a legal filename character on Linux, so
  `Join-Path $Root 'state\checks'` silently creates a directory literally named
  `state\checks` there. Invisible on Windows.
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. "$PSScriptRoot/Frontmatter.ps1"

$pass = 0
$fail = 0
function It {
  param([Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][scriptblock]$Body)
  try { & $Body; $script:pass++; Write-Host "  ok   $Name" -ForegroundColor DarkGreen }
  catch { $script:fail++; Write-Host "  FAIL $Name`n       $($_.Exception.Message)" -ForegroundColor Red }
}
function Assert-True { param([bool]$C, [string]$B = '') if (-not $C) { throw "expected true. $B" } }
function Assert-Equal { param($E, $A, [string]$B = '') if ($E -ne $A) { throw "expected '$E', got '$A'. $B" } }

$nl = [char]10
$note = "---${nl}type: Note${nl}sensitivity: public${nl}tags: [a, b]${nl}related_to:${nl}  - '[[x]]'${nl}---${nl}${nl}# Title${nl}${nl}Body with `$dollar, 'quotes' and  double  spaces.${nl}"

Write-Host "`nFrontmatter.ps1 - D3 key-scoped writes" -ForegroundColor Cyan

It "rewrites exactly the requested key" {
  $r = Set-FrontmatterKey -Text $note -Key 'sensitivity' -Value 'secret' -Verify
  Assert-True ($r -match 'sensitivity: secret') "the key was not rewritten"
}

It "leaves EVERY other byte identical" {
  $r = Set-FrontmatterKey -Text $note -Key 'sensitivity' -Value 'secret' -Verify
  $before = $note -split $nl
  $after  = $r -split $nl
  Assert-Equal $before.Count $after.Count "the line count changed"
  $diffs = 0
  for ($i = 0; $i -lt $before.Count; $i++) { if ($before[$i] -ne $after[$i]) { $diffs++ } }
  Assert-Equal 1 $diffs "changed $diffs lines - exactly 1 is the guarantee"
}

It "does not touch quoting, spacing, arrays or the body" {
  $r = Set-FrontmatterKey -Text $note -Key 'sensitivity' -Value 'secret' -Verify
  Assert-True ($r -match [regex]::Escape('tags: [a, b]'))        "an inline array was reformatted"
  Assert-True ($r -match [regex]::Escape("  - '[[x]]'"))         "a block list item was reformatted"
  Assert-True ($r -match [regex]::Escape('double  spaces'))      "body whitespace was collapsed"
  Assert-True ($r -match [regex]::Escape("'quotes'"))            "body quoting changed"
}

It "REFUSES a key that is not present - it does not invent one" {
  Assert-Equal $null (Set-FrontmatterKey -Text $note -Key 'nosuchkey' -Value 'x')
}

It "REFUSES a note with no frontmatter" {
  Assert-Equal $null (Set-FrontmatterKey -Text 'plain body, no frontmatter' -Key 'sensitivity' -Value 'x')
}

It "-Verify throws rather than writing a multi-line change" {
  # The guarantee has to be enforced, not merely intended.
  $threw = $false
  try {
    # A value containing a newline would inject a second line.
    Set-FrontmatterKey -Text $note -Key 'sensitivity' -Value "secret${nl}injected: true" -Verify | Out-Null
  } catch { $threw = $true }
  Assert-True $threw "a value containing a newline must be refused by -Verify"
}

Write-Host "`nSplit-Frontmatter" -ForegroundColor Cyan

It "parses keys, inline arrays and block lists" {
  $p = Split-Frontmatter -Text $note
  Assert-Equal 'Note'   $p.FrontMatter['type']
  Assert-Equal 'public' $p.FrontMatter['sensitivity']
  Assert-Equal 2        @($p.FrontMatter['tags']).Count
  Assert-True  ($p.Body -match '# Title') "the body was not returned"
}

It "tolerates a UTF-8 BOM" {
  $bom = [char]0xFEFF
  $p = Split-Frontmatter -Text "$bom$note"
  Assert-Equal 'Note' $p.FrontMatter['type']
}

It "a note with no frontmatter yields a null map, not an exception" {
  $p = Split-Frontmatter -Text 'just a body'
  Assert-Equal $null $p.FrontMatter
  Assert-Equal 'just a body' $p.Body
}

Write-Host "`nD26 - path building" -ForegroundColor Cyan

It "a backslash in a path part yields SEPARATE segments, not one directory" {
  # The property, stated platform-independently: 'state\checks' must become TWO
  # path segments. Asserting "the string does not contain a backslash" would
  # pass vacuously on Windows, where `\` IS the separator and the correct output
  # is character-identical to the bug — which is exactly why this defect was
  # invisible on Windows and silent on Linux.
  $sep = [IO.Path]::DirectorySeparatorChar
  $p = Join-VaultPath -Root ([IO.Path]::GetTempPath()) -Parts @('state\checks', 'last-run.json')
  $tail = $p.Substring(([IO.Path]::GetTempPath()).TrimEnd($sep).Length).Trim($sep)
  $segs = @($tail -split [regex]::Escape($sep) | Where-Object { $_ -ne '' })
  Assert-Equal 3 $segs.Count "expected state / checks / last-run.json as 3 segments, got: $($segs -join ' | ')"
  Assert-Equal 'state'          $segs[0]
  Assert-Equal 'checks'         $segs[1]
  Assert-Equal 'last-run.json'  $segs[2]
}

It "forward slashes produce the identical result" {
  # The two forms must be indistinguishable after joining, or a config written
  # on one OS resolves differently on the other (§9.6).
  $a = Join-VaultPath -Root ([IO.Path]::GetTempPath()) -Parts @('state\checks', 'x.json')
  $b = Join-VaultPath -Root ([IO.Path]::GetTempPath()) -Parts @('state/checks', 'x.json')
  Assert-Equal $a $b "the same logical path built two ways must be byte-identical"
}

Write-Host ""
if ($fail -gt 0) { Write-Host "$fail failed, $pass passed" -ForegroundColor Red; exit 1 }
Write-Host "$pass passed" -ForegroundColor Green
exit 0
