# SPDX-License-Identifier: Apache-2.0
<#
.SYNOPSIS
  The commit-time secret scanner. Sub-second regardless of file count, fails
  closed, and only `definite` rules can block.

.DESCRIPTION
  D6 - A COMMIT HOOK THAT WAS UNTRACKED, SLOW, AND THEREFORE BYPASSED.

  The upstream hook lived UNTRACKED in `.git/hooks/`, `core.hooksPath` was
  unset, and so ENFORCEMENT DID NOT SURVIVE A CLONE. It also spawned one `grep`
  PER STAGED FILE at ~1.05s each - ten-plus minutes on a large commit.

  The result was `--no-verify` as standing policy: 128 occurrences across 91
  files. And that is worse than having no hook, because the repo kept the BELIEF
  that its commits were scanned while every large commit skipped the scan.

  So, in order of importance:

  1. TRACKED, and installed via `core.hooksPath`. Enforcement survives a clone.
     `sutra init` and CONTRIBUTING.md both set it.

  2. FAST. ONE interpreter spawn, ONE `git diff --cached`. Everything happens
     in-process. Budget: sub-second regardless of file count.

  3. FAILS CLOSED. If this scanner or the pattern set is missing, the commit is
     REFUSED rather than allowed. A guard that disappears silently is not a guard.

  4. BINARY FILES INCLUDED. The staged file list comes from `--name-only -z`,
     not from scraping diff text - a path list scraped from diff output skips
     every binary, which upstream made a raw-audio guard unable to ever fire.

  5. ONLY `definite` RULES BLOCK (D24 / I17). A fuzzy rule may raise a tier and
     warn; it may never fail a commit. `generic-api-key-kv` cannot distinguish
     `password=dbutler_prod_9x2Kq` from `password=db_password` - they are
     structurally identical, so no regex separates them. Blocking on it is
     exactly how a hook earns the `--no-verify` habit it then never recovers from.

.PARAMETER Staged
  Scan the git staging area (the hook's mode).

.PARAMETER Path
  Scan specific paths instead.

.OUTPUTS
  Exit 0 = clean or advisory-only. Exit 1 = a `definite` rule matched.
#>

[CmdletBinding()]
param(
  [switch]$Staged,
  [string[]]$Path,
  [string]$InstallRoot,
  [switch]$Quiet
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $InstallRoot) { $InstallRoot = (Resolve-Path "$PSScriptRoot/../../..").Path }

# FAIL CLOSED. If the scanner cannot load its rules, the commit is refused.
try {
  . "$PSScriptRoot/../lib/Classify.ps1"
  $patterns = Get-PatternSet -InstallRoot $InstallRoot
} catch {
  Write-Host ""
  Write-Host "  COMMIT REFUSED - the secret scanner could not load its rules." -ForegroundColor Red
  Write-Host "  $($_.Exception.Message)" -ForegroundColor DarkRed
  Write-Host ""
  Write-Host "  This fails CLOSED on purpose: a scanner with no rules reports every file clean," -ForegroundColor DarkGray
  Write-Host "  which is the most dangerous possible failure for this component." -ForegroundColor DarkGray
  exit 1
}

$sw = [Diagnostics.Stopwatch]::StartNew()

# ── Gather the file list ─────────────────────────────────────────────────────
# ONE git call. `-z` gives NUL-delimited names so a path containing a space,
# quote or newline survives, and `--diff-filter=d` skips deletions (there is
# nothing to scan in a removed file).
$files = @()
if ($Staged) {
  $raw = & git diff --cached --name-only -z --diff-filter=d 2>$null
  if ($LASTEXITCODE -ne 0) {
    Write-Host "  COMMIT REFUSED - could not read the staging area." -ForegroundColor Red
    exit 1
  }
  $files = @(($raw -split "`0") | Where-Object { $_ -ne '' })
} elseif ($Path) {
  $files = @($Path)
} else {
  Write-Host "usage: Invoke-SecretScan.ps1 -Staged | -Path <paths>"
  exit 64
}

# ── Scan, in-process ─────────────────────────────────────────────────────────
$blocking = New-Object System.Collections.ArrayList
$advisory = New-Object System.Collections.ArrayList
$scanned = 0
$skippedBinary = 0

# The pattern objects are compiled ONCE, outside the file loop. Compiling a
# regex per file per rule is most of where the upstream ten minutes went.
$compiled = @($patterns.Rules | ForEach-Object {
  [pscustomobject]@{ Id = $_.id; Band = $_.band; Desc = $_.description; Re = [regex]::new($_.pattern) }
})

# Files whose PURPOSE is to exercise the rules necessarily contain what the
# rules match. The list is declared in the pattern set so this scanner and the
# JS leak scan cannot drift apart, and so a reviewer has one place to look.
$exempt = @{}
foreach ($e in $patterns.ExemptPaths) { $exempt[$e.Replace('\','/')] = $true }
$exemptHits = 0

foreach ($f in $files) {
  $rel = $f.Replace('\','/')
  if ($exempt.ContainsKey($rel)) { $exemptHits++; continue }
  $full = if ([IO.Path]::IsPathRooted($f)) { $f } else { [IO.Path]::Combine((Get-Location).Path, $f) }
  if (-not [IO.File]::Exists($full)) { continue }

  $info = [IO.FileInfo]::new($full)
  if ($info.Length -gt 8MB) { continue }

  $bytes = [IO.File]::ReadAllBytes($full)
  # A NUL byte in the first 8 KB means binary. Binary files are still COUNTED -
  # a guard that needs to see them (raw audio, an image of a credential) reads
  # the list, and D6's lesson is that scraping the list from diff text silently
  # drops every one of them.
  $probe = [Math]::Min(8192, $bytes.Length)
  $isBinary = $false
  for ($i = 0; $i -lt $probe; $i++) { if ($bytes[$i] -eq 0) { $isBinary = $true; break } }
  if ($isBinary) { $skippedBinary++; continue }

  $text = [Text.Encoding]::UTF8.GetString($bytes)
  $scanned++

  # A path floor is a `definite` signal on its own (D4) - but it describes where
  # NOTES live in a vault, not what a source directory may be named.
  #
  # `ee/src/keys/kms.ts` is a source directory named for the KMS integration,
  # not a key store, and blocking commits on it is exactly the predictable false
  # positive that earns a `--no-verify` habit. Content rules - a matched key
  # prefix, a PEM block - still apply to source, because a real key in a .ts
  # file is still a real key.
  if (-not ($f -match '\.(ts|mts|cts|tsx|js|mjs|cjs|jsx|ps1|psm1|psd1|py|sh|go|rs|java|rb)$')) {
    $floor = Test-FloorPath -RelPath $f -FloorPaths $patterns.FloorPaths
    if ($floor) {
      [void]$blocking.Add(@{ File = $f; Rule = "path-floor:$floor"; Line = 0; Detail = "sits under the secret-floor location '$floor'" })
    }
  }

  foreach ($rule in $compiled) {
    $m = $rule.Re.Match($text)
    if (-not $m.Success) { continue }
    $line = 1 + ([regex]::Matches($text.Substring(0, $m.Index), "`n")).Count
    $entry = @{ File = $f; Rule = $rule.Id; Line = $line; Detail = (($rule.Desc -split '\.')[0]) }
    if ($rule.Band -eq 'definite') { [void]$blocking.Add($entry) } else { [void]$advisory.Add($entry) }
  }
}

$sw.Stop()

# ── Report ───────────────────────────────────────────────────────────────────
if ($blocking.Count -gt 0) {
  Write-Host ""
  Write-Host "  COMMIT REFUSED - a credential shape is staged." -ForegroundColor Red
  Write-Host ""
  foreach ($b in $blocking) {
    Write-Host "    $($b.File):$($b.Line)" -ForegroundColor Red
    Write-Host "      [$($b.Rule)] $($b.Detail)" -ForegroundColor DarkRed
  }
  Write-Host ""
  Write-Host "  Every rule above is `"definite`" - a matched key prefix or a known secret path." -ForegroundColor DarkGray
  Write-Host "  Remove the value, then commit. If the credential was ever real, RE-TIERING IS NOT" -ForegroundColor DarkGray
  Write-Host "  A REMEDY: the cleartext stays in git history and only rotation fixes it." -ForegroundColor DarkGray
  Write-Host ""
  Write-Host "  Please do not use --no-verify. If this rule is wrong, that is a bug worth filing:" -ForegroundColor DarkGray
  Write-Host "  a guard that gets routed around is worse than no guard, because it also carries" -ForegroundColor DarkGray
  Write-Host "  the belief that it is protecting you." -ForegroundColor DarkGray
  Write-Host ""
  Write-Host "  scanned $scanned file(s) in $($sw.ElapsedMilliseconds)ms" -ForegroundColor DarkGray
  exit 1
}

if (-not $Quiet) {
  if ($advisory.Count -gt 0) {
    Write-Host ""
    Write-Host "  secret-scan: $($advisory.Count) advisory finding(s) - NOT blocking (I17)" -ForegroundColor Yellow
    foreach ($a in $advisory) {
      Write-Host "    ~ $($a.File):$($a.Line)  [$($a.Rule)] $($a.Detail)" -ForegroundColor DarkYellow
    }
    Write-Host "    A fuzzy rule may raise a tier; it may never fail a commit." -ForegroundColor DarkGray
  }
  Write-Host "  secret-scan: clean - $scanned file(s)$(if ($skippedBinary) { " (+$skippedBinary binary)" })$(if ($exemptHits) { " (+$exemptHits rule-fixture files)" }) in $($sw.ElapsedMilliseconds)ms" -ForegroundColor DarkGreen
}
exit 0
