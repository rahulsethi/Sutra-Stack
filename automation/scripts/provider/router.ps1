# SPDX-License-Identifier: Apache-2.0
<#
.SYNOPSIS
  THE SYNTHESIS ROUTER. Chooses which model serves a given task at a given tier.

.DESCRIPTION
  D8 - TWO ROUTERS, ONE CONFUSION.

  The system this was extracted from had TWO independent model routers: this
  one (the pipeline's synthesis router) and the harness gateway's own
  `model:`/`fallback_providers:` chain. They had DIFFERENT provider orders.
  Editing one fixed nothing in the other, and diagnosis of a bad answer landed
  on whichever one the reader had in mind.

  So Sutra names them distinctly and never pretends there is one:

    THIS ONE          `sutra route`   - the pipeline's synthesis router.
                                        Config: automation/policies/provider-router.json
    THE HARNESS'S     not ours        - whatever Claude Code / Hermes / Codex
                                        uses for ITS chat. We do not touch it,
                                        read it, or own it (S9.4).

  `sutra doctor` displays both chains side by side, and every generated page
  records `synthesis_provider:` / `synthesis_model:` in its frontmatter - written
  ONLY when a model actually answered, so their ABSENCE is itself the signal.

  ── THE GATE COMES FIRST, ALWAYS ───────────────────────────────────────────
  Routing is a governance decision before it is a quality one. A tier that
  cannot leave the machine is not offered a hosted provider - not as a fallback,
  not under load, not when the local one is down. `Select-Provider` filters by
  tier BEFORE it considers capability, and the filter is not re-entrant.

  ── D16 · an unconfigured provider must be LOUD ────────────────────────────
  Upstream, `$isUsable` returned a bare `$false` for BOTH "excluded by policy"
  and "key not configured", and dropped the provider silently. Rotation LOOKED
  like resilience: every item dutifully burned four provider attempts, of which
  two were the same dead upstream and two were absent keys.

    * policy exclusion  -> correct, and verbose
    * missing key       -> a WARNING naming the exact environment variable,
                           deduped once per run
    * an empty chain    -> THROWS. It does not run one provider deep in silence.
    * an empty-string key counts as ABSENT, not present.

  ── D17 · a fallback must not re-admit what the floor excluded ─────────────
  The upstream line was:

      if (-not $candidates) { $candidates = @($tc.providers[0]) }

  …which re-admitted the provider the `reasoning_capable` floor had JUST
  excluded. A reasoning task could be served, silently, by a model structurally
  barred from reasoning. It reads as robustness - "never return nothing" - and
  the resulting answer is a normal HTTP 200 from a real model.

  There is no such fallback here. If every candidate fails the floor, NOTHING is
  dispatched and the failure is recorded.

  ── D19 · client-side faults are not provider failures ─────────────────────
  `(Get-Item env:X -EA SilentlyContinue).Value` throws under StrictMode when X
  is unset. One normally-unset variable meant every dispatch for that provider
  died BEFORE ANY NETWORK I/O - 2,109 times, all recorded as provider errors,
  because the error text read like a response-parsing problem.

  So this file uses `Get-EnvSafe` everywhere, and client-side faults get their
  own statuses (`unconfigured`, `excluded_policy`, `parse_error`, `no_provider`)
  which are EXCLUDED from the provider success-rate denominator.
#>

Set-StrictMode -Version Latest

. "$PSScriptRoot/../lib/Tier.ps1"
. "$PSScriptRoot/../lib/Frontmatter.ps1"

$script:WarnedVars = @{}

function Get-EnvSafe {
  <#
  .SYNOPSIS
    D19 - a StrictMode-safe environment read.
  .DESCRIPTION
    `(Get-Item env:X -ErrorAction SilentlyContinue).Value` returns $null when X
    is unset, and reading `.Value` off $null THROWS under
    `Set-StrictMode -Version Latest`. Use this everywhere; `Invoke-SecretScan`
    lints for the unsafe idiom.

    An EMPTY STRING counts as absent. A declared-but-empty variable is what an
    unset variable looks like in most shells, and treating it as present is how
    a chain silently runs with no key.
  #>
  param([Parameter(Mandatory)][string]$Name)
  $v = [Environment]::GetEnvironmentVariable($Name)
  if ($null -eq $v -or $v.Trim() -eq '') { return $null }
  return $v
}

function Get-RouterConfig {
  param([Parameter(Mandatory)][string]$InstallRoot)
  $path = Join-VaultPath -Root $InstallRoot -Parts @('automation', 'policies', 'provider-router.json')
  if (-not (Test-Path -LiteralPath $path)) {
    throw "provider router config not found at $path"
  }
  return ([IO.File]::ReadAllText($path) | ConvertFrom-Json)
}

function Test-ProviderUsable {
  <#
  .SYNOPSIS
    Is this provider usable for this tier and task?
  .OUTPUTS
    @{ Usable = <bool>; Status = <status>; Reason = <string> }

    Status is one of: ok | excluded_policy | excluded_tier | unconfigured |
    excluded_capability. The three exclusions are DIFFERENT ANSWERS with
    different remedies, and collapsing them is D16.
  #>
  param(
    [Parameter(Mandatory)]$Provider,
    [Parameter(Mandatory)][string]$Tier,
    [Parameter(Mandatory)][string]$Task,
    [switch]$RequireReasoning
  )

  # 1 · THE GATE, FIRST. Governance before capability, always.
  $accepts = if ($Provider.local -eq $true) { 'local_only' } else { 'hosted_allowed' }
  if (-not (Test-TierAllowed -SourceTier $Tier -DestinationAcceptsTier $accepts)) {
    return @{
      Usable = $false
      Status = 'excluded_tier'
      Reason = "provider '$($Provider.id)' accepts $accepts; this content is $Tier. The gate refuses it - this is correct, not a failure."
    }
  }

  # 2 · policy exclusion - correct, and verbose
  if ($Provider.enabled -eq $false) {
    return @{ Usable = $false; Status = 'excluded_policy'; Reason = "provider '$($Provider.id)' is disabled in provider-router.json" }
  }
  if ($Provider.excluded_tasks -and ($Provider.excluded_tasks -contains $Task)) {
    return @{ Usable = $false; Status = 'excluded_policy'; Reason = "provider '$($Provider.id)' is excluded from task '$Task' by policy" }
  }

  # 3 · capability floor. NOT re-enterable by any fallback (D17).
  if ($RequireReasoning -and ($Provider.reasoning_capable -ne $true)) {
    return @{ Usable = $false; Status = 'excluded_capability'; Reason = "provider '$($Provider.id)' is not reasoning_capable and task '$Task' requires it" }
  }

  # 4 · is it actually configured? A missing key is a WARNING NAMING THE VARIABLE.
  if ($Provider.key_env) {
    if ($null -eq (Get-EnvSafe $Provider.key_env)) {
      if (-not $script:WarnedVars.ContainsKey($Provider.key_env)) {
        $script:WarnedVars[$Provider.key_env] = $true
        Write-Warning "provider '$($Provider.id)' is not configured: set the environment variable $($Provider.key_env). It is being skipped, not silently dropped."
      }
      return @{ Usable = $false; Status = 'unconfigured'; Reason = "environment variable $($Provider.key_env) is not set" }
    }
  }

  return @{ Usable = $true; Status = 'ok'; Reason = 'ok' }
}

function Select-Provider {
  <#
  .SYNOPSIS
    The provider chain for a task at a tier, in order.
  .DESCRIPTION
    THROWS on an empty chain. It does not fall back to "the first provider" -
    that is D17 exactly, and it is the difference between a loud refusal and a
    reasoning task quietly served by a model barred from reasoning.
  .OUTPUTS
    @{ Chain = @(...); Excluded = @(@{ Id; Status; Reason }) }
  #>
  param(
    [Parameter(Mandatory)]$Config,
    [Parameter(Mandatory)][string]$Tier,
    [Parameter(Mandatory)][string]$Task
  )

  $taskCfg = $Config.tasks.$Task
  $requireReasoning = ($null -ne $taskCfg -and $taskCfg.requires_reasoning -eq $true)

  $chain = New-Object System.Collections.ArrayList
  $excluded = New-Object System.Collections.ArrayList
  $seenBaseUrls = @{}

  foreach ($p in $Config.providers) {
    $check = Test-ProviderUsable -Provider $p -Tier $Tier -Task $Task -RequireReasoning:$requireReasoning
    if (-not $check.Usable) {
      [void]$excluded.Add(@{ Id = $p.id; Status = $check.Status; Reason = $check.Reason })
      continue
    }

    # D16 - two providers resolving to the SAME upstream is not a chain, it is
    # one provider listed twice. Upstream, hops 1 and 2 of a four-hop chain
    # shared an endpoint and died together, and rotation looked like resilience.
    $base = if ($p.base_url_env) { Get-EnvSafe $p.base_url_env } else { $p.base_url }
    if ($base) {
      if ($seenBaseUrls.ContainsKey($base)) {
        Write-Warning "providers '$($seenBaseUrls[$base])' and '$($p.id)' resolve to the SAME endpoint ($base). That is one provider listed twice, not a fallback chain - they will fail together."
      } else {
        $seenBaseUrls[$base] = $p.id
      }
    }

    [void]$chain.Add($p)
  }

  if ($chain.Count -eq 0) {
    # NO FALLBACK. This is the D17 line that is deliberately absent.
    $detail = ($excluded | ForEach-Object { "$($_.Id): $($_.Status)" }) -join '; '
    throw "no usable provider for task '$Task' at tier '$Tier'. Nothing was dispatched. Excluded: $detail"
  }

  return @{ Chain = @($chain); Excluded = @($excluded) }
}

function Write-ProviderHealth {
  <#
  .SYNOPSIS
    I3 - persist per-provider, per-task outcomes.
  .DESCRIPTION
    `lifetime_ok` / `lifetime_total` are tracked SEPARATELY from the rolling
    window, specifically so that "this key has NEVER ONCE SUCCEEDED" survives a
    window reset. That is a dead key, not a rate limit, and it needs a different
    remedy - upstream one provider recorded a 429 with zero lifetime successes
    (a valid key whose quota the waste had exhausted) and it read as throttling
    for weeks.

    Client-side statuses are recorded but EXCLUDED from the success denominator.
  #>
  param(
    [Parameter(Mandatory)][string]$VaultRoot,
    [Parameter(Mandatory)][string]$Provider,
    [Parameter(Mandatory)][string]$Task,
    [Parameter(Mandatory)][string]$Status,
    [int]$LatencyMs = 0
  )

  $path = Join-VaultPath -Root $VaultRoot -Parts @('logs', 'sutra', 'provider.ndjson')
  $dir = Split-Path -Parent $path
  if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }

  $entry = @{
    t          = (Get-Date).ToUniversalTime().ToString('o')
    host       = [Environment]::MachineName
    provider   = $Provider
    task       = $Task
    status     = $Status
    latency_ms = $LatencyMs
  }
  # Best-effort: observability must never fail the run.
  try { Add-Content -LiteralPath $path -Value ($entry | ConvertTo-Json -Compress) -Encoding utf8 } catch { }
}
