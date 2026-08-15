# SPDX-License-Identifier: Apache-2.0
<#
.SYNOPSIS
  The classifier's absence tests: gate/path-floor (D4), gate/key-shapes (D5),
  the OCR floor (I16), banding (D24), and PARITY with the TypeScript binding.

.DESCRIPTION
  BUILD-PLAN.md M2's verify names this file explicitly: "`Classify.ps1` floors a
  secret-shaped file to `local_only` (write that test first)."

  The parity block at the bottom is the one that matters most in the long run.
  Everything else here checks that THIS binding is correct; parity checks that
  it has not DIVERGED from the other one — and divergence, not incorrectness,
  is what ROADMAP E1 documents as the failure that "fails open in at least one
  of them".

.EXAMPLE
  pwsh -NoProfile -File automation/scripts/lib/Classify.test.ps1
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. "$PSScriptRoot/Classify.ps1"

$InstallRoot = (Resolve-Path "$PSScriptRoot/../../..").Path
$script:Pass = 0
$script:Fail = 0
$script:Failures = New-Object System.Collections.ArrayList

function It {
  param([Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][scriptblock]$Body)
  try {
    & $Body
    $script:Pass++
    Write-Host "  ok   $Name" -ForegroundColor DarkGreen
  } catch {
    $script:Fail++
    [void]$script:Failures.Add("$Name`n       $($_.Exception.Message)")
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

function ConvertTo-FileUrl {
  <#
  .SYNOPSIS
    An absolute path as a file:// URL, for Node's ESM loader.
  .DESCRIPTION
    Node refuses a bare Windows absolute path in an `import` specifier:
    ERR_UNSUPPORTED_ESM_URL_SCHEME, "Received protocol 'c:'". A drive letter
    looks like a URL scheme. Portability details like this are exactly what a
    cross-platform test harness has to own rather than discover on the one OS
    that breaks.
  #>
  param([Parameter(Mandatory)][string]$Path)
  return ([Uri]::new((Resolve-Path -LiteralPath $Path).Path).AbsoluteUri)
}

Write-Host "`nClassify.ps1 - the absence tests" -ForegroundColor Cyan

# ─────────────────────────────────────────────────────────────────────────────
Write-Host "`nD5 - gate/key-shapes" -ForegroundColor Cyan
# ─────────────────────────────────────────────────────────────────────────────

It "the pattern set loads and is content-hashed (I15)" {
  $set = Get-PatternSet -InstallRoot $InstallRoot
  Assert-True ($set.Hash -match '^[a-f0-9]{64}$') "hash was '$($set.Hash)'"
  Assert-True (@($set.Rules).Count -ge 13) "only $(@($set.Rules).Count) rules"
}

It "EVERY rule matches its own declared fixture - no dead rules" {
  # D4's rule applied to D5's list. A rule that matches nothing looks exactly
  # like a rule protecting a clean corpus.
  $r = Test-PatternSelfCoverage -InstallRoot $InstallRoot
  Assert-True ($r.DeadRules.Count -eq 0) "dead rules: $($r.DeadRules -join ', ')"
}

It "no definite rule matches a benign string" {
  $r = Test-PatternSelfCoverage -InstallRoot $InstallRoot
  Assert-True ($r.FalsePositives.Count -eq 0) "false positives: $($r.FalsePositives -join '; ')"
}

It "the shapes that were STRUCTURALLY UNMATCHABLE upstream all floor now" {
  # `sk-[A-Za-z0-9]{20,}` cannot match either of the first two: the hyphen ends
  # the character run after three characters.
  $planted = @(
    'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789',
    'sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345',
    'nvapi-abcdefghijklmnopqrstuvwxyz0123456789',
    'gsk_abcdefghijklmnopqrstuvwxyz0123456789',
    'AIzaSyAbcdefghijklmnopqrstuvwxyz0123456',
    'github_pat_11ABCDEFG0abcdefghijklmnop',
    'hf_abcdefghijklmnopqrstuvwxyz0123456789',
    'AKIAIOSFODNN7EXAMPLE'
  )
  foreach ($p in $planted) {
    $r = Invoke-Classify -Text "token: $p" -InstallRoot $InstallRoot
    Assert-Equal 'local_only' $r.Tier "shape '$($p.Substring(0,12))...' did not floor"
    Assert-True $r.Blocking "shape '$($p.Substring(0,12))...' did not block"
  }
}

It "'sk-learning-and-development-notes' is NOT a key" {
  # A real false-positive candidate from the source corpus.
  $r = Invoke-Classify -Text 'See sk-learning-and-development-notes for the L&D plan.' -InstallRoot $InstallRoot
  Assert-True (-not $r.Blocking) "blocked a benign identifier"
  Assert-Equal 'review_required' $r.Tier
}

It "a finding never logs the finding" {
  $r = Invoke-Classify -Text 'key=sk-proj-SUPERSECRETVALUE0123456789abcdef' -InstallRoot $InstallRoot
  foreach ($h in $r.Hits) {
    Assert-True (-not $h.Redacted.Contains('SUPERSECRETVALUE')) "the redacted form leaked the secret"
  }
  Assert-True (-not ($r.Reasons -join ' ').Contains('SUPERSECRETVALUE')) "a reason string leaked the secret"
}

# ─────────────────────────────────────────────────────────────────────────────
Write-Host "`nD4 - gate/path-floor" -ForegroundColor Cyan
# ─────────────────────────────────────────────────────────────────────────────

It "the PARA number prefix is stripped - the bug that made the band dead code" {
  Assert-Equal 'identity/accounts/x.md' (Get-NormalizedFloorPath '11-identity/accounts/x.md')
  Assert-Equal 'vault/identity/accounts/x.md' (Get-NormalizedFloorPath 'vault/11-identity/03-accounts/x.md')
  Assert-Equal 'identity/accounts/x.md' (Get-NormalizedFloorPath '11-identity\accounts\x.md')
}

It "8 paths that MUST floor to secret on their path alone" {
  $mustFloor = @(
    'vault/11-identity/accounts/bank.md',
    'vault/identity/credentials/aws.md',
    'vault/05-finance/2026-tax.md',
    'vault/07-health/bloodwork.md',
    'vault/medical/notes.md',
    'vault/09-legal/personal/will.md',
    'keys/deploy.md',
    'vault/state/secrets/store.md'
  )
  foreach ($p in $mustFloor) {
    $r = Invoke-Classify -Text 'nothing sensitive-looking here at all' -RelPath $p -InstallRoot $InstallRoot
    Assert-Equal 'local_only' $r.Tier "$p did not floor"
    Assert-True $r.Blocking "$p did not block"
  }
}

It "4 ordinary paths that must NOT floor" {
  $mustNot = @(
    'vault/03-areas/guitar-practice.md',
    'vault/02-projects/sutra/isa.md',
    'vault/04-resources/reaper-shortcuts.md',
    'compiled/pages/src-2026-000001.md'
  )
  foreach ($p in $mustNot) {
    $r = Invoke-Classify -Text 'ordinary content' -RelPath $p -InstallRoot $InstallRoot
    Assert-Equal 'review_required' $r.Tier "$p floored when it should not"
  }
}

It "floor matching is on SEGMENT boundaries, not substrings" {
  $set = Get-PatternSet -InstallRoot $InstallRoot
  Assert-Equal $null (Test-FloorPath -RelPath 'vault/identity/accounts-public/x.md' -FloorPaths $set.FloorPaths)
  Assert-Equal $null (Test-FloorPath -RelPath 'vault/03-areas/my-finance-notes.md' -FloorPaths $set.FloorPaths)
  # …and the positive control, so this cannot pass by matching nothing:
  Assert-Equal 'identity/accounts' (Test-FloorPath -RelPath 'vault/11-identity/accounts/x.md' -FloorPaths $set.FloorPaths)
}

# ─────────────────────────────────────────────────────────────────────────────
Write-Host "`nI16 - the OCR floor" -ForegroundColor Cyan
# ─────────────────────────────────────────────────────────────────────────────

It "an OCR extract floors even when its text is entirely benign" {
  $set = Get-PatternSet -InstallRoot $InstallRoot
  $benign = 'Quarterly planning notes. Nothing sensitive here.'
  $typed = Invoke-Classify -Text $benign -ExtractEngine 'trafilatura' -InstallRoot $InstallRoot
  Assert-Equal 'review_required' $typed.Tier "typed text should not floor"
  foreach ($engine in $set.OcrEngines) {
    $r = Invoke-Classify -Text $benign -ExtractEngine $engine -InstallRoot $InstallRoot
    Assert-Equal 'local_only' $r.Tier "engine '$engine' did not floor"
  }
}

It "engine matching is case-insensitive and whitespace-tolerant" {
  $r = Invoke-Classify -Text 'x' -ExtractEngine '  Tesseract ' -InstallRoot $InstallRoot
  Assert-Equal 'local_only' $r.Tier
}

# ─────────────────────────────────────────────────────────────────────────────
Write-Host "`nD24 / I17 - banding" -ForegroundColor Cyan
# ─────────────────────────────────────────────────────────────────────────────

It "NO heuristic rule can produce a blocking result" {
  $set = Get-PatternSet -InstallRoot $InstallRoot
  $heuristics = @($set.Rules | Where-Object { $_.band -eq 'heuristic' })
  Assert-True ($heuristics.Count -gt 0) "the set contains no heuristics, so this proves nothing"
  foreach ($rule in $heuristics) {
    $r = Invoke-Classify -Text $rule.fixture -InstallRoot $InstallRoot
    Assert-True (-not $r.Blocking) "heuristic rule $($rule.id) produced a BLOCKING result"
  }
}

It "a heuristic still FLOORS the tier - safe when wrong" {
  # The regression fixture named in D24: an identifier-shaped literal password
  # must floor. An attempt to tighten this rule was written and then REVERTED,
  # because the tightened version traded a harmless false positive for a
  # harmful false negative.
  $r = Invoke-Classify -Text 'password = dbutler_prod_9x2Kq' -InstallRoot $InstallRoot
  Assert-Equal 'local_only' $r.Tier "an identifier-shaped literal password must still floor"
  Assert-True (-not $r.Blocking) "…and must still not block"
}

# ─────────────────────────────────────────────────────────────────────────────
Write-Host "`nI14 - raise-only" -ForegroundColor Cyan
# ─────────────────────────────────────────────────────────────────────────────

It "the classifier never LOWERS an existing tier" {
  $r = Invoke-Classify -Text 'the weather is nice' -RelPath 'vault/03-areas/weather.md' -CurrentTier 'secret' -InstallRoot $InstallRoot
  Assert-Equal 'local_only' $r.Tier "an already-secret note was downscoped by a clean scan"
}

It "Get-RaisedTier is total over every tier pair - no combination lowers" {
  $tiers = @('hosted_allowed', 'review_required', 'local_only')
  foreach ($from in $tiers) {
    foreach ($to in $tiers) {
      $result = Get-RaisedTier -Current $from -Proposed $to
      Assert-True ((Get-TierRank $result) -ge (Get-TierRank $from)) "Get-RaisedTier($from, $to) = $result lowered the tier"
    }
  }
}

It "D20 - both spellings behave identically through every comparison" {
  foreach ($pair in @(@('public','hosted_allowed'), @('private','review_required'), @('secret','local_only'))) {
    Assert-Equal (Resolve-Tier $pair[0]) (Resolve-Tier $pair[1]) "$($pair[0]) vs $($pair[1])"
    Assert-Equal (Get-TierRank $pair[0]) (Get-TierRank $pair[1])
    Assert-Equal (Get-TierDisplay $pair[0]) (Get-TierDisplay $pair[1])
  }
}

It "Get-StrictestTier of an EMPTY set is private, not public" {
  Assert-Equal 'review_required' (Get-StrictestTier @())
}

It "E1 - one do_not_learn predicate, generous on true, strict on false" {
  foreach ($t in @($true, 'true', 'TRUE', ' True ', 'yes', '1')) { Assert-True (Test-DoNotLearn $t) "'$t' should be true" }
  foreach ($f in @($false, 'false', '', 'no', '0', $null)) { Assert-True (-not (Test-DoNotLearn $f)) "'$f' should be false" }
}

# ─────────────────────────────────────────────────────────────────────────────
Write-Host "`nD6 - the scanner fails CLOSED" -ForegroundColor Cyan
# ─────────────────────────────────────────────────────────────────────────────

It "a missing pattern set THROWS rather than classifying with no rules" {
  $empty = [IO.Path]::Combine([IO.Path]::GetTempPath(), "sutra-nopatterns-$([guid]::NewGuid())")
  New-Item -ItemType Directory -Path $empty -Force | Out-Null
  $threw = $false
  try { Get-PatternSet -InstallRoot $empty } catch { $threw = $true }
  Remove-Item -LiteralPath $empty -Recurse -Force -ErrorAction SilentlyContinue
  Assert-True $threw "a scanner with an empty list reports every file clean - the most dangerous failure here"
}

# ─────────────────────────────────────────────────────────────────────────────
Write-Host "`nE1 - PARITY with the TypeScript binding" -ForegroundColor Cyan
# ─────────────────────────────────────────────────────────────────────────────
#
# The test that matters most over time. Everything above checks that THIS
# binding is correct; this checks it has not DIVERGED from the other one.
#
# "Six re-implementations of one tier comparison across three languages, and
#  five different do_not_learn predicates - every divergence fails open in at
#  least one of them."
#
# Both bindings are handed the same inputs and must return the same tier and the
# same blocking decision. A divergence here is a governance hole, not a style
# difference.

It "PS and TS classify an identical corpus identically" {
  $node = Get-Command node -ErrorAction SilentlyContinue
  $coreDist = [IO.Path]::Combine($InstallRoot, 'packages', 'core', 'dist', 'gate', 'patterns.js')
  if (-not $node -or -not (Test-Path -LiteralPath $coreDist)) {
    Write-Host "       (skipped - node or the built core is unavailable on this node)" -ForegroundColor DarkYellow
    return
  }

  # One shared fixture table. Adding a case here tests BOTH bindings at once,
  # which is the property that keeps them from drifting apart.
  $cases = @(
    @{ text = 'token: sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345'; path = ''; engine = ''; current = '' },
    @{ text = 'token: sk-proj-abcdefghijklmnopqrstuvwxyz0123456789';  path = ''; engine = ''; current = '' },
    @{ text = 'See sk-learning-and-development-notes for the plan.';  path = ''; engine = ''; current = '' },
    @{ text = 'ordinary content';                path = 'vault/11-identity/accounts/bank.md'; engine = ''; current = '' },
    @{ text = 'ordinary content';                path = 'vault/03-areas/guitar.md'; engine = ''; current = '' },
    @{ text = 'ordinary content';                path = 'vault/identity/accounts-public/x.md'; engine = ''; current = '' },
    @{ text = 'benign quarterly notes';          path = ''; engine = 'tesseract'; current = '' },
    @{ text = 'benign quarterly notes';          path = ''; engine = 'trafilatura'; current = '' },
    @{ text = 'password = dbutler_prod_9x2Kq';   path = ''; engine = ''; current = '' },
    @{ text = 'the weather is nice';             path = 'vault/03-areas/weather.md'; engine = ''; current = 'secret' },
    @{ text = 'nothing here';                    path = ''; engine = ''; current = 'public' }
  )

  $script = @'
import { loadPatternSet, classify } from "PATTERNS_JS";
const root = process.argv[2];
const cases = JSON.parse(process.argv[3]);
const patterns = loadPatternSet(root);
const out = cases.map((c) => {
  const r = classify({
    text: c.text,
    relPath: c.path || undefined,
    extractEngine: c.engine || null,
    currentTier: c.current || undefined,
  }, patterns);
  return { tier: r.tier, blocking: r.blocking };
});
process.stdout.write(JSON.stringify(out));
'@ -replace 'PATTERNS_JS', (ConvertTo-FileUrl $coreDist)

  $tmp = [IO.Path]::Combine([IO.Path]::GetTempPath(), "sutra-parity-$([guid]::NewGuid()).mjs")
  [IO.File]::WriteAllText($tmp, $script)
  try {
    $tsJson = & node $tmp $InstallRoot (ConvertTo-Json $cases -Compress -Depth 5)
    $ts = $tsJson | ConvertFrom-Json
  } finally {
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
  }

  for ($i = 0; $i -lt $cases.Count; $i++) {
    $c = $cases[$i]
    $ps = Invoke-Classify -Text $c.text -RelPath $c.path -ExtractEngine $c.engine -CurrentTier $c.current -InstallRoot $InstallRoot
    $label = "case $i (text='$($c.text.Substring(0, [Math]::Min(30, $c.text.Length)))...', path='$($c.path)', engine='$($c.engine)')"
    Assert-Equal $ts[$i].tier $ps.Tier "TIER DIVERGENCE on $label - PS said '$($ps.Tier)', TS said '$($ts[$i].tier)'"
    Assert-Equal $ts[$i].blocking $ps.Blocking "BLOCKING DIVERGENCE on $label"
  }
}

It "PS and TS agree on the pattern-set hash - they are reading the SAME file" {
  $node = Get-Command node -ErrorAction SilentlyContinue
  $coreDist = [IO.Path]::Combine($InstallRoot, 'packages', 'core', 'dist', 'gate', 'patterns.js')
  if (-not $node -or -not (Test-Path -LiteralPath $coreDist)) { return }

  $script = "import { loadPatternSet } from '$(ConvertTo-FileUrl $coreDist)'; process.stdout.write(loadPatternSet(process.argv[2]).hash);"
  $tmp = [IO.Path]::Combine([IO.Path]::GetTempPath(), "sutra-hash-$([guid]::NewGuid()).mjs")
  [IO.File]::WriteAllText($tmp, $script)
  try { $tsHash = & node $tmp $InstallRoot } finally { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }

  $psHash = (Get-PatternSet -InstallRoot $InstallRoot).Hash
  Assert-Equal $tsHash $psHash "the two bindings hashed DIFFERENT files - they are not sharing one policy"
}

# ─────────────────────────────────────────────────────────────────────────────
Write-Host ""
if ($script:Fail -gt 0) {
  Write-Host "$($script:Fail) failed, $($script:Pass) passed" -ForegroundColor Red
  exit 1
}
Write-Host "$($script:Pass) passed" -ForegroundColor Green
exit 0
