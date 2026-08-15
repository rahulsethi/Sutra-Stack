# SPDX-License-Identifier: Apache-2.0
<#
.SYNOPSIS
  THE DAILY PASS — ingest -> compile -> graph -> index -> hygiene.

.DESCRIPTION
  The orchestrator. Deliberately thin: every stage is a script that can be run
  alone, and this file's only jobs are ORDER, LOCKS and HONEST REPORTING.

  ══════════════════════════════════════════════════════════════════════════
  D10 · A TIME LIMIT SHORTER THAN THE JOB
  ══════════════════════════════════════════════════════════════════════════
  Upstream this job had a 2-hour scheduler limit while two of its stages alone
  took ~1.6h. The OS terminated the run EVERY NIGHT FOR 26 DAYS, and everything
  downstream never ran.

  It hid perfectly: the logs were 103 BYTES - a START line and no STOP. The run
  marker still said `ok` from an earlier run. A killed process writes no failure
  record, so the only evidence was an ABSENCE, and nothing was watching for
  absences.

  So this script:
    * writes a start marker with `ended_at: null` BEFORE any work;
    * CAPTURES EVERY STAGE'S STDOUT to logs/pipeline/ - "the wrapper logged only
      START/STOP" is precisely what made 4.5 silent hours undiagnosable;
    * records per-stage duration, so `doctor` can compare against the
      scheduler's limit and warn when the margin is under 2x.

  ══════════════════════════════════════════════════════════════════════════
  D11 · FIVE OUTCOMES, NEVER ONE COUNTER
  ══════════════════════════════════════════════════════════════════════════
  `ok` / `degraded` / `failed` / `skipped (no input)` / `skipped (policy)`.
  A majority-failure exits non-zero. An all-zero run with input present reports
  `no-op`, NOT `ok`. AN EMPTY VAULT EXITS 0 - no false alarm on a fresh install.

  ══════════════════════════════════════════════════════════════════════════
  D9 · ONE LOCK SET, ACQUIRED IN ASCENDING RANK
  ══════════════════════════════════════════════════════════════════════════
  Held for the whole pass. A second run SKIPS AND EXITS 0 - a normal outcome,
  and a red task in the scheduler for a normal outcome trains people to ignore
  red tasks.

  ══════════════════════════════════════════════════════════════════════════
  RETENTION DOES NOT RUN HERE
  ══════════════════════════════════════════════════════════════════════════
  D27: a prune must never ride a pipeline run. Retention is monthly, on its own
  trigger, so a bug in it cannot take the corpus with it.
#>

[CmdletBinding()]
param(
  [Parameter(Position = 0)][string]$VaultRoot,
  [string]$InstallRoot,
  [switch]$SkipHygiene
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Continue'   # a failing stage must not abort the pass

if (-not $VaultRoot) { $VaultRoot = $env:SUTRA_VAULT }
if (-not $VaultRoot) { throw "no vault root. Pass it positionally or set SUTRA_VAULT." }
if (-not $InstallRoot) { $InstallRoot = if ($env:SUTRA_HOME) { $env:SUTRA_HOME } else { (Resolve-Path "$PSScriptRoot/../../..").Path } }

. "$PSScriptRoot/../lib/Frontmatter.ps1"
. "$PSScriptRoot/../lib/RunLock.ps1"

$ScriptsDir = Join-VaultPath -Root $InstallRoot -Parts @('automation', 'scripts')
$LogDir     = Join-VaultPath -Root $VaultRoot -Parts @('logs', 'pipeline')
$RunId      = "$((Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH-mm-ss'))-daily"

if (-not (Test-Path -LiteralPath $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }

function Write-RunMarker {
  <#
  .SYNOPSIS
    D10 - the run marker. `ended_at: null` is the signal a run died.
  .DESCRIPTION
    Write-then-rename: a crash mid-write must not leave truncated JSON that
    every later reader fails to parse, which would turn one bad run into
    permanent blindness.
  #>
  param($Record)
  try {
    $p = Join-VaultPath -Root $VaultRoot -Parts @('state', 'checks', 'last-run.json')
    $d = Split-Path -Parent $p
    if (-not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
    $tmp = "$p.tmp"
    Write-NoteFile -Path $tmp -Content (($Record | ConvertTo-Json -Depth 6) + "`n")
    Move-Item -LiteralPath $tmp -Destination $p -Force
  } catch { }
}

$started = Get-Date
Write-RunMarker @{
  run_id     = $RunId
  host       = [Environment]::MachineName
  started_at = $started.ToUniversalTime().ToString('o')
  ended_at   = $null          # <- the D10 signal
  result     = 'running'
  did_work   = $null
}

$Stages = @(
  @{ Name = 'ingest';        Script = 'ingest.ps1' }
  @{ Name = 'compile';       Script = 'auto-compile.ps1' }
  @{ Name = 'graph-export';  Script = 'graph-export.ps1' }
  @{ Name = 'refresh-index'; Script = 'refresh-index.ps1' }
)
if (-not $SkipHygiene) { $Stages += @{ Name = 'hygiene'; Script = 'hygiene/all.ps1' } }

$results = New-Object System.Collections.ArrayList

$outcome = Invoke-WithResourceLock -VaultRoot $VaultRoot -RunId $RunId `
  -Resources @('vault', 'raw-inbox', 'extracts', 'pages', 'embed-index', 'graph-a') -Body {

  foreach ($stage in $Stages) {
    $path = Join-VaultPath -Root $ScriptsDir -Parts @($stage.Script)
    $t0 = Get-Date

    if (-not (Test-Path -LiteralPath $path)) {
      # NOT a failure. A stage that is not installed is a POLICY skip, and
      # collapsing those two is D11 exactly.
      [void]$results.Add(@{
        Stage = $stage.Name; Outcome = 'skipped-policy'
        Produced = $null; Considered = $null; DurationMs = 0
        Reason = "$($stage.Script) is not present in this install"
      })
      Write-Host "  - $($stage.Name): not installed"
      continue
    }

    Write-Host ""
    Write-Host "== $($stage.Name) =="

    # D10 - CAPTURE THE CHILD'S OUTPUT. Always, including on failure.
    $logPath = Join-VaultPath -Root $LogDir -Parts @("$($stage.Name)-$((Get-Date).ToString('yyyy-MM-dd')).log")
    $out = & pwsh -NoProfile -NonInteractive -File $path $VaultRoot 2>&1
    $code = $LASTEXITCODE
    $text = ($out | Out-String)

    try {
      $header = "`n===== $((Get-Date).ToUniversalTime().ToString('o')) $($stage.Name) (exit $code) =====`n"
      Add-Content -LiteralPath $logPath -Value ($header + $text) -Encoding utf8
    } catch { }
    Write-Host $text.TrimEnd()

    # Stages report their own counts on two well-known lines.
    $produced = $null
    $considered = $null
    $mP = [regex]::Match($text, '(?m)^produced:\s*(\d+)')
    $mC = [regex]::Match($text, '(?m)^considered:\s*(\d+)')
    if ($mP.Success) { $produced = [int]$mP.Groups[1].Value }
    if ($mC.Success) { $considered = [int]$mC.Groups[1].Value }

    $verdict = if ($code -ne 0) { 'failed' }
               elseif ($null -ne $produced -and $produced -eq 0 -and $null -ne $considered -and $considered -gt 0) { 'no-op' }
               else { 'ok' }

    [void]$results.Add(@{
      Stage = $stage.Name; Outcome = $verdict
      Produced = $produced; Considered = $considered
      DurationMs = [int]((Get-Date) - $t0).TotalMilliseconds
      Reason = $(if ($code -ne 0) { "exit $code" } else { $null })
    })
  }
  return $true
}

if (-not $outcome.Ran) {
  # A loser SKIPS AND EXITS 0. Normal, not an error.
  Write-RunMarker @{
    run_id = $RunId; host = [Environment]::MachineName
    started_at = $started.ToUniversalTime().ToString('o')
    ended_at = (Get-Date).ToUniversalTime().ToString('o')
    result = 'skipped-policy'; did_work = $null
    notes = @('another run holds the pipeline locks')
  }
  exit 0
}

# ── D11 · roll up, WITHOUT collapsing the distinctions ───────────────────────
$failed      = @($results | Where-Object { $_.Outcome -eq 'failed' })
$substantive = @($results | Where-Object { $_.Outcome -notlike 'skipped-*' })
$measurable  = @($results | Where-Object { $null -ne $_.Produced })

# THREE-VALUED. $null = not measurable, so the fix cannot misfire in the other
# direction and cry "did nothing" without proof.
$didWork = if ($measurable.Count -eq 0) { $null }
           else { [bool](@($measurable | Where-Object { $_.Produced -gt 0 }).Count -gt 0) }

$notes = New-Object System.Collections.ArrayList
$result = 'ok'
$exitCode = 0

if ($substantive.Count -eq 0) {
  # AN EMPTY VAULT EXITS 0 - D11's own counter-test.
  $result = 'skipped-no-input'
  [void]$notes.Add('every stage skipped benignly - there was nothing to do. This is not a failure.')
} elseif ($failed.Count -gt 0 -and ($failed.Count / $substantive.Count) -ge 0.5) {
  $result = 'failed'
  $exitCode = 1
  [void]$notes.Add("$($failed.Count) of $($substantive.Count) substantive stages FAILED ($(($failed | ForEach-Object { $_.Stage }) -join ', '))")
} elseif ($failed.Count -gt 0) {
  $result = 'degraded'
  foreach ($f in $failed) { [void]$notes.Add("$($f.Stage): failed - $($f.Reason)") }
} elseif ($didWork -eq $false -and @($results | Where-Object { $_.Considered -gt 0 }).Count -gt 0) {
  $result = 'no-op'
  [void]$notes.Add('every stage reported success and produced ZERO items while input existed. This is no-op, not ok.')
}

$ended = Get-Date
$record = @{
  run_id     = $RunId
  host       = [Environment]::MachineName
  started_at = $started.ToUniversalTime().ToString('o')
  ended_at   = $ended.ToUniversalTime().ToString('o')
  duration_s = [math]::Round(($ended - $started).TotalSeconds, 1)
  result     = $result
  did_work   = $didWork
  exit_code  = $exitCode
  stages     = @($results)
  stages_summary = @{}
  notes      = @($notes)
}
foreach ($r in $results) { $record.stages_summary[$r.Stage] = $r.Outcome }

Write-RunMarker $record
try {
  $runsLog = Join-VaultPath -Root $VaultRoot -Parts @('logs', 'runs.ndjson')
  Add-Content -LiteralPath $runsLog -Value ($record | ConvertTo-Json -Depth 6 -Compress) -Encoding utf8
} catch { }

Write-Host ""
Write-Host "daily: $result ($($record.duration_s)s, did_work=$(if ($null -eq $didWork) { 'not-measurable' } else { $didWork }))"
foreach ($r in $results) {
  $p = if ($null -eq $r.Produced) { '-' } else { $r.Produced }
  Write-Host ("  {0,-14} {1,-16} {2,7}ms  produced={3}" -f $r.Stage, $r.Outcome, $r.DurationMs, $p)
}
foreach ($n in $notes) { Write-Host "  $n" }
exit $exitCode
