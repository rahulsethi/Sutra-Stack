# SPDX-License-Identifier: Apache-2.0
<#
.SYNOPSIS
  DIMAAG - frontmatter and note I/O. The pipeline's only reader and writer of a
  note's metadata block.

.DESCRIPTION
  Dependency-free, BOM-tolerant, UTF-8-no-BOM writes.

  D3 - THE KEY-SCOPED WRITE IS THE IMPORTANT PART OF THIS FILE.

  Upstream, a shared frontmatter helper re-serialised whole files on every
  stamp, and had already dirtied 660 manifests before anyone noticed. Round-
  tripping YAML through a parser reorders keys, changes quoting, and collapses
  blank lines - so a script whose job was to add ONE key rewrote the user's
  notes as a side effect.

  `Set-FrontmatterKey` below therefore edits ONE LINE and verifies every other
  byte is unchanged. Reformatting someone's notes is not an acceptable side
  effect of a metadata update.
#>

Set-StrictMode -Version Latest

function Read-NoteFile {
  <# .SYNOPSIS  Read a note, tolerating a UTF-8 BOM. #>
  param([Parameter(Mandatory)][string]$Path)
  $text = [IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8)
  if ($text.Length -gt 0 -and $text[0] -eq [char]0xFEFF) { $text = $text.Substring(1) }
  return $text
}

function Split-Frontmatter {
  <#
  .SYNOPSIS
    Split a note into its frontmatter map and body.
  .OUTPUTS
    @{ FrontMatter = <hashtable|$null>; Body = <string>; Raw = <string> }
  #>
  param([Parameter(Mandatory)][AllowEmptyString()][string]$Text)

  if ($Text.Length -gt 0 -and $Text[0] -eq [char]0xFEFF) { $Text = $Text.Substring(1) }
  $m = [regex]::Match($Text, '(?s)\A---\r?\n(.*?)\r?\n---\r?\n?(.*)\z')
  if (-not $m.Success) { return @{ FrontMatter = $null; Body = $Text; Raw = $Text } }

  $fmRaw = $m.Groups[1].Value
  $body  = $m.Groups[2].Value
  $fm = @{}
  $currentKey = $null

  foreach ($line in ($fmRaw -split "`n")) {
    $line = $line.TrimEnd("`r")
    if ($line -match '^\s*-\s+(.*)$' -and $currentKey) {
      $val = $Matches[1].Trim().Trim('"').Trim("'")
      if ($fm[$currentKey] -isnot [System.Collections.ArrayList]) { $fm[$currentKey] = [System.Collections.ArrayList]@() }
      [void]$fm[$currentKey].Add($val)
      continue
    }
    if ($line -match '^([A-Za-z0-9_]+):\s*(.*)$') {
      $key = $Matches[1]; $raw = $Matches[2].Trim(); $currentKey = $key
      if ($raw -eq '') { $fm[$key] = ''; continue }
      if ($raw -match '^\[(.*)\]$') {
        $items = @()
        foreach ($p in ($Matches[1] -split ',')) {
          $t = $p.Trim().Trim('"').Trim("'")
          if ($t -ne '') { $items += $t }
        }
        $fm[$key] = $items
        continue
      }
      $fm[$key] = $raw.Trim('"').Trim("'")
    }
  }
  foreach ($k in @($fm.Keys)) { if ($fm[$k] -is [System.Collections.ArrayList]) { $fm[$k] = @($fm[$k]) } }
  return @{ FrontMatter = $fm; Body = $body; Raw = $Text }
}

function Set-FrontmatterKey {
  <#
  .SYNOPSIS
    D3 - rewrite ONE frontmatter key, byte-for-byte otherwise.

  .DESCRIPTION
    Returns the new text, or $null if the key is absent or there is no
    frontmatter. REFUSING rather than inventing: a stamper that adds a key it
    did not find is a stamper that restructures files it did not understand.

  .PARAMETER Verify
    When set, the function asserts that the only difference between input and
    output is the one line. This is cheap and it is the actual guarantee.
  #>
  param(
    [Parameter(Mandatory)][string]$Text,
    [Parameter(Mandatory)][string]$Key,
    [Parameter(Mandatory)][AllowEmptyString()][string]$Value,
    [switch]$Verify
  )

  $m = [regex]::Match($Text, '(?s)\A(---\r?\n)(.*?)(\r?\n---\r?\n)')
  if (-not $m.Success) { return $null }

  $open = $m.Groups[1].Value
  $fm   = $m.Groups[2].Value
  $close = $m.Groups[3].Value
  $rest = $Text.Substring($m.Length)

  $pattern = "(?m)^($([regex]::Escape($Key))\s*:).*$"
  if (-not [regex]::IsMatch($fm, $pattern)) { return $null }

  $newFm = [regex]::Replace($fm, $pattern, "`${1} $Value")
  $result = $open + $newFm + $close + $rest

  if ($Verify) {
    $before = ($Text -split "`n")
    $after  = ($result -split "`n")
    if ($before.Count -ne $after.Count) { throw "Set-FrontmatterKey changed the line count - refusing" }
    $diffs = 0
    for ($i = 0; $i -lt $before.Count; $i++) { if ($before[$i] -ne $after[$i]) { $diffs++ } }
    if ($diffs -gt 1) { throw "Set-FrontmatterKey changed $diffs lines, expected exactly 1 - refusing" }
  }
  return $result
}

function Write-NoteFile {
  <# .SYNOPSIS  Write UTF-8 with NO BOM. A BOM breaks every downstream parser. #>
  param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][AllowEmptyString()][string]$Content)
  $dir = Split-Path -Parent $Path
  if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  $enc = New-Object System.Text.UTF8Encoding($false)
  [IO.File]::WriteAllText($Path, $Content, $enc)
}

function Get-Wikilink {
  <# .SYNOPSIS  Every [[wikilink]] target in a body. #>
  param([Parameter(Mandatory)][AllowEmptyString()][string]$Text)
  $out = @()
  foreach ($m in [regex]::Matches($Text, '\[\[([^\]\|#]+)(?:[\|#][^\]]*)?\]\]')) { $out += $m.Groups[1].Value.Trim() }
  return $out
}

function Join-VaultPath {
  <#
  .SYNOPSIS
    D26 - build every path through [IO.Path]::Combine.
  .DESCRIPTION
    `Join-Path $Root 'state\checks'` creates a directory LITERALLY NAMED
    'state\checks' on Linux, because a backslash is a legal filename character
    there. The bug is invisible on Windows and silent on Linux.
  #>
  param([Parameter(Mandatory)][string]$Root, [Parameter(Mandatory)][string[]]$Parts)
  $p = $Root
  foreach ($part in $Parts) {
    # `-split` takes a REGEX. The class must be '[\\/]' with TWO backslashes:
    # '[\/]' is an escaped forward slash and matches ONLY `/`, never `\`.
    #
    # This file shipped with the one-backslash version, and it was D26 exactly:
    # `Join-VaultPath '/tmp' 'state\checks'` produced `/tmp/state\checks` — a
    # single directory whose NAME contains a backslash. On Windows the test
    # passed, because [IO.Path]::Combine treats `\` as a separator there anyway,
    # so the wrong split produced the right answer. Only the Linux CI runner
    # could see it.
    #
    # "Invisible on Windows and silent on Linux" is D26's own description, and
    # it applied to the helper written to prevent D26.
    foreach ($seg in ($part -split '[\\/]')) {
      if ($seg -ne '') { $p = [IO.Path]::Combine($p, $seg) }
    }
  }
  return $p
}
