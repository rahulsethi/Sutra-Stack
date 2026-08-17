# SPDX-License-Identifier: Apache-2.0
<#
.SYNOPSIS
  AATMA - the tier normaliser, PowerShell binding. The twin of
  `packages/core/src/gate/tiers.ts`; the two must never disagree.

.DESCRIPTION
  The PowerShell twin of `packages/core/src/gate/tiers.ts`. The two must agree
  exactly; `Tier.test.ps1` asserts the same table both implementations declare.

  Canonical internal identifiers — what EVERY comparison must use after
  resolving:

    hosted_allowed   (= public)
    review_required  (= private)   <- the default for unknown or empty
    local_only       (= secret)

  D20 — NEVER COMPARE A RAW FRONTMATTER STRING TO A LITERAL.

  A tier rename once turned the only repair script into a permanent no-op:
  `backfill-synthesis.ps1` hard-filtered on the literal 'hosted_allowed', a
  later normalisation renamed that tier to 'public', and the script silently
  skipped 100% of its candidates while exiting 0. It exits 0 having processed
  nothing, which is indistinguishable from "nothing to do".

  Resolve through this function, or you have written that bug again.

  `local_only` / `secret` is never grantable. `do_not_learn` is an orthogonal
  axis and callers handle it separately.
#>

Set-StrictMode -Version Latest

function Resolve-Tier {
  <#
  .SYNOPSIS
    Map any tier-ish value to the canonical internal identifier.
  .OUTPUTS
    'hosted_allowed' | 'review_required' | 'local_only'
  #>
  param([AllowNull()][AllowEmptyString()][string]$Raw)

  if ($null -eq $Raw) { return 'review_required' }
  switch -Exact ($Raw.Trim().ToLowerInvariant()) {
    'public'          { return 'hosted_allowed'  }
    'private'         { return 'review_required' }
    'secret'          { return 'local_only'      }
    'hosted_allowed'  { return 'hosted_allowed'  }
    'review_required' { return 'review_required' }
    'local_only'      { return 'local_only'      }
    'hosted-allowed'  { return 'hosted_allowed'  }
    'review-required' { return 'review_required' }
    'local-only'      { return 'local_only'      }
    'hosted'          { return 'hosted_allowed'  }
    'local'           { return 'local_only'      }
    # Unknown, empty, or a typo -> the SAFE default. An unlabelled note is not
    # one anyone decided was safe to share.
    default           { return 'review_required' }
  }
}

function Get-TierRank {
  <#
  .SYNOPSIS
    Restrictiveness rank. Higher = more restrictive.
  #>
  param([Parameter(Mandatory)][string]$Tier)
  switch -Exact (Resolve-Tier $Tier) {
    'hosted_allowed'  { return 0 }
    'review_required' { return 1 }
    'local_only'      { return 2 }
  }
}

function Get-TierDisplay {
  <# .SYNOPSIS  The user-facing spelling of a tier. #>
  param([Parameter(Mandatory)][string]$Tier)
  switch -Exact (Resolve-Tier $Tier) {
    'hosted_allowed'  { return 'public'  }
    'review_required' { return 'private' }
    'local_only'      { return 'secret'  }
  }
}

function Get-StrictestTier {
  <#
  .SYNOPSIS
    The most restrictive tier in a set.
  .DESCRIPTION
    An EMPTY set returns 'review_required', not 'hosted_allowed'. "I found no
    sources" must never mean "therefore this is public".
  #>
  param([string[]]$Tiers)
  if ($null -eq $Tiers -or $Tiers.Count -eq 0) { return 'review_required' }
  $best = 'hosted_allowed'
  foreach ($t in $Tiers) {
    if ((Get-TierRank $t) -gt (Get-TierRank $best)) { $best = (Resolve-Tier $t) }
  }
  return $best
}

function Get-RaisedTier {
  <#
  .SYNOPSIS
    INVARIANT 4 — SENSITIVITY IS RAISE-ONLY.
  .DESCRIPTION
    Returns whichever of the two is stricter. Every place that would otherwise
    write a tier calls this, so "lower a tier" is not an operation this codebase
    knows how to perform.
  #>
  param(
    [Parameter(Mandatory)][string]$Current,
    [Parameter(Mandatory)][string]$Proposed
  )
  if ((Get-TierRank $Proposed) -gt (Get-TierRank $Current)) { return (Resolve-Tier $Proposed) }
  return (Resolve-Tier $Current)
}

function Test-TierAllowed {
  <#
  .SYNOPSIS
    THE GATE. Content flows iff it is at least as permissive as the destination
    requires: rank(source) <= rank(destination).
  #>
  param(
    [Parameter(Mandatory)][string]$SourceTier,
    [Parameter(Mandatory)][string]$DestinationAcceptsTier
  )
  return ((Get-TierRank $SourceTier) -le (Get-TierRank $DestinationAcceptsTier))
}

function Test-DoNotLearn {
  <#
  .SYNOPSIS
    THE ONE do_not_learn PREDICATE.
  .DESCRIPTION
    E1 — the upstream system had FIVE of these across three languages, and every
    divergence failed open in at least one of them. Generous about what counts
    as true; strict about what counts as false.
  #>
  param([AllowNull()]$Value)
  if ($null -eq $Value) { return $false }
  if ($Value -is [bool]) { return $Value }
  $s = ([string]$Value).Trim().ToLowerInvariant()
  return ($s -eq 'true' -or $s -eq 'yes' -or $s -eq '1')
}