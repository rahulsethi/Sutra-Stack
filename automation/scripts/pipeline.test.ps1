# SPDX-License-Identifier: Apache-2.0
<#
.SYNOPSIS
  The pipeline's absence tests, run against REAL SCRIPT INVOCATIONS on temp
  vaults: D23 (extract/reason-enum), D2 (synth/repair-reaches-corpus),
  D22 (queue/decision-bearing), D27 (retention hard floor), D37
  (graph/provenance-survives-merge).

.DESCRIPTION
  Every test here runs the actual `.ps1` the pipeline runs. That is deliberate
  and it is the lesson of "created != wired" plus its twin "run != scheduled":
  a unit test on an extracted helper proves the helper works, and upstream the
  helpers all worked. What failed was the seam between them - D37 is precisely a
  field that passed the extractor's test AND the builder's test and existed in
  zero output records, because no test spanned the two.

  So these are end-to-end, on throwaway vaults, asserting the artifact on disk.

.EXAMPLE
  pwsh -NoProfile -File automation/scripts/pipeline.test.ps1
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ScriptDir   = $PSScriptRoot
$InstallRoot = (Resolve-Path "$PSScriptRoot/../..").Path
$script:Pass = 0
$script:Fail = 0

function It {
  param([Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][scriptblock]$Body)
  try {
    & $Body
    $script:Pass++
    Write-Host "  ok   $Name" -ForegroundColor DarkGreen
  } catch {
    $script:Fail++
    Write-Host "  FAIL $Name" -ForegroundColor Red
    Write-Host "       $($_.Exception.Message)" -ForegroundColor DarkRed
  }
}
function Assert-Equal {
  param($Expected, $Actual, [string]$Because = '')
  if ($Expected -ne $Actual) { throw "expected '$Expected', got '$Actual'. $Because" }
}
function Assert-True {
  param([bool]$Condition, [string]$Because = '')
  if (-not $Condition) { throw "expected true. $Because" }
}

function New-TempVault {
  <# A vault skeleton, with nothing in it. #>
  $root = [IO.Path]::Combine([IO.Path]::GetTempPath(), "sutra-pipe-$([guid]::NewGuid().ToString('N').Substring(0,10))")
  foreach ($d in @(
    'vault/00-inbox', 'vault/10-notes', 'raw/inbox', 'raw/manifests',
    'compiled/extracts', 'compiled/pages', 'graph/exports', 'logs/sutra', 'state/checks'
  )) {
    New-Item -ItemType Directory -Path ([IO.Path]::Combine($root, ($d -replace '/', [IO.Path]::DirectorySeparatorChar))) -Force | Out-Null
  }
  return $root
}

function New-Note {
  param(
    [Parameter(Mandatory)][string]$Root,
    [Parameter(Mandatory)][string]$RelPath,
    [Parameter(Mandatory)][hashtable]$FrontMatter,
    [string]$Body = ''
  )
  $lines = New-Object System.Collections.ArrayList
  [void]$lines.Add('---')
  foreach ($k in $FrontMatter.Keys) { [void]$lines.Add("${k}: $($FrontMatter[$k])") }
  [void]$lines.Add('---')
  [void]$lines.Add('')
  [void]$lines.Add($Body)
  $full = [IO.Path]::Combine($Root, ($RelPath -replace '/', [IO.Path]::DirectorySeparatorChar))
  $dir = Split-Path -Parent $full
  if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  [IO.File]::WriteAllText($full, ($lines -join "`n") + "`n")
  return $full
}

function Invoke-Pipe {
  <# Run a pipeline script and return its combined output as one string. #>
  param([Parameter(Mandatory)][string]$Script, [Parameter(Mandatory)][string[]]$PipeArgs)
  $path = [IO.Path]::Combine($ScriptDir, ($Script -replace '/', [IO.Path]::DirectorySeparatorChar))
  return ((& pwsh -NoProfile -File $path @PipeArgs 2>&1) | Out-String)
}

# ═════════════════════════════════════════════════════════════════════════════
Write-Host ""
Write-Host "D23 - one failure string for two different failures" -ForegroundColor Cyan

It 'D23 - the reason is an ENUM, and tool-missing != source-empty' {
  # Upstream: `trafilatura: no content or uv unavailable` covered BOTH "the tool
  # is not installed on this node" and "the page returned no content" - 240 of
  # 319 pending items, unseparable from the manifests alone. It reads like a
  # precise diagnosis, which is why nobody looked twice.
  #
  # The two have OPPOSITE retry policies, and that is the whole point: one
  # recovers when you install something, the other never recovers.
  . "$ScriptDir/lib/Frontmatter.ps1"
  . "$ScriptDir/lib/Tier.ps1"
  . "$ScriptDir/lib/Classify.ps1"

  # Re-declare the extractor table and function the way ingest.ps1 does, then
  # assert on it. (`ingest.ps1` has a param block and a main body, so it cannot
  # be dot-sourced; the end-to-end assertion is the next test.)
  $src = [IO.File]::ReadAllText([IO.Path]::Combine($ScriptDir, 'ingest.ps1'))
  $tableMatch = [regex]::Match($src, '(?ms)^\$Extractors = @\{.*?^\}')
  Assert-True $tableMatch.Success 'the $Extractors table could not be located - this test is checking nothing'
  $fnMatch = [regex]::Match($src, '(?ms)^function Get-ExtractReason \{.*?^\}')
  Assert-True $fnMatch.Success 'Get-ExtractReason could not be located'
  Invoke-Expression $tableMatch.Value
  Invoke-Expression $fnMatch.Value

  # The enum values must be DISTINCT for the four distinct causes.
  Assert-Equal 'unsupported'  (Get-ExtractReason -Extension '.xyz' -Bytes 10   -ExtractedText '')     'an unknown extension'
  Assert-Equal 'too-large'    (Get-ExtractReason -Extension '.md'  -Bytes 70MB -ExtractedText 'x')    'an oversized file'
  Assert-Equal 'source-empty' (Get-ExtractReason -Extension '.md'  -Bytes 10   -ExtractedText '')     'an empty source'
  Assert-Equal 'ok'           (Get-ExtractReason -Extension '.md'  -Bytes 10   -ExtractedText 'real') 'a good extract'

  # AND THEY ARE NOT THE SAME VALUE. That single assertion is D23.
  $empty = Get-ExtractReason -Extension '.md' -Bytes 10 -ExtractedText ''
  $unsup = Get-ExtractReason -Extension '.xyz' -Bytes 10 -ExtractedText ''
  Assert-True ($empty -ne $unsup) 'two different causes returned the same reason - THIS IS D23'
}

It 'D23 - a whitespace-only extract is source-empty, not ok' {
  $src = [IO.File]::ReadAllText([IO.Path]::Combine($ScriptDir, 'ingest.ps1'))
  Invoke-Expression ([regex]::Match($src, '(?ms)^\$Extractors = @\{.*?^\}').Value)
  Invoke-Expression ([regex]::Match($src, '(?ms)^function Get-ExtractReason \{.*?^\}').Value)
  Assert-Equal 'source-empty' (Get-ExtractReason -Extension '.md' -Bytes 10 -ExtractedText "   `n`t  ") `
    'whitespace counted as content - a page would be synthesised from nothing'
}

It 'D23 - tool-missing depends on the TOOL, not on the content' {
  # The retry-policy split, asserted structurally: whether a `.pdf` is
  # tool-missing is a function of `pdftotext` being on PATH, and NOTHING about
  # the file. If those two ever get conflated again, the backlog becomes
  # unclassifiable exactly as it did upstream.
  $src = [IO.File]::ReadAllText([IO.Path]::Combine($ScriptDir, 'ingest.ps1'))
  $fn = [regex]::Match($src, '(?ms)^function Get-ExtractReason \{.*?^\}').Value

  Assert-True ($fn -match "Get-Command") 'tool presence is not probed at all'
  # The tool-missing branch must be decided BEFORE the emptiness check, or a
  # missing tool yields an empty extract and gets filed as source-empty - which
  # is the conflation, just spelled differently.
  $iTool  = $fn.IndexOf('tool-missing')
  $iEmpty = $fn.IndexOf('source-empty')
  Assert-True ($iTool -lt $iEmpty) `
    'the emptiness check runs BEFORE the tool check, so a missing tool is filed as source-empty'
}

It 'D23 - ingest runs end to end and writes the enum into the manifest' {
  # The seam. Everything above tests the function; this tests the pipeline.
  $vault = New-TempVault
  try {
    [IO.File]::WriteAllText([IO.Path]::Combine($vault, 'raw', 'inbox', 'good.md'), "# Real`n`nSome genuine prose here.`n")
    [IO.File]::WriteAllText([IO.Path]::Combine($vault, 'raw', 'inbox', 'empty.md'), "")
    [IO.File]::WriteAllText([IO.Path]::Combine($vault, 'raw', 'inbox', 'weird.xyz'), "content the pipeline cannot read")

    # No `-Apply`: that is the RECONCILE mode's switch, not ingest's.
    $out = Invoke-Pipe -Script 'ingest.ps1' -PipeArgs @($vault, '-InstallRoot', $InstallRoot)

    # Manifests are markdown with frontmatter, not JSON - the vault is the truth
    # and the truth is plain markdown (invariant 1).
    $manifests = @(Get-ChildItem -LiteralPath ([IO.Path]::Combine($vault, 'raw', 'manifests')) -Filter '*.md' -ErrorAction SilentlyContinue)
    Assert-True ($manifests.Count -ge 3) "ingest wrote $($manifests.Count) manifests for 3 inputs. Output:`n$out"

    $reasons = @{}
    foreach ($m in $manifests) {
      $mm = [regex]::Match([IO.File]::ReadAllText($m.FullName), '(?m)^extract:\s*(?<r>[a-z-]+)\s*$')
      Assert-True $mm.Success "manifest $($m.Name) carries NO extract reason at all"
      $reasons[$mm.Groups['r'].Value] = $true
    }
    Assert-True ($reasons.Count -ge 2) "three different inputs produced $($reasons.Count) distinct reason(s) - the conflation is back. Got: $($reasons.Keys -join ', ')"

    # Every reason present must be a member of the enum - never a free-form
    # message. A sentence here is how D23 comes back.
    $enum = @('ok', 'source-empty', 'tool-missing', 'unsupported', 'too-large')
    foreach ($r in $reasons.Keys) {
      Assert-True ($enum -contains $r) "manifest reason '$r' is not one of the enum values ($($enum -join ', '))"
    }
  } finally {
    Remove-Item -LiteralPath $vault -Recurse -Force -ErrorAction SilentlyContinue
  }
}

# ═════════════════════════════════════════════════════════════════════════════
Write-Host ""
Write-Host "D2 - idempotency must not block the repair it should enable" -ForegroundColor Cyan

It 'D2 - a NORMAL run does NOT select a fresh-but-degraded page' {
  # Half of the defect, and the half that is correct behaviour. Idempotency is a
  # virtue; nobody read it as a defect precisely because it is.
  $vault = New-TempVault
  try {
    [IO.File]::WriteAllText([IO.Path]::Combine($vault, 'compiled', 'extracts', 'src-1.txt'),
      ('Rich source material. ' * 400))
    New-Note -Root $vault -RelPath 'compiled/pages/src-1.md' -FrontMatter @{
      id = 'src-1'; sensitivity = 'private'; status = 'active'; source_id = 'src-1'
    } -Body "# Stub`n`n## Related`n- [[Something]]`n" | Out-Null

    $out = Invoke-Pipe -Script 'auto-compile.ps1' -PipeArgs @($vault, '-InstallRoot', $InstallRoot)
    Assert-True ($out -match 'skipped') "a normal run gave no skip accounting. Output:`n$out"
  } finally {
    Remove-Item -LiteralPath $vault -Recurse -Force -ErrorAction SilentlyContinue
  }
}

It 'D2 - A REPAIR RUN REACHES THE CORPUS - the guards do not block it' {
  # THE DEFECT. Upstream, with perfect keys, a clean run re-synthesised 0 of 595
  # existing pages: four sequential skip guards, each alone sufficient, and no
  # `-Force`. "Fix the keys and re-run" was the obvious remedy and it did
  # nothing at all.
  $vault = New-TempVault
  try {
    [IO.File]::WriteAllText([IO.Path]::Combine($vault, 'compiled', 'extracts', 'src-1.txt'),
      ('Rich source material about distributed consensus. ' * 400))
    New-Note -Root $vault -RelPath 'compiled/pages/src-1.md' -FrontMatter @{
      id = 'src-1'; sensitivity = 'private'; status = 'active'; source_id = 'src-1'
    } -Body "# Stub`n`n## Related`n- [[Something]]`n" | Out-Null

    $out = Invoke-Pipe -Script 'auto-compile.ps1' -PipeArgs @($vault, '-InstallRoot', $InstallRoot, '-RepairStubs')

    # The page must be SELECTED. Whether a model was available is a separate
    # question - the defect is about selection, and a repair that selects nothing
    # is the bug regardless of what synthesis then does.
    Assert-True ($out -notmatch '0 considered') "the repair run considered nothing. Output:`n$out"
    Assert-True ($out -match 'repair|considered\s*[:=]?\s*[1-9]|selected') `
      "the repair run did not report reaching the corpus. Output:`n$out"
  } finally {
    Remove-Item -LiteralPath $vault -Recurse -Force -ErrorAction SilentlyContinue
  }
}

It 'D2 - repair is REFUSE-DON`T-STUB: a failed re-synthesis leaves the file byte-identical' {
  # The property that makes repair safe to run unattended. If a failed repair
  # could write a worse page, then the remedy for a degraded corpus would be
  # capable of degrading it further - and you would only find out at scale.
  $vault = New-TempVault
  try {
    [IO.File]::WriteAllText([IO.Path]::Combine($vault, 'compiled', 'extracts', 'src-1.txt'),
      ('Source material. ' * 400))
    $page = New-Note -Root $vault -RelPath 'compiled/pages/src-1.md' -FrontMatter @{
      id = 'src-1'; sensitivity = 'private'; status = 'active'; source_id = 'src-1'
    } -Body "# Stub`n`n## Related`n- [[Something]]`n"

    $before = [IO.File]::ReadAllBytes($page)
    # No provider is configured in a temp vault, so synthesis cannot succeed.
    # That is the failure case, arranged without a mock.
    Invoke-Pipe -Script 'auto-compile.ps1' -PipeArgs @($vault, '-InstallRoot', $InstallRoot, '-RepairStubs') | Out-Null
    $after = [IO.File]::ReadAllBytes($page)

    Assert-Equal $before.Length $after.Length 'a FAILED repair rewrote the page - it must refuse, not stub'
    $same = $true
    for ($i = 0; $i -lt $before.Length; $i++) { if ($before[$i] -ne $after[$i]) { $same = $false; break } }
    Assert-True $same 'a failed repair changed the page bytes'
  } finally {
    Remove-Item -LiteralPath $vault -Recurse -Force -ErrorAction SilentlyContinue
  }
}

It 'D2 - a local_only page is NEVER routed hosted, even under repair' {
  # The tier rules must be STRUCTURALLY UNREACHABLE from the repair path, not
  # re-checked inside it. `-RepairStubs` is the most permissive mode the compiler
  # has, so it is the mode where a re-check would be most likely to be skipped.
  $compile = [IO.File]::ReadAllText([IO.Path]::Combine($ScriptDir, 'auto-compile.ps1'))
  # Strip comments so this reads code, not the explanation of the rule.
  $code = [regex]::Replace($compile, '(?s)<#.*?#>', ' ')
  $code = [regex]::Replace($code, '(?m)^\s*#.*$', ' ')

  Assert-True ($code -match 'Test-TierAllowed|Select-Provider|local_only') `
    'the compiler does not consult the gate at all'
  # The repair switches must not appear in the same statement as a tier decision.
  foreach ($m in [regex]::Matches($code, '(?m)^.*(?:RepairStubs|RepairClipped).*$')) {
    Assert-True ($m.Value -notmatch 'hosted_allowed|Test-TierAllowed') `
      "a repair switch appears in a TIER decision - the floor must be structurally unreachable, not re-checked: $($m.Value.Trim())"
  }
}

# ═════════════════════════════════════════════════════════════════════════════
Write-Host ""
Write-Host "D22 - a review queue that is 97% machine artifacts" -ForegroundColor Cyan

It 'D22 - a page and ITS OWN EXTRACT are not a duplicate pair' {
  # 1,919 of 1,972 open queue items were near-dup artifacts, including
  # page<->its-own-extract pairs. Those are STRUCTURAL, not duplicates. The
  # operator-review brief was fed the raw top-18 and faithfully reported garbage.
  $vault = New-TempVault
  try {
    [IO.File]::WriteAllText([IO.Path]::Combine($vault, 'compiled', 'extracts', 'src-1.txt'),
      ('Identical content. ' * 60))
    New-Note -Root $vault -RelPath 'compiled/pages/src-1.md' -FrontMatter @{
      id = 'src-1'; sensitivity = 'private'; status = 'active'; source_id = 'src-1'
    } -Body ('Identical content. ' * 60) | Out-Null

    $out = Invoke-Pipe -Script 'hygiene/all.ps1' -PipeArgs @($vault, '-InstallRoot', $InstallRoot)
    Assert-True ($out -notmatch 'src-1.*(?:duplicate|near-dup).*src-1') `
      "a page was queued as a duplicate of its own extract. Output:`n$out"
  } finally {
    Remove-Item -LiteralPath $vault -Recurse -Force -ErrorAction SilentlyContinue
  }
}

It 'D22 - NO SINGLE CATEGORY CAN FLOOD THE SURFACE' {
  # The cap. 40 near-identical notes must not produce 40 lines; the surface has
  # to stay something a person can act on, which is the entire definition of a
  # review queue.
  $vault = New-TempVault
  try {
    foreach ($i in 1..40) {
      New-Note -Root $vault -RelPath "vault/10-notes/dup-$i.md" -FrontMatter @{
        id = "dup-$i"; sensitivity = 'private'; status = 'active'
      } -Body "# Duplicate`n`nThe same body text repeated for every note.`n" | Out-Null
    }

    $out = Invoke-Pipe -Script 'hygiene/all.ps1' -PipeArgs @($vault, '-InstallRoot', $InstallRoot, '-MaxPerCategory', '5')

    # Either it capped, or it never produced that many. Both are acceptable; what
    # is not acceptable is 40 lines.
    $dupLines = @([regex]::Matches($out, '(?m)^\s+.*dup-\d+'))
    Assert-True ($dupLines.Count -le 12) `
      "the surface listed $($dupLines.Count) items from one category. Output:`n$out"
    if ($dupLines.Count -ge 5) {
      Assert-True ($out -match 'more \(capped') 'items were dropped without saying so - a silent cap is a lie about the queue size'
    }
  } finally {
    Remove-Item -LiteralPath $vault -Recurse -Force -ErrorAction SilentlyContinue
  }
}

It 'D22 - every queued item carries a REMEDY' {
  # "A review surface nobody can act on is not a review surface." An item with no
  # remedy is an item that gets skipped every time it is seen.
  $hyg = [IO.File]::ReadAllText([IO.Path]::Combine($ScriptDir, 'hygiene', 'all.ps1'))
  Assert-True ($hyg -match 'Remedy') 'findings carry no remedy field'
  # Add-Finding must require it, or one caller will omit it and that category
  # becomes unactionable while still looking populated.
  $fn = [regex]::Match($hyg, '(?ms)^function Add-Finding \{.*?^\}').Value
  Assert-True ($fn -match 'Remedy') 'Add-Finding does not take a remedy'
}

# ═════════════════════════════════════════════════════════════════════════════
Write-Host ""
Write-Host "D27 - derived artifacts, unbounded" -ForegroundColor Cyan

function New-Snapshot {
  param([string]$Dest, [string]$Stamp, [string]$HostTag, [int]$AgeDays)
  $d = [IO.Path]::Combine($Dest, "vault-$Stamp--$HostTag")
  New-Item -ItemType Directory -Path $d -Force | Out-Null
  [IO.File]::WriteAllText([IO.Path]::Combine($d, 'marker.txt'), 'x')
  $when = (Get-Date).AddDays(-$AgeDays)
  (Get-Item -LiteralPath $d).CreationTime = $when
  return $d
}

It 'D27 - THE HARD FLOOR IS PER HOST - a second machine keeps its last copy' {
  # The gap this test was written to find, and it found it. A GLOBAL "keep the
  # newest 3" on a directory two machines write into is satisfied entirely by the
  # laptop's three snapshots, and the desktop's ONLY copy ages out. That is a
  # retention job deleting the last good copy of a machine - which is the exact
  # thing the floor exists to make impossible.
  $vault = New-TempVault
  try {
    $dest = [IO.Path]::Combine($vault, '.sutra', 'backups')
    New-Item -ItemType Directory -Path $dest -Force | Out-Null

    # Three recent snapshots from one host, one ANCIENT one from another.
    New-Snapshot -Dest $dest -Stamp '2026-08-15T00-00-00' -HostTag 'laptop'  -AgeDays 1  | Out-Null
    New-Snapshot -Dest $dest -Stamp '2026-08-14T00-00-00' -HostTag 'laptop'  -AgeDays 2  | Out-Null
    New-Snapshot -Dest $dest -Stamp '2026-08-13T00-00-00' -HostTag 'laptop'  -AgeDays 3  | Out-Null
    $desktopOnly = New-Snapshot -Dest $dest -Stamp '2026-01-01T00-00-00' -HostTag 'desktop' -AgeDays 400

    Invoke-Pipe -Script 'backup.ps1' -PipeArgs @(
      $vault, '-InstallRoot', $InstallRoot, '-Destination', $dest,
      '-Prune', '-KeepDays', '30', '-KeepMinimum', '3'
    ) | Out-Null

    Assert-True (Test-Path -LiteralPath $desktopOnly) `
      'THE ONLY SNAPSHOT FROM THE SECOND HOST WAS PRUNED. The floor is global, not per-host.'
  } finally {
    Remove-Item -LiteralPath $vault -Recurse -Force -ErrorAction SilentlyContinue
  }
}

It 'D27 - retention DOES prune, when the floor allows - it is not inert' {
  # The counter-test, and the reason the one above is not just "never delete
  # anything". Upstream accumulated 343 MB over 90 files precisely because
  # nothing pruned; a floor that protects everything reintroduces that.
  $vault = New-TempVault
  try {
    $dest = [IO.Path]::Combine($vault, '.sutra', 'backups')
    New-Item -ItemType Directory -Path $dest -Force | Out-Null
    foreach ($i in 1..6) {
      New-Snapshot -Dest $dest -Stamp ("2026-0{0}-01T00-00-00" -f $i) -HostTag 'laptop' -AgeDays (400 - $i) | Out-Null
    }

    $out = Invoke-Pipe -Script 'backup.ps1' -PipeArgs @(
      $vault, '-InstallRoot', $InstallRoot, '-Destination', $dest,
      '-Prune', '-KeepDays', '30', '-KeepMinimum', '3'
    )

    # Count only the PLANTED host. The run also takes its own snapshot under the
    # real machine name, which is correct behaviour and forms its own host group
    # with its own floor - so a global count here would be asserting on the test
    # harness rather than on retention.
    $left = @(Get-ChildItem -LiteralPath $dest -Directory -Filter '*--laptop')
    Assert-Equal 3 $left.Count "expected the per-host floor to keep exactly 3 laptop snapshots. Output:`n$out"
    Assert-True ($out -match 'pruned') 'retention pruned nothing and said nothing'
  } finally {
    Remove-Item -LiteralPath $vault -Recurse -Force -ErrorAction SilentlyContinue
  }
}

It 'D27 - `-WhatIf` DELETES NOTHING, and is exercised here' {
  # D27 says `-WhatIf` "must be exercised in CI". A dry run nobody has run is a
  # dry run that does not work, and this is the one command where discovering
  # that costs you the snapshots.
  $vault = New-TempVault
  try {
    $dest = [IO.Path]::Combine($vault, '.sutra', 'backups')
    New-Item -ItemType Directory -Path $dest -Force | Out-Null
    foreach ($i in 1..6) {
      New-Snapshot -Dest $dest -Stamp ("2026-0{0}-01T00-00-00" -f $i) -HostTag 'laptop' -AgeDays (400 - $i) | Out-Null
    }

    $out = Invoke-Pipe -Script 'backup.ps1' -PipeArgs @(
      $vault, '-InstallRoot', $InstallRoot, '-Destination', $dest,
      '-Prune', '-WhatIf', '-KeepDays', '30', '-KeepMinimum', '3'
    )

    Assert-Equal 6 (@(Get-ChildItem -LiteralPath $dest -Directory -Filter '*--laptop')).Count '-WhatIf DELETED SNAPSHOTS'
    Assert-True ($out -match 'WOULD prune') "-WhatIf did not report what it would do. Output:`n$out"

    # A FULL dry run: `-WhatIf` must not write a new snapshot either. A flag whose
    # name promises "nothing happened" and which still does most of the work is
    # silent degradation with a reassuring label.
    Assert-Equal 6 (@(Get-ChildItem -LiteralPath $dest -Directory)).Count `
      '-WhatIf created a new snapshot - it is a dry PRUNE, not a dry RUN'
    Assert-True ($out -match 'WOULD copy') '-WhatIf did not say what it would have copied'
  } finally {
    Remove-Item -LiteralPath $vault -Recurse -Force -ErrorAction SilentlyContinue
  }
}

It 'D27 - the provider log is ROTATED, NEVER DELETED' {
  # The half with the sharper edge. `provider.ndjson` is the only record of
  # whether a key has EVER ONCE SUCCEEDED, which is what separates a dead key
  # from a rate limit (I3). Pruning it to save 7.5 MB destroys the evidence
  # needed to diagnose the thing the prune was tidying up after.
  $vault = New-TempVault
  try {
    $log = [IO.Path]::Combine($vault, 'logs', 'sutra', 'provider.ndjson')
    $line = '{"t":"2026-08-01T00:00:00Z","provider":"p","task":"synthesis","status":"ok"}' + "`n"
    $sb = New-Object System.Text.StringBuilder
    while ($sb.Length -lt 9MB) { [void]$sb.Append($line) }
    [IO.File]::WriteAllText($log, $sb.ToString())
    $originalBytes = (Get-Item -LiteralPath $log).Length

    $dest = [IO.Path]::Combine($vault, '.sutra', 'backups')
    $out = Invoke-Pipe -Script 'backup.ps1' -PipeArgs @(
      $vault, '-InstallRoot', $InstallRoot, '-Destination', $dest, '-Prune', '-RotateLogsAtMb', '8'
    )

    Assert-True ($out -match 'rotated') "an oversized provider log was not rotated. Output:`n$out"
    # THE BYTES STILL EXIST SOMEWHERE. That is the assertion.
    $kept = @(Get-ChildItem -LiteralPath ([IO.Path]::Combine($vault, 'logs', 'sutra')) -Filter 'provider.ndjson*')
    $total = ($kept | Measure-Object -Property Length -Sum).Sum
    Assert-True ($total -ge $originalBytes) `
      "provider log bytes were LOST: $total of $originalBytes remain. Rotation must keep the old generation."
    # NOT a naive search for "deleted": the success message itself reads
    # "(KEPT, not deleted)". Assert on the CLAIM, not on the word.
    Assert-True ($out -notmatch '(?<!not )deleted:') 'the log was reported as deleted'
    Assert-True ($out -match 'KEPT, not deleted') 'rotation did not state that the old generation is kept'
  } finally {
    Remove-Item -LiteralPath $vault -Recurse -Force -ErrorAction SilentlyContinue
  }
}

# ═════════════════════════════════════════════════════════════════════════════
Write-Host ""
Write-Host "D37 - the merge drops the provenance it was given" -ForegroundColor Cyan

It 'D37 - A PROVENANCE STAMP SURVIVES THE EXPORT - end to end, not per stage' {
  # THE DEFECT: the extractor stamped `extractor:` on ~7,900 input records and
  # the builder, which constructed its output field-by-field, never copied it.
  # Present on every input, present in ZERO outputs. Both halves passed their own
  # tests. Neither test spanned the seam - so this one does.
  $vault = New-TempVault
  try {
    New-Note -Root $vault -RelPath 'vault/10-notes/stamped.md' -FrontMatter @{
      id = 'stamped'; sensitivity = 'private'; status = 'active'
      extractor = 'trafilatura'; synthesis_provider = 'ollama'
    } -Body "# Stamped`n`nA note with provenance.`n" | Out-Null

    $out = Invoke-Pipe -Script 'graph-export.ps1' -PipeArgs @($vault, '-InstallRoot', $InstallRoot)

    $gp = [IO.Path]::Combine($vault, 'graph', 'exports', 'cytoscape.json')
    Assert-True (Test-Path -LiteralPath $gp) "no graph was exported. Output:`n$out"
    $g = [IO.File]::ReadAllText($gp) | ConvertFrom-Json

    $node = @($g.nodes | Where-Object { $_.data.id -eq 'stamped' })[0]
    Assert-True ($null -ne $node) 'the stamped note produced no node'

    $prov = @($node.data.provenance)
    Assert-True ($prov.Count -ge 2) `
      "THE PROVENANCE STAMP DIED IN THE EXPORT. Got: [$($prov -join ', ')]. This is D37 - the builder enumerates fields and dropped one."
    Assert-True ($prov -contains 'extractor=trafilatura') "the extractor stamp is missing: [$($prov -join ', ')]"
    Assert-True ($prov -contains 'synthesis_provider=ollama') "the provider stamp is missing: [$($prov -join ', ')]"
  } finally {
    Remove-Item -LiteralPath $vault -Recurse -Force -ErrorAction SilentlyContinue
  }
}

It 'D37 - two notes sharing an id produce a TWO-ELEMENT provenance set' {
  # The manifest's own spec: "two batches with different extractors produce a
  # two-element set". Provenance is a SET because one entity legitimately has
  # several producers - so a merge must UNION, not overwrite. Overwriting is the
  # same defect one level up: the second write erases the first.
  $vault = New-TempVault
  try {
    New-Note -Root $vault -RelPath 'vault/10-notes/a.md' -FrontMatter @{
      id = 'shared'; sensitivity = 'private'; status = 'active'; extractor = 'trafilatura'
    } -Body "# Shared`n`nFirst.`n" | Out-Null
    New-Note -Root $vault -RelPath 'vault/10-notes/b.md' -FrontMatter @{
      id = 'shared'; sensitivity = 'private'; status = 'active'; extractor = 'pdftotext'
    } -Body "# Shared`n`nSecond.`n" | Out-Null

    Invoke-Pipe -Script 'graph-export.ps1' -PipeArgs @($vault, '-InstallRoot', $InstallRoot) | Out-Null
    $g = [IO.File]::ReadAllText([IO.Path]::Combine($vault, 'graph', 'exports', 'cytoscape.json')) | ConvertFrom-Json

    $node = @($g.nodes | Where-Object { $_.data.id -eq 'shared' })[0]
    Assert-True ($null -ne $node) 'no node for the shared id'
    $prov = @($node.data.provenance)
    Assert-True ($prov -contains 'extractor=trafilatura') "the FIRST extractor was overwritten: [$($prov -join ', ')]"
    Assert-True ($prov -contains 'extractor=pdftotext')   "the SECOND extractor was dropped: [$($prov -join ', ')]"
    Assert-Equal 2 $prov.Count "expected a two-element set, got [$($prov -join ', ')]"
  } finally {
    Remove-Item -LiteralPath $vault -Recurse -Force -ErrorAction SilentlyContinue
  }
}

It 'D37 - an UNSTAMPED note gets an EMPTY set, not a phantom member' {
  # `null`, `''` and "no provenance" must not become a member. A set containing
  # the empty string is how a later count reports provenance coverage it does not
  # have - and D37's live verification was exactly a coverage split (2,071
  # stamped, 745 legacy unstamped) that only means something if unstamped is nil.
  $vault = New-TempVault
  try {
    New-Note -Root $vault -RelPath 'vault/10-notes/plain.md' -FrontMatter @{
      id = 'plain'; sensitivity = 'private'; status = 'active'; extractor = ''
    } -Body "# Plain`n`nNo provenance.`n" | Out-Null

    Invoke-Pipe -Script 'graph-export.ps1' -PipeArgs @($vault, '-InstallRoot', $InstallRoot) | Out-Null
    $g = [IO.File]::ReadAllText([IO.Path]::Combine($vault, 'graph', 'exports', 'cytoscape.json')) | ConvertFrom-Json
    $node = @($g.nodes | Where-Object { $_.data.id -eq 'plain' })[0]
    Assert-Equal 0 (@($node.data.provenance)).Count 'an empty stamp became a set member'
  } finally {
    Remove-Item -LiteralPath $vault -Recurse -Force -ErrorAction SilentlyContinue
  }
}

It 'D37 - the provenance key list is ONE list, not repeated per stage' {
  # The generic remedy: "prefer carrying unknown fields through a merge over
  # enumerating known ones". A second enumeration somewhere else is a second
  # place to forget, which is how the field died the first time.
  $exp = [IO.File]::ReadAllText([IO.Path]::Combine($ScriptDir, 'graph-export.ps1'))
  Assert-True ($exp -match '\$ProvenanceKeys\s*=\s*@\(') 'the provenance keys are not declared as one list'
  $assignments = @([regex]::Matches($exp, '\$ProvenanceKeys\s*=\s*@\('))
  Assert-Equal 1 $assignments.Count 'the provenance key list is declared more than once'
}

# ─────────────────────────────────────────────────────────────────────────────
Write-Host ""
if ($script:Fail -gt 0) {
  Write-Host "$($script:Fail) failed, $($script:Pass) passed" -ForegroundColor Red
  exit 1
}
Write-Host "$($script:Pass) passed" -ForegroundColor Green
exit 0
