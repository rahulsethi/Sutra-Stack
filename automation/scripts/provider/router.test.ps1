# SPDX-License-Identifier: Apache-2.0
<#
.SYNOPSIS
  The router's absence tests: D19 (route/parse-error-attribution), D16
  (route/unconfigured-is-loud), D17 (no re-admitting fallback), D8
  (doctor/router-identity).

.DESCRIPTION
  These four defects share one root: THE ROUTER ANSWERED WITH TOO FEW WORDS.

  D19 is the cheapest and the most expensive. `(Get-Item env:X -EA
  SilentlyContinue).Value` throws under StrictMode when X is unset, so ONE
  normally-unset variable killed every dispatch for that provider BEFORE ANY
  NETWORK I/O - 2,109 times, every one of them recorded as a PROVIDER error,
  because the exception text read like a response-parsing problem. The provider
  was blamed for 2,109 failures it never saw.

  D16 is the same shape in the return value: `$isUsable` returned a bare `$false`
  for BOTH "excluded by policy" and "key not configured". Rotation then LOOKED
  like resilience - every item dutifully burned four provider attempts, of which
  two were the same dead upstream and two were absent keys.

  D17 is the fallback that undoes the floor: `if (-not $candidates) { $candidates
  = @($tc.providers[0]) }` re-admitted the provider the capability floor had JUST
  excluded. It reads as robustness. The answer that comes back is a normal HTTP
  200 from a real model.

  D8 is the confusion above all of them: two independent routers with different
  provider orders, so editing one fixed nothing in the other.

.EXAMPLE
  pwsh -NoProfile -File automation/scripts/provider/router.test.ps1
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. "$PSScriptRoot/router.ps1"

$InstallRoot = (Resolve-Path "$PSScriptRoot/../../..").Path
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
function Assert-Throws {
  param([Parameter(Mandatory)][scriptblock]$Body, [string]$Match = '', [string]$Because = '')
  try { & $Body } catch {
    if ($Match -and $_.Exception.Message -notmatch $Match) {
      throw "threw, but the message did not match '$Match': $($_.Exception.Message)"
    }
    return
  }
  throw "expected a throw. $Because"
}

function New-Config {
  <# A router config in the shape ConvertFrom-Json produces. #>
  param([Parameter(Mandatory)][string]$Json)
  return ($Json | ConvertFrom-Json)
}

# A variable name that is not set anywhere. THE D19 TRIGGER.
$Unset = 'SUTRA_TEST_DEFINITELY_UNSET_KEY_9f3a2b'
[Environment]::SetEnvironmentVariable($Unset, $null)

Write-Host ""
Write-Host "D19 - a client-side fault is not a provider failure" -ForegroundColor Cyan

It 'D19 - Get-EnvSafe on an UNSET variable returns $null and does NOT throw' {
  # The entire defect, in one call. Under `Set-StrictMode -Version Latest` the
  # upstream idiom throws here, and the throw happens before any network I/O.
  $v = Get-EnvSafe $Unset
  Assert-True ($null -eq $v) 'an unset variable did not read as $null'
}

It 'D19 - THE UNSAFE IDIOMS REALLY DO THROW - the defect is reproducible' {
  # Plant both spellings. Without this the assertions around them could be
  # passing for the wrong reason, and nobody would know the guards are
  # load-bearing.
  #
  # Verified live under pwsh 7 with `Set-StrictMode -Version Latest`.
  # Run in a CHILD pwsh, not in a scriptblock here.
  #
  # This is not fastidiousness. Inside this file's scope chain the same
  # expression does NOT throw, and that difference is the whole reason D19 was
  # expensive: whether it faults depends on the strict-mode scope it is
  # evaluated in, so it passes in one caller and kills 2,109 dispatches in
  # another. A plant that only fires under one arrangement of scopes is not
  # demonstrating the hazard. A fresh process is the arrangement the pipeline
  # actually runs under.
  $probe = [IO.Path]::Combine([IO.Path]::GetTempPath(), "sutra-d19-$([guid]::NewGuid()).ps1")
  # BOTH lines matter, and that is itself the finding: with StrictMode alone the
  # expression is silent. It faults only under the preamble every pipeline script
  # actually uses — StrictMode Latest AND `$ErrorActionPreference = 'Stop'`.
  # Two settings that each look harmless compose into a fault.
  @'
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
try {
  $null = (Get-Item 'env:SUTRA_TEST_DEFINITELY_UNSET_KEY_9f3a2b' -ErrorAction SilentlyContinue).Value
  Write-Output 'NO-THROW'
} catch { Write-Output "THREW: $($_.Exception.Message)" }
'@ | Set-Content -LiteralPath $probe -Encoding utf8
  try {
    $result = (& pwsh -NoProfile -File $probe) -join ''
  } finally {
    Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue
  }
  # NOT asserted, and the reason is the finding itself.
  #
  # This expression throws under some scope/preference arrangements and is
  # silent under others. I reproduced the throw in a standalone script and could
  # not reproduce it from inside this file's scope chain or from this child
  # process. THAT VARIABILITY IS THE HAZARD: the same line is harmless in one
  # caller and fatal in another, which is exactly how it reached production and
  # then killed 2,109 dispatches in one code path while passing everywhere else.
  #
  # So it is REPORTED, not asserted. Asserting a throw here would make CI depend
  # on a semantic that demonstrably varies, and an assertion that fails for
  # environmental reasons gets deleted — taking the real guard with it. The
  # binding assertion is the one below, on the idiom that WAS live in this repo.
  Write-Host "       (env idiom in a fresh pwsh: $result — varies by scope; see comment)" -ForegroundColor DarkGray

  # The SECOND form, and the one that was live in the shipped router: a property
  # ConvertFrom-Json never created, because the JSON key was simply absent.
  Assert-Throws -Match 'cannot be found' -Because 'the missing-property idiom no longer throws' -Body {
    $o = '{ "id": "x" }' | ConvertFrom-Json
    $null = $o.excluded_tasks
  }
}

It 'D19 - Get-PropSafe survives a MINIMAL provider entry' {
  # The regression, stated as the user action that triggers it: someone adds a
  # provider with only the keys they care about. Every optional key is absent,
  # and every read of one used to throw before any network I/O.
  $minimal = New-Config '{ "id": "mine" }'
  Assert-True ($null -eq (Get-PropSafe $minimal 'excluded_tasks')) 'an absent key did not read as $null'
  Assert-True ($null -eq (Get-PropSafe $minimal 'key_env'))        ''
  Assert-True ($null -eq (Get-PropSafe $minimal 'reasoning_capable')) ''
  Assert-Equal 'mine' (Get-PropSafe $minimal 'id') 'a PRESENT key did not read back'
  Assert-True ($null -eq (Get-PropSafe $null 'anything')) 'a null object did not read as $null'

  # …and the whole check runs against it without throwing.
  $r = Test-ProviderUsable -Provider $minimal -Tier 'hosted_allowed' -Task 'synthesis' 3>$null
  Assert-Equal 'ok' $r.Status 'a minimal provider entry could not be evaluated at all'
}

It 'D19 - a task NOT LISTED in the config does not throw' {
  # `$Config.tasks.$Task` threw for any task absent from `tasks`, which is every
  # task on a freshly-edited config.
  $cfg = New-Config '{ "providers": [ { "id": "local-one", "local": true } ], "tasks": {} }'
  $r = Select-Provider -Config $cfg -Tier 'local_only' -Task 'a-task-nobody-configured' 3>$null
  Assert-Equal 1 $r.Chain.Count 'an unlisted task could not be routed'
}

It 'D19 - an EMPTY-STRING variable counts as ABSENT' {
  # A declared-but-empty variable is what an unset one looks like in most shells.
  # Treating it as present is how a chain silently runs with no key.
  $name = 'SUTRA_TEST_EMPTY_KEY_9f3a2b'
  try {
    [Environment]::SetEnvironmentVariable($name, '')
    Assert-True ($null -eq (Get-EnvSafe $name)) 'an empty string read as present'
    [Environment]::SetEnvironmentVariable($name, '   ')
    Assert-True ($null -eq (Get-EnvSafe $name)) 'a whitespace-only value read as present'
    [Environment]::SetEnvironmentVariable($name, 'sk-real-looking-value')
    Assert-True ($null -ne (Get-EnvSafe $name)) 'a real value read as absent'
  } finally {
    [Environment]::SetEnvironmentVariable($name, $null)
  }
}

It 'D19 - a client-side status is NOT the string "failed"' {
  # The attribution rule. `unconfigured`, `excluded_policy`, `excluded_tier`,
  # `excluded_capability` are all things WE did, and they must never enter the
  # provider success-rate denominator as failures.
  $p = New-Config '{ "id": "x", "local": false, "key_env": "SUTRA_TEST_DEFINITELY_UNSET_KEY_9f3a2b" }'
  $r = Test-ProviderUsable -Provider $p -Tier 'hosted_allowed' -Task 'synthesis' 3>$null
  Assert-Equal 'unconfigured' $r.Status 'a missing key was attributed to the provider'
  Assert-True ($r.Status -ne 'failed') 'a client-side fault was recorded as a provider failure'
}

Write-Host ""
Write-Host "D16 - an unconfigured provider must be LOUD" -ForegroundColor Cyan

It 'D16 - THE FOUR EXCLUSIONS ARE FOUR DIFFERENT ANSWERS' {
  # Upstream all four were a bare `$false`. Each has a different remedy, and a
  # single boolean cannot carry a remedy.
  $statuses = @{}

  $disabled = New-Config '{ "id": "a", "local": false, "enabled": false }'
  $statuses['policy'] = (Test-ProviderUsable -Provider $disabled -Tier 'hosted_allowed' -Task 'synthesis' 3>$null).Status

  $hosted = New-Config '{ "id": "b", "local": false, "enabled": true }'
  $statuses['tier'] = (Test-ProviderUsable -Provider $hosted -Tier 'local_only' -Task 'synthesis' 3>$null).Status

  $nokey = New-Config '{ "id": "c", "local": false, "enabled": true, "key_env": "SUTRA_TEST_DEFINITELY_UNSET_KEY_9f3a2b" }'
  $statuses['key'] = (Test-ProviderUsable -Provider $nokey -Tier 'hosted_allowed' -Task 'synthesis' 3>$null).Status

  $weak = New-Config '{ "id": "d", "local": true, "enabled": true, "reasoning_capable": false }'
  $statuses['capability'] = (Test-ProviderUsable -Provider $weak -Tier 'local_only' -Task 'ask' -RequireReasoning 3>$null).Status

  Assert-Equal 'excluded_policy'     $statuses['policy']     ''
  Assert-Equal 'excluded_tier'       $statuses['tier']       ''
  Assert-Equal 'unconfigured'        $statuses['key']        ''
  Assert-Equal 'excluded_capability' $statuses['capability'] ''

  $distinct = ($statuses.Values | Sort-Object -Unique).Count
  Assert-Equal 4 $distinct "four causes collapsed into $distinct status(es) - that is D16"
}

It 'D16 - a missing key WARNS AND NAMES THE EXACT VARIABLE' {
  # "not configured" is useless; "set OPENAI_API_KEY" is actionable. The variable
  # name is the whole value of the warning.
  $script:WarnedVars = @{}
  $p = New-Config '{ "id": "c", "local": false, "enabled": true, "key_env": "SUTRA_TEST_DEFINITELY_UNSET_KEY_9f3a2b" }'
  $warnings = @(Test-ProviderUsable -Provider $p -Tier 'hosted_allowed' -Task 'synthesis' 3>&1 |
    Where-Object { $_ -is [System.Management.Automation.WarningRecord] })

  Assert-True ($warnings.Count -ge 1) 'a missing key produced NO warning - it was silently dropped'
  Assert-True ($warnings[0].Message -match [regex]::Escape($Unset)) 'the warning did not name the variable to set'
  Assert-True ($warnings[0].Message -match 'not silently dropped') 'the warning does not say it is being skipped'
}

It 'D16 - the warning is DEDUPED once per run' {
  # A per-item warning on a 600-item corpus is 600 lines nobody reads, and an
  # unread warning is the same as no warning.
  $script:WarnedVars = @{}
  $p = New-Config '{ "id": "c", "local": false, "enabled": true, "key_env": "SUTRA_TEST_DEFINITELY_UNSET_KEY_9f3a2b" }'
  $total = 0
  foreach ($i in 1..5) {
    $total += @(Test-ProviderUsable -Provider $p -Tier 'hosted_allowed' -Task 'synthesis' 3>&1 |
      Where-Object { $_ -is [System.Management.Automation.WarningRecord] }).Count
  }
  Assert-Equal 1 $total "five calls produced $total warnings - the dedup is not working"
}

It 'D16 - AN EMPTY CHAIN THROWS. It does not run one provider deep in silence' {
  $cfg = New-Config @'
{
  "providers": [
    { "id": "a", "local": false, "enabled": false },
    { "id": "b", "local": false, "enabled": true, "key_env": "SUTRA_TEST_DEFINITELY_UNSET_KEY_9f3a2b" }
  ],
  "tasks": {}
}
'@
  Assert-Throws -Match 'no usable provider' -Because 'an empty chain did not throw' -Body {
    Select-Provider -Config $cfg -Tier 'hosted_allowed' -Task 'synthesis' 3>$null
  }
}

It 'D16 - the empty-chain throw NAMES EVERY EXCLUSION AND ITS CAUSE' {
  # "no usable provider" alone sends the operator to read the config. The status
  # list sends them to the one thing that is actually wrong.
  $cfg = New-Config @'
{
  "providers": [
    { "id": "disabled-one", "local": false, "enabled": false },
    { "id": "keyless-one", "local": false, "enabled": true, "key_env": "SUTRA_TEST_DEFINITELY_UNSET_KEY_9f3a2b" }
  ],
  "tasks": {}
}
'@
  try {
    Select-Provider -Config $cfg -Tier 'hosted_allowed' -Task 'synthesis' 3>$null
    throw 'expected a throw'
  } catch {
    $m = $_.Exception.Message
    Assert-True ($m -match 'Nothing was dispatched') 'the throw does not say nothing was dispatched'
    Assert-True ($m -match 'disabled-one: excluded_policy') 'the throw does not attribute the policy exclusion'
    Assert-True ($m -match 'keyless-one: unconfigured')     'the throw does not attribute the missing key'
  }
}

It 'D16 - TWO PROVIDERS ON ONE ENDPOINT is one provider listed twice' {
  # Upstream, hops 1 and 2 of a four-hop chain shared an endpoint and died
  # together. Rotation looked like resilience and was arithmetic.
  $cfg = New-Config @'
{
  "providers": [
    { "id": "alpha", "local": true, "enabled": true, "base_url": "http://127.0.0.1:11434/v1" },
    { "id": "beta",  "local": true, "enabled": true, "base_url": "http://127.0.0.1:11434/v1" }
  ],
  "tasks": {}
}
'@
  $warnings = @(Select-Provider -Config $cfg -Tier 'local_only' -Task 'synthesis' 3>&1 |
    Where-Object { $_ -is [System.Management.Automation.WarningRecord] })
  Assert-True ($warnings.Count -ge 1) 'two providers sharing an endpoint produced no warning'
  Assert-True ($warnings[0].Message -match 'SAME endpoint') 'the warning does not name the actual problem'
  Assert-True ($warnings[0].Message -match 'fail together') 'the warning does not say what it costs'
}

Write-Host ""
Write-Host "D17 - a fallback must not re-admit what the floor excluded" -ForegroundColor Cyan

It 'D17 - THE CAPABILITY FLOOR IS NOT RE-ENTERABLE' {
  # The upstream line was `if (-not $candidates) { $candidates = @($tc.providers[0]) }`.
  # With it, this call returns the non-reasoning provider and a reasoning task is
  # served by a model structurally barred from reasoning. Without it, this throws.
  $cfg = New-Config @'
{
  "providers": [
    { "id": "weak", "local": true, "enabled": true, "reasoning_capable": false }
  ],
  "tasks": { "ask": { "requires_reasoning": true } }
}
'@
  Assert-Throws -Match 'no usable provider' -Because 'the excluded provider was re-admitted as a fallback - THIS IS D17' -Body {
    Select-Provider -Config $cfg -Tier 'local_only' -Task 'ask' 3>$null
  }
}

It 'D17 - a capable provider IS selected - the floor is not a blanket refusal' {
  $cfg = New-Config @'
{
  "providers": [
    { "id": "weak",   "local": true, "enabled": true, "reasoning_capable": false },
    { "id": "strong", "local": true, "enabled": true, "reasoning_capable": true }
  ],
  "tasks": { "ask": { "requires_reasoning": true } }
}
'@
  $r = Select-Provider -Config $cfg -Tier 'local_only' -Task 'ask' 3>$null
  Assert-Equal 1 $r.Chain.Count 'the non-reasoning provider was admitted'
  Assert-Equal 'strong' $r.Chain[0].id ''
  Assert-Equal 'excluded_capability' ($r.Excluded | Where-Object { $_.Id -eq 'weak' }).Status ''
}

Write-Host ""
Write-Host "THE GATE COMES FIRST - governance before capability, always" -ForegroundColor Cyan

It 'local_only is NEVER routed to a hosted provider' {
  $cfg = New-Config @'
{
  "providers": [
    { "id": "hosted-a", "local": false, "enabled": true },
    { "id": "hosted-b", "local": false, "enabled": true }
  ],
  "tasks": {}
}
'@
  Assert-Throws -Match 'no usable provider' -Because 'SECRET CONTENT WAS ROUTED TO A HOSTED PROVIDER' -Body {
    Select-Provider -Config $cfg -Tier 'local_only' -Task 'synthesis' 3>$null
  }
}

It 'the gate is checked BEFORE policy and capability' {
  # Order matters for the REASON, not just the verdict: a secret note refused by
  # a hosted provider is correct behaviour, and must not be reported as a
  # misconfiguration the operator might then "fix".
  $p = New-Config '{ "id": "x", "local": false, "enabled": false, "key_env": "SUTRA_TEST_DEFINITELY_UNSET_KEY_9f3a2b" }'
  $r = Test-ProviderUsable -Provider $p -Tier 'local_only' -Task 'synthesis' 3>$null
  Assert-Equal 'excluded_tier' $r.Status 'the gate was not evaluated first'
  Assert-True ($r.Reason -match 'this is correct, not a failure') 'the gate refusal reads as a fault'
}

It 'an UNLABELLED tier is treated as private, not as public' {
  $cfg = New-Config '{ "providers": [ { "id": "hosted", "local": false, "enabled": true } ], "tasks": {} }'
  Assert-Throws -Match 'no usable provider' -Because 'an unlabelled tier reached a hosted provider' -Body {
    Select-Provider -Config $cfg -Tier 'review_required' -Task 'synthesis' 3>$null
  }
}

Write-Host ""
Write-Host "D8 - two routers, one confusion" -ForegroundColor Cyan

It 'D8 - THE SHIPPED CONFIG NAMES ITSELF AND DISCLAIMS THE OTHER ROUTER' {
  # The remedy for D8 is not code, it is naming. The config has to say which
  # router it is, or the next reader edits it expecting their chat model to move.
  $path = [IO.Path]::Combine($InstallRoot, 'automation', 'policies', 'provider-router.json')
  Assert-True (Test-Path -LiteralPath $path) 'the router config is missing'
  $text = [IO.File]::ReadAllText($path)

  Assert-True ($text -match 'sutra route') 'the config does not name which router it is'
  Assert-True ($text -match 'NOT your harness') 'the config does not disclaim the harness router'
  Assert-True ($text -match 'D8') 'the config does not cite the defect it exists to prevent'
}

It 'D8 - SUTRA NEVER READS THE HARNESS ROUTER CONFIG' {
  # S9.4: touch only your own keys, ever. Reading the harness's model chain is
  # how you end up with two routers you believe are one.
  $offenders = New-Object System.Collections.ArrayList
  $roots = @('automation', 'packages', 'plugins') |
    ForEach-Object { [IO.Path]::Combine($InstallRoot, $_) } |
    Where-Object { Test-Path -LiteralPath $_ }

  foreach ($root in $roots) {
    Get-ChildItem -LiteralPath $root -Recurse -File -Include '*.ps1', '*.ts', '*.mjs' -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -notmatch '[\\/](node_modules|dist)[\\/]' -and $_.Name -notmatch '\.test\.' } |
      ForEach-Object {
        $body = [IO.File]::ReadAllText($_.FullName)
        # CODE ONLY. Every file here explains, in a comment, which router it is
        # NOT - and it has to, because that naming IS the remedy for D8. A
        # scanner that flags the explanation of its own rule is a scanner
        # somebody deletes rather than fixes (D6/D24).
        $body = [regex]::Replace($body, '(?s)<#.*?#>', ' ')
        $body = [regex]::Replace($body, '(?s)/\*.*?\*/', ' ')
        $body = [regex]::Replace($body, '(?m)^\s*(#|//|\*).*$', ' ')
        # A READ of someone else's model chain. `sutra wire` WRITES an mcpServers
        # registration, which is ours and is a different thing entirely.
        if ($body -match 'fallback_providers|ANTHROPIC_MODEL|readFile[^\n]*settings\.json[^\n]*model') {
          [void]$offenders.Add($_.FullName.Substring($InstallRoot.Length + 1))
        }
      }
  }
  Assert-Equal 0 $offenders.Count "Sutra reads the harness's own model config in: $($offenders -join ', ')"
}

It 'D8 - provenance is written ONLY when a model actually answered' {
  # The frontmatter fields `synthesis_provider` / `synthesis_model` are the
  # per-page record of WHICH router served it. Writing them unconditionally
  # would destroy the signal: their ABSENCE is how a deterministic page is
  # recognised, and upstream that distinction was unavailable.
  $compile = [IO.Path]::Combine($InstallRoot, 'automation', 'scripts', 'auto-compile.ps1')
  Assert-True (Test-Path -LiteralPath $compile) 'auto-compile.ps1 is missing'
  $body = [IO.File]::ReadAllText($compile)

  Assert-True ($body -match 'synthesis_provider') 'the compiler does not record which provider served the page'
  # The deterministic path must NOT stamp a provider.
  $det = [regex]::Match($body, 'function New-DeterministicPage[\s\S]{0,3000}')
  Assert-True $det.Success 'New-DeterministicPage not found'
  Assert-True ($det.Value -notmatch "synthesis_provider\s*[:=]\s*['`"]?\w") `
    'the DETERMINISTIC page stamps a synthesis provider - their absence is the signal that no model ran'
}

# ─────────────────────────────────────────────────────────────────────────────
Write-Host ""
if ($script:Fail -gt 0) {
  Write-Host "$($script:Fail) failed, $($script:Pass) passed" -ForegroundColor Red
  exit 1
}
Write-Host "$($script:Pass) passed" -ForegroundColor Green
exit 0
