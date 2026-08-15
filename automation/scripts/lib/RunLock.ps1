# SPDX-License-Identifier: Apache-2.0
<#
.SYNOPSIS
  Rank-ordered resource locks. The PowerShell twin of
  `packages/core/src/run/lock.ts`.

.DESCRIPTION
  D9 - FOUR JOBS WRITING ONE ARTIFACT, WITH NO LOCK.

  Three scheduled jobs all wrote the graph export, the embed index and the KG,
  with nothing between them. Task Scheduler's `MultipleInstances = IgnoreNew`
  guards a task against ITSELF, never against another task.

  The overlap only became GUARANTEED once the daily run got slower, so the
  defect was latent for as long as jobs happened to finish early - and
  corruption of a derived JSON looks like a rebuild bug, not a concurrency bug.

  Design decisions, each of which is load-bearing:

  * NAMED, PER-RESOURCE locks - not one global lock. A global lock would freeze
    the knowledge graph for the whole duration of every long daily run, and that
    graph has already been lost once.

  * ASCENDING RANK ONLY. Acquiring out of order THROWS. Circular wait is
    impossible by construction rather than by convention.

  * ALL-OR-NOTHING. A partial acquisition is released before returning.

  * A LOSER SKIPS AND EXITS 0. "Another run holds this" is a normal outcome. A
    red task in the OS scheduler for a normal outcome trains people to ignore
    red tasks, which is how a real failure goes unnoticed.

  * A FOREIGN-HOST LOCK IS NEVER PID-RECLAIMED. Pid 4242 exists on almost every
    machine; reclaiming a foreign lock because the number happens to be live
    locally is corruption waiting to happen. Foreign locks age out instead.

  D30 - deletion goes through [IO.File]::Delete, NOT Remove-Item.
  `Remove-Item -LiteralPath` fails on 8.3 short-name paths EVEN UNDER
  `-ErrorAction SilentlyContinue`, and a lock that cannot be deleted never
  releases.

  D31 - timestamps are stored as EPOCH MILLISECONDS, not ISO strings.
  `ConvertFrom-Json` silently re-hydrates an ISO-8601 string into a [datetime],
  and round-tripping renders it in the CURRENT CULTURE, shifting every age
  computation by the UTC offset.

  Lock files live under `.sutra/locks/` and are gitignored: they are per-machine
  runtime state, and committed they arrive on another host as un-reclaimable
  foreign locks.
#>

Set-StrictMode -Version Latest

. "$PSScriptRoot/Frontmatter.ps1"

# THE RANK ORDER. Adding a resource means choosing its rank here, once, for
# everyone - which is the point.
$script:ResourceRank = @{
  'vault'       = 10
  'raw-inbox'   = 20
  'extracts'    = 30
  'pages'       = 40
  'embed-index' = 50
  'graph-a'     = 60
  'graph-kg'    = 70
  'publish'     = 80
}

function Get-LockPath {
  param([Parameter(Mandatory)][string]$VaultRoot, [Parameter(Mandatory)][string]$Resource)
  return (Join-VaultPath -Root $VaultRoot -Parts @('.sutra', 'locks', "$Resource.lock.json"))
}

function Test-HolderAlive {
  <#
  .SYNOPSIS
    Is the lock's holder still running?
  .DESCRIPTION
    A dead SAME-HOST pid may be reclaimed. A FOREIGN-HOST lock never is - it
    ages out instead.
  #>
  param(
    [Parameter(Mandatory)]$Info,
    [Parameter(Mandatory)][long]$NowMs,
    [Parameter(Mandatory)][long]$StaleMs
  )
  if ($Info.host -ne [Environment]::MachineName) {
    return (($NowMs - [long]$Info.acquired_ms) -lt $StaleMs)
  }
  $p = Get-Process -Id ([int]$Info.pid) -ErrorAction SilentlyContinue
  return ($null -ne $p)
}

function Remove-LockFile {
  <# .SYNOPSIS  D30 - [IO.File]::Delete, never Remove-Item. #>
  param([Parameter(Mandatory)][string]$Path)
  try { if ([IO.File]::Exists($Path)) { [IO.File]::Delete($Path) } } catch { }
}

function Get-ResourceLock {
  <#
  .SYNOPSIS
    Acquire one or more named locks, all-or-nothing, in ascending rank order.
  .OUTPUTS
    @{ Ok = $true;  Resources = @(...) }
    @{ Ok = $false; HeldBy = <info>; Message = <string> }
  #>
  param(
    [Parameter(Mandatory)][string]$VaultRoot,
    [Parameter(Mandatory)][string[]]$Resources,
    [string]$RunId = "$PID",
    [double]$StaleHours = 6
  )

  $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $staleMs = [long]($StaleHours * 3600000)

  foreach ($r in $Resources) {
    if (-not $script:ResourceRank.ContainsKey($r)) {
      throw "unknown lock resource '$r'. Add it to `$script:ResourceRank with a deliberate rank - an unranked lock cannot participate in the deadlock proof."
    }
  }
  for ($i = 1; $i -lt $Resources.Count; $i++) {
    $prev = $script:ResourceRank[$Resources[$i - 1]]
    $cur  = $script:ResourceRank[$Resources[$i]]
    if ($cur -lt $prev) {
      throw "lock resources must be acquired in ASCENDING rank order; got $($Resources[$i-1])($prev) before $($Resources[$i])($cur). Ascending-only acquisition is what makes circular wait impossible by construction."
    }
  }

  $acquired = New-Object System.Collections.ArrayList
  $releaseAll = {
    foreach ($r in $acquired) { Remove-LockFile (Get-LockPath -VaultRoot $VaultRoot -Resource $r) }
    $acquired.Clear()
  }

  foreach ($resource in $Resources) {
    $path = Get-LockPath -VaultRoot $VaultRoot -Resource $resource
    $dir = Split-Path -Parent $path
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }

    if ([IO.File]::Exists($path)) {
      $existing = $null
      try { $existing = [IO.File]::ReadAllText($path) | ConvertFrom-Json } catch { }
      if ($existing -and (Test-HolderAlive -Info $existing -NowMs $nowMs -StaleMs $staleMs)) {
        & $releaseAll
        return @{
          Ok = $false
          HeldBy = $existing
          Message = "resource '$resource' is held by $($existing.run_id) (pid $($existing.pid) on $($existing.host)). Skipping - this is a NORMAL outcome, not a failure; exit 0."
        }
      }
    }

    $info = @{
      resource    = $resource
      host        = [Environment]::MachineName
      pid         = $PID
      acquired_ms = $nowMs      # D31 - a NUMBER, never an ISO string
      run_id      = $RunId
    }
    try {
      # Create-exclusive: two processes racing here cannot both succeed.
      $fs = [IO.File]::Open($path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
      $fs.Dispose()
      Write-NoteFile -Path $path -Content (($info | ConvertTo-Json -Compress) + "`n")
      [void]$acquired.Add($resource)
    } catch {
      & $releaseAll
      return @{ Ok = $false; HeldBy = $null; Message = "resource '$resource' was taken during acquisition. Skipping; exit 0." }
    }
  }

  return @{ Ok = $true; Resources = @($acquired); VaultRoot = $VaultRoot }
}

function Remove-ResourceLock {
  <# .SYNOPSIS  Release. Idempotent - a nested caller must not double-release. #>
  param([Parameter(Mandatory)]$Handle)
  if (-not $Handle.Ok) { return }
  foreach ($r in $Handle.Resources) {
    Remove-LockFile (Get-LockPath -VaultRoot $Handle.VaultRoot -Resource $r)
  }
  $Handle.Resources = @()
}

function Invoke-WithResourceLock {
  <#
  .SYNOPSIS
    Run a script block holding the named locks. Releases on ANY exit path.
  .DESCRIPTION
    On failure to acquire, returns @{ Ran = $false } and the CALLER decides what
    to report. The default everywhere in this product is "skip, exit 0".
  #>
  param(
    [Parameter(Mandatory)][string]$VaultRoot,
    [Parameter(Mandatory)][string[]]$Resources,
    [Parameter(Mandatory)][scriptblock]$Body,
    [string]$RunId = "$PID"
  )
  $handle = Get-ResourceLock -VaultRoot $VaultRoot -Resources $Resources -RunId $RunId
  if (-not $handle.Ok) {
    Write-Host "  skipped - $($handle.Message)"
    return @{ Ran = $false; HeldBy = $handle.HeldBy }
  }
  try { return @{ Ran = $true; Value = (& $Body) } }
  finally { Remove-ResourceLock -Handle $handle }
}
