# SPDX-License-Identifier: Apache-2.0
# docstate-stamp.ps1 — portable: refresh the auto SYNC-STAMP block in Master_documentation/08-state/CURRENT-STATE.md.
#
# Part of the DG-doc-discipline reusable component. Project-agnostic: it discovers the CURRENT-STATE file
# under -Root, and stamps today's date + the repo HEAD + any submodule heads. Everything OUTSIDE the
# SYNC-STAMP markers (the human-written prose) is left untouched. Idempotent + offline-safe. Exits 0 always.
#
# Wire this into the project's Stop hook so the "where are we" stamp is never stale. Usage:
#   pwsh scripts/docstate-stamp.ps1 [-Root <repo-root>]

[CmdletBinding()]
param([string]$Root = (Split-Path -Parent $PSScriptRoot))

$ErrorActionPreference = 'SilentlyContinue'

$stateFile = Join-Path $Root 'Master_documentation/08-state/CURRENT-STATE.md'
if (-not (Test-Path $stateFile)) { exit 0 }

function Get-ShortHead {
  param([string]$Dir)
  if (-not (Test-Path $Dir)) { return $null }
  Push-Location $Dir
  try {
    $h = & git rev-parse --short HEAD 2>$null
    if ($LASTEXITCODE -eq 0 -and $h) { return $h.Trim() }
  } finally { Pop-Location }
  return $null
}

$today = Get-Date -Format 'yyyy-MM-dd'
$head  = Get-ShortHead -Dir $Root
if (-not $head) { $head = 'unknown' }

# Generic submodule heads (name @ short-sha), if any.
$subs = @()
Push-Location $Root
try {
  $ss = & git submodule status 2>$null
  if ($LASTEXITCODE -eq 0 -and $ss) {
    foreach ($line in $ss) {
      $t = $line.Trim()
      if ($t -match '^[+\- ]?([0-9a-f]+)\s+(\S+)') {
        $subs += "$($Matches[2]) ``$($Matches[1].Substring(0,[Math]::Min(7,$Matches[1].Length)))``"
      }
    }
  }
} finally { Pop-Location }
$subText = if ($subs.Count) { ' · submodules: ' + ($subs -join ', ') } else { '' }

$content = Get-Content -Raw -Path $stateFile
$startTag = '<!-- SYNC-STAMP:START (auto) -->'
$endTag   = '<!-- SYNC-STAMP:END -->'

# Preserve a session label if the prose carries one.
$session = 'current'
if ($content -match '(?i)session\s+(\d+)') { $session = "session $($Matches[1])" }

$block = @"
$startTag
- **Updated:** $today ($session)
- **Heads:** repo ``$head``$subText
$endTag
"@

# (?s) = singleline: '.' matches newlines so the block spans multiple lines.
$pattern = '(?s)' + [regex]::Escape($startTag) + '.*?' + [regex]::Escape($endTag)
if ($content -match $pattern) {
  $updated = [regex]::Replace($content, $pattern, [System.Text.RegularExpressions.MatchEvaluator]{ param($m) $block }, [System.Text.RegularExpressions.RegexOptions]::Singleline)
  if ($updated -ne $content) {
    Set-Content -Path $stateFile -Value $updated -NoNewline -Encoding utf8
    Write-Host "[docstate] refreshed SYNC-STAMP: $today repo=$head"
  }
}
exit 0
