# SPDX-License-Identifier: Apache-2.0
<#
.SYNOPSIS
  BACKUP — a timestamped snapshot of the vault, plus a git safety commit.

.DESCRIPTION
  INVARIANT 7 depends on this existing: "automated maintenance may act without
  asking BECAUSE every action is git-tracked and reversible". A backup is what
  makes "reversible" true for the cases git alone does not cover — an untracked
  capture, a working tree mid-pipeline, a vault someone has not committed in a
  week.

  ── WHAT IT DOES NOT DO ────────────────────────────────────────────────────
  It does not `reset`, `checkout -f` or `clean`. D25: those are the ONLY ways to
  lose data here, and every search result recommends them. `git submodule
  update` ALWAYS aborts on a node whose vault working tree is dirty — which is
  every node that runs the pipeline, because the pipeline is what dirties it —
  and the reflexive fixes for that message are destructive.

  So this script only ever ADDS: a commit, or a copy. Nothing it does can lose a
  capture.

  ── D27 · RETENTION HAS A HARD FLOOR ───────────────────────────────────────
  Old snapshots are pruned with `-Prune`, and the NEWEST N are never pruned
  regardless of age. Upstream accumulated 343 MB of unpruned snapshots; the fix
  for that must not become a way to delete the last good copy.

  Retention is also NEVER run inside a pipeline pass — a prune must not ride a
  run that might itself be the thing going wrong.

.PARAMETER Prune
  Remove snapshots older than -KeepDays, keeping at least -KeepMinimum.

.EXAMPLE
  sutra backup
  pwsh automation/scripts/backup.ps1 <vault> -Prune -KeepDays 30
#>

[CmdletBinding()]
param(
  [Parameter(Position = 0)][string]$VaultRoot,
  [string]$InstallRoot,
  [string]$Destination,
  [switch]$Prune,
  [int]$KeepDays = 30,
  [int]$KeepMinimum = 3,
  # D27 requires `-WhatIf` to be EXERCISED IN CI, not merely offered. A dry run
  # nobody has ever run is a dry run that does not work, and this is the one
  # command where finding that out for real costs you the snapshots.
  [switch]$WhatIf,
  [double]$RotateLogsAtMb = 8
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $VaultRoot) { $VaultRoot = $env:SUTRA_VAULT }
if (-not $VaultRoot) { throw "no vault root. Pass it positionally or set SUTRA_VAULT." }
if (-not (Test-Path -LiteralPath $VaultRoot)) { throw "vault not found: $VaultRoot" }

. "$PSScriptRoot/lib/Frontmatter.ps1"

$stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH-mm-ss')
if (-not $Destination) { $Destination = Join-VaultPath -Root $VaultRoot -Parts @('.sutra', 'backups') }
if (-not (Test-Path -LiteralPath $Destination)) { New-Item -ItemType Directory -Path $Destination -Force | Out-Null }

$considered = 0
$produced = 0

# ── 1 · The git safety commit ────────────────────────────────────────────────
# The cheapest and most useful backup there is: the vault's own history. ADDITIVE
# ONLY — `git add -A` plus a commit. Never a reset, never a checkout.
$isGit = Test-Path -LiteralPath (Join-VaultPath -Root $VaultRoot -Parts @('.git'))
if ($isGit) {
  Push-Location $VaultRoot
  try {
    $dirty = & git status --porcelain 2>$null
    if ($LASTEXITCODE -ne 0) {
      Write-Warning "git status failed in $VaultRoot - skipping the safety commit."
    } elseif ([string]::IsNullOrWhiteSpace(($dirty | Out-String))) {
      Write-Host "  git: working tree clean, nothing to commit"
    } elseif ($WhatIf) {
      Write-Host "  WOULD commit: $(@($dirty).Count) change(s) as a safety snapshot"
    } else {
      $count = @($dirty).Count
      & git add -A 2>$null | Out-Null
      & git commit -q -m "vault: safety snapshot $stamp" 2>$null | Out-Null
      if ($LASTEXITCODE -eq 0) {
        Write-Host "  git: committed $count change(s) as a safety snapshot"
        $produced++
      } else {
        Write-Warning "git commit failed - the file copy below is still taken."
      }
    }
    $considered++
  } finally { Pop-Location }
} else {
  Write-Host "  git: the vault is not a repo - only the file copy is available." -ForegroundColor Yellow
  Write-Host "        Invariant 7 (reversible-auto) is weaker without it: `git init` in the vault." -ForegroundColor DarkGray
}

# ── 2 · The file copy ────────────────────────────────────────────────────────
# Notes and policy only. Derived artifacts are excluded BY DESIGN: they are
# rebuildable (invariant 1), they are the bulk of the bytes, and a backup that
# is mostly regenerable cache is one people stop taking.
# D27/D35 · THE HOST IS IN THE NAME.
#
# Without it, retention cannot reason per host — and "keep the newest 3" on a
# directory two machines write into can delete BOTH of one machine's copies while
# keeping three of the other's. Same root cause as D35's phantom shrink: a shared
# directory whose entries are ordered as though one machine produced them.
$hostTag = ([Environment]::MachineName -replace '[^A-Za-z0-9_-]', '-').ToLowerInvariant()
$snapshotDir = Join-VaultPath -Root $Destination -Parts @("vault-$stamp--$hostTag")
$sourceDirs = @('vault', 'automation/policies', 'automation/config')

$copied = 0
foreach ($rel in $sourceDirs) {
  $src = Join-VaultPath -Root $VaultRoot -Parts @($rel)
  if (-not (Test-Path -LiteralPath $src)) { continue }
  $copied += @(Get-ChildItem -LiteralPath $src -Recurse -File -ErrorAction SilentlyContinue).Count
  # `-WhatIf` MUST BE A FULL DRY RUN, not a dry prune with a live copy.
  #
  # The first version guarded only the prune, so `-WhatIf` still wrote a whole
  # new snapshot directory — which then counted as a host in the retention
  # grouping. A flag whose name promises "nothing happened" and which does most
  # of the work anyway is silent degradation with a reassuring label, and it is
  # worse here than elsewhere: the whole point of the flag is to be trusted
  # before a destructive operation.
  if ($WhatIf) { continue }
  $dst = Join-VaultPath -Root $snapshotDir -Parts @($rel)
  New-Item -ItemType Directory -Path $dst -Force | Out-Null
  Copy-Item -LiteralPath $src -Destination (Split-Path -Parent $dst) -Recurse -Force
}

$considered += $copied
if ($WhatIf) {
  Write-Host "  WOULD copy: $copied file(s) -> $snapshotDir"
} elseif ($copied -gt 0) {
  $produced++
  Write-Host "  copy: $copied file(s) -> $snapshotDir"
} else {
  Write-Host "  copy: nothing to copy (an empty vault is not an error)"
}

# ── 3 · Retention, with a HARD FLOOR ─────────────────────────────────────────
if ($Prune) {
  $snapshots = @(Get-ChildItem -LiteralPath $Destination -Directory -Filter 'vault-*' -ErrorAction SilentlyContinue |
                 Sort-Object Name -Descending)

  # THE HARD FLOOR, PER HOST. The newest N FROM EACH HOST are never pruned,
  # whatever their age. A retention job that can delete the last good copy is a
  # data-loss tool with a tidy name — and a GLOBAL floor is exactly that on a
  # two-machine setup: three snapshots from the laptop satisfy "keep 3" while the
  # desktop's only copy ages out.
  #
  # A snapshot with no host tag predates this and is grouped under '(untagged)',
  # which gets its own floor rather than being lumped in with a real host.
  $hostOf = {
    param($name)
    $m = [regex]::Match($name, '^vault-.+?--(?<h>[A-Za-z0-9_-]+)$')
    if ($m.Success) { $m.Groups['h'].Value } else { '(untagged)' }
  }

  $protectedNames = New-Object System.Collections.Generic.HashSet[string]
  foreach ($grp in ($snapshots | Group-Object { & $hostOf $_.Name })) {
    foreach ($keep in @($grp.Group | Sort-Object Name -Descending | Select-Object -First $KeepMinimum)) {
      [void]$protectedNames.Add($keep.Name)
    }
  }

  $cutoff = (Get-Date).AddDays(-$KeepDays)
  $candidates = @($snapshots | Where-Object {
    -not $protectedNames.Contains($_.Name) -and $_.CreationTime -lt $cutoff
  })

  foreach ($c in $candidates) {
    if ($WhatIf) {
      Write-Host "  WOULD prune: $($c.Name)"
      continue
    }
    Remove-Item -LiteralPath $c.FullName -Recurse -Force
    Write-Host "  pruned: $($c.Name)"
  }

  $verb = if ($WhatIf) { 'would prune' } else { 'pruned' }
  $hosts = @($snapshots | Group-Object { & $hostOf $_.Name }).Count
  Write-Host "  retention: $($candidates.Count) $verb, $($protectedNames.Count) protected by the floor across $hosts host(s), $($snapshots.Count - $candidates.Count) kept"
}

# ── 4 · Provider logs are ROTATED, NEVER DELETED ─────────────────────────────
# D27's other half, and the half with the sharper edge. `provider.ndjson` is the
# HEALTH GROUND TRUTH: it is the only record of whether a key has ever once
# succeeded, which is what separates a dead key from a rate limit (I3). Pruning
# it to save 7.5 MB destroys the evidence needed to diagnose the thing the prune
# was tidying up after.
#
# So it rotates: the live file is truncated to a new generation, and the old
# generation is KEPT. Nothing here deletes a log.
$providerLog = Join-VaultPath -Root $VaultRoot -Parts @('logs', 'sutra', 'provider.ndjson')
if ($Prune -and (Test-Path -LiteralPath $providerLog)) {
  $sizeMb = ((Get-Item -LiteralPath $providerLog).Length / 1MB)
  if ($sizeMb -ge $RotateLogsAtMb) {
    $rotated = "$providerLog.$stamp"
    if ($WhatIf) {
      Write-Host ("  WOULD rotate: provider.ndjson ({0:N1} MB) -> {1}" -f $sizeMb, (Split-Path -Leaf $rotated))
    } else {
      Move-Item -LiteralPath $providerLog -Destination $rotated
      Write-Host ("  rotated: provider.ndjson ({0:N1} MB) -> {1} (KEPT, not deleted)" -f $sizeMb, (Split-Path -Leaf $rotated))
    }
  } else {
    Write-Host ("  provider log: {0:N1} MB, under the {1} MB rotation threshold" -f $sizeMb, $RotateLogsAtMb)
  }
}

Write-Host ""
Write-Host "considered: $considered"
Write-Host "produced: $produced"
exit 0
