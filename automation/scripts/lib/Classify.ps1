# SPDX-License-Identifier: Apache-2.0
<#
.SYNOPSIS
  The classifier — the third of the four secret-floor enforcement points, and
  the PowerShell binding over the SHARED pattern set.

.DESCRIPTION
  THIS FILE DECLARES NO PATTERNS OF ITS OWN.

  Every rule, every floor path and every OCR engine is read from
  `automation/policies/secret-patterns.json`, which is the same file
  `packages/core/src/gate/patterns.ts` reads. That is deliberate and is the
  single most important structural decision in this file.

  ROADMAP E1, on the system this was extracted from: "Six re-implementations of
  one tier comparison across three languages, and five different `do_not_learn`
  predicates — EVERY DIVERGENCE FAILS OPEN IN AT LEAST ONE OF THEM."

  One policy engine, one predicate, N thin bindings. This is one of the thin
  bindings. If you find yourself about to add a regex here, add it to the JSON
  instead: a rule that exists in only one language is a rule that does not exist
  on the paths written in the other.

  The defects this design closes, none of which are patchable in a second copy
  of the list:

  D5 — `sk-[A-Za-z0-9]{20,}` cannot match `sk-proj-` or `sk-ant-`; the hyphen
       ends the character run after three characters. The flagship OpenAI and
       Anthropic key shapes were structurally unmatchable, and tests written
       from the same mental model as the pattern passed. Every rule in the JSON
       ships with a fixture it MUST match, asserted in CI.

  D4 — the path floor matched `identity/accounts` with StartsWith against a
       PARA-NUMBERED vault (`11-identity/…`). No real path could ever match, so
       one of the three floor layers had NEVER ONCE FIRED. Matching here is
       segment-based and strips numeric prefixes.

  I16 — every one of the worst credential cases upstream entered as an IMAGE OF
       TEXT through OCR, where no human ever reads the result. An OCR-derived
       extract is floored regardless of how benign its text looks.

  I15 — the pattern set is content-hashed. Improving the list invalidates the
       last full scan and `sutra rescan` must run. A scanner is only as good as
       its list, the list WILL be incomplete, and a better list changes NOTHING
       retroactively without the re-scan trigger.

  D24/I17 — every rule declares a band. `definite` may fail a commit;
       `heuristic` may raise a tier and warn, and may NEVER block. A fuzzy rule
       blocking a commit is how a hook earns a `--no-verify` habit; upstream
       accumulated 128 of them across 91 files, and thereby kept the BELIEF that
       its commits were scanned.
#>

Set-StrictMode -Version Latest

. "$PSScriptRoot/Tier.ps1"

$script:PatternCache = @{}

function Get-PatternSet {
  <#
  .SYNOPSIS
    Load and cache the shared pattern set.
  .DESCRIPTION
    FAILS CLOSED AND LOUD. A missing or unparseable pattern file THROWS rather
    than yielding an empty rule set — a scanner with no rules reports every file
    clean, which is the most dangerous possible failure for this component.
  #>
  param([Parameter(Mandatory)][string]$InstallRoot)

  $path = [IO.Path]::Combine($InstallRoot, 'automation', 'policies', 'secret-patterns.json')
  if ($script:PatternCache.ContainsKey($path)) { return $script:PatternCache[$path] }

  if (-not (Test-Path -LiteralPath $path)) {
    throw "secret pattern set not found at $path. Refusing to classify with no rules - a scanner with an empty list reports everything clean."
  }

  $bytes = [IO.File]::ReadAllBytes($path)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { $hash = ([BitConverter]::ToString($sha.ComputeHash($bytes)) -replace '-', '').ToLowerInvariant() }
  finally { $sha.Dispose() }

  try {
    $json = [Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json
  } catch {
    throw "secret pattern set at $path is unparseable, refusing to classify: $($_.Exception.Message)"
  }
  if ($null -eq $json.rules -or @($json.rules).Count -eq 0) {
    throw "secret pattern set at $path declares no rules. Refusing to classify."
  }

  $set = [pscustomobject]@{
    Version      = $json.version
    Rules        = @($json.rules)
    FloorPaths   = @($json.floor_paths)
    OcrEngines   = @($json.ocr_engines | ForEach-Object { $_.ToLowerInvariant() })
    OcrFloorTier = (Resolve-Tier ([string]$json.ocr_floor_tier))
    Benign       = @($json.benign)
    ExemptPaths  = @($json.scanner_exempt_paths)
    Hash         = $hash
  }
  $script:PatternCache[$path] = $set
  return $set
}

function ConvertTo-DotNetRegex {
  <#
  .SYNOPSIS
    The pattern strings carry an inline `(?i)` that .NET understands natively,
    so no translation is needed here — unlike JavaScript, which has no inline
    flags. Kept as a named function so the asymmetry is visible rather than
    surprising to whoever ports the next binding.
  #>
  param([Parameter(Mandatory)][string]$Pattern)
  return [regex]::new($Pattern)
}

function Get-NormalizedFloorPath {
  <#
  .SYNOPSIS
    D4 — strip a leading numeric prefix from EVERY path segment.
  .DESCRIPTION
    The upstream bug in one line:
      '11-identity/accounts/x.md'.StartsWith('identity/accounts')  ->  false
    A PARA-numbered vault made every floor path unreachable, and nothing counted
    rule hits, so a rule that fired zero times looked exactly like a rule
    protecting a clean corpus.
  #>
  param([Parameter(Mandatory)][AllowEmptyString()][string]$RelPath)
  $parts = ($RelPath -replace '\\', '/') -split '/'
  $clean = foreach ($p in $parts) { $p -replace '^\d+[-_. ]+', '' }
  return (($clean -join '/').ToLowerInvariant())
}

function Test-FloorPath {
  <#
  .SYNOPSIS
    Does this path sit under a configured secret-floor location?
  .DESCRIPTION
    Matches on SEGMENT boundaries, not substrings: `identity/accounts-public`
    must not match `identity/accounts`, and `my-finance-notes.md` must not match
    `finance`. An over-flooring classifier trains people to distrust it.
  .OUTPUTS
    The matching floor path, or $null.
  #>
  param(
    [Parameter(Mandatory)][AllowEmptyString()][string]$RelPath,
    [Parameter(Mandatory)][AllowEmptyCollection()][string[]]$FloorPaths
  )
  $segs = (Get-NormalizedFloorPath $RelPath) -split '/'
  foreach ($floor in $FloorPaths) {
    $fs = @((Get-NormalizedFloorPath $floor) -split '/' | Where-Object { $_ -ne '' })
    if ($fs.Count -eq 0) { continue }
    for ($i = 0; $i -le ($segs.Count - $fs.Count); $i++) {
      $ok = $true
      for ($j = 0; $j -lt $fs.Count; $j++) {
        if ($segs[$i + $j] -ne $fs[$j]) { $ok = $false; break }
      }
      if ($ok) { return $floor }
    }
  }
  return $null
}

function Protect-MatchedSecret {
  <# .SYNOPSIS  Redact a match to its shape. A finding must never log the finding. #>
  param([Parameter(Mandatory)][AllowEmptyString()][string]$Value)
  $t = $Value.Trim()
  if ($t.Length -le 8) { return "$($t.Substring(0, [Math]::Min(2, $t.Length)))...($($t.Length) chars)" }
  return "$($t.Substring(0,6))...$($t.Substring($t.Length-2)) ($($t.Length) chars)"
}

function Invoke-Classify {
  <#
  .SYNOPSIS
    Classify content. The result is NEVER lower than the tier it came in with.

  .DESCRIPTION
    Order is deliberate, and every step can only RAISE:
      1. start at the current tier (or private if unlabelled)
      2. OCR floor   - I16, applies to the whole extract regardless of content
      3. path floor  - D4, applies regardless of content
      4. pattern rules - content-derived

  .OUTPUTS
    A hashtable: Tier, Blocking, Hits, Reasons, PatternHash.
  #>
  param(
    [Parameter(Mandatory)][AllowEmptyString()][string]$Text,
    [Parameter(Mandatory)][string]$InstallRoot,
    [AllowEmptyString()][string]$RelPath = '',
    [AllowEmptyString()][string]$ExtractEngine = '',
    [AllowEmptyString()][string]$CurrentTier = ''
  )

  $set = Get-PatternSet -InstallRoot $InstallRoot
  $tier = if ([string]::IsNullOrWhiteSpace($CurrentTier)) { 'review_required' } else { Resolve-Tier $CurrentTier }
  $blocking = $false
  $reasons = New-Object System.Collections.ArrayList
  $hits = New-Object System.Collections.ArrayList

  # ── 2 · I16 · the OCR floor ────────────────────────────────────────────────
  # Applied BEFORE any content inspection, precisely because the content is the
  # thing that cannot be trusted here. OCR is where text arrives both secret AND
  # corrupt: one live page upstream was fabricated wholesale from an extract
  # whose embedded font shifted every glyph 31 code points, silently deleting
  # every digit in the document.
  $engine = $ExtractEngine.Trim().ToLowerInvariant()
  if ($engine -and ($set.OcrEngines -contains $engine)) {
    $before = $tier
    $tier = Get-RaisedTier -Current $tier -Proposed $set.OcrFloorTier
    $blocking = $true
    [void]$reasons.Add("OCR floor (I16): extracted by '$engine' - OCR output is untrusted by default and is never eligible for a hosted route on an ingest-time tier alone. $before -> $tier.")
  }

  # ── 3 · D4 · the path floor ────────────────────────────────────────────────
  if ($RelPath) {
    $floor = Test-FloorPath -RelPath $RelPath -FloorPaths $set.FloorPaths
    if ($floor) {
      $before = $tier
      $tier = Get-RaisedTier -Current $tier -Proposed 'local_only'
      $blocking = $true
      [void]$reasons.Add("path floor (D4): '$RelPath' sits under the secret-floor location '$floor'. $before -> $tier.")
    }
  }

  # ── 4 · content rules ──────────────────────────────────────────────────────
  foreach ($rule in $set.Rules) {
    $re = ConvertTo-DotNetRegex $rule.pattern
    $matches = $re.Matches($Text)
    if ($matches.Count -eq 0) { continue }

    foreach ($m in $matches) {
      # The line number, computed without materialising the whole file as lines.
      $line = 1 + ([regex]::Matches($Text.Substring(0, $m.Index), "`n")).Count
      [void]$hits.Add(@{
        RuleId   = $rule.id
        Band     = $rule.band
        Provider = $rule.provider
        Line     = $line
        Redacted = (Protect-MatchedSecret $m.Value)
      })
      if ($hits.Count -gt 500) { break }   # a pathological file must not hang the scan
    }

    $before = $tier
    $tier = Get-RaisedTier -Current $tier -Proposed 'local_only'
    $shortDesc = ($rule.description -split '\.')[0]

    if ($rule.band -eq 'definite') {
      $blocking = $true
      [void]$reasons.Add("$($rule.id) (definite): $shortDesc. $before -> $tier.")
    } else {
      # I17 — raises the tier (safe when wrong), never blocks (costly when wrong).
      [void]$reasons.Add("$($rule.id) (heuristic): $shortDesc. Tier raised $before -> $tier; NOT blocking - a fuzzy rule may raise a tier but must never fail a commit.")
    }
  }

  return @{
    Tier        = $tier
    Blocking    = $blocking
    Hits        = @($hits)
    Reasons     = @($reasons)
    PatternHash = $set.Hash
  }
}

function Test-PatternSelfCoverage {
  <#
  .SYNOPSIS
    D4 — positive coverage. Every rule must match its own fixture, and no
    `definite` rule may match a benign string.
  .DESCRIPTION
    Surfaced through `sutra doctor` as well as CI, because the failure it guards
    is a rule that quietly stops matching anything - which looks identical to a
    clean corpus.
  #>
  param([Parameter(Mandatory)][string]$InstallRoot)

  $set = Get-PatternSet -InstallRoot $InstallRoot
  $dead = New-Object System.Collections.ArrayList
  $false_positives = New-Object System.Collections.ArrayList

  foreach ($rule in $set.Rules) {
    $re = ConvertTo-DotNetRegex $rule.pattern
    if (-not $re.IsMatch($rule.fixture)) { [void]$dead.Add($rule.id) }
  }
  foreach ($benign in $set.Benign) {
    foreach ($rule in $set.Rules) {
      if ($rule.band -ne 'definite') { continue }   # heuristics are ALLOWED to over-match
      $re = ConvertTo-DotNetRegex $rule.pattern
      if ($re.IsMatch($benign)) { [void]$false_positives.Add("$($rule.id) matched '$benign'") }
    }
  }

  return @{
    Ok             = (($dead.Count -eq 0) -and ($false_positives.Count -eq 0))
    DeadRules      = @($dead)
    FalsePositives = @($false_positives)
    RuleCount      = @($set.Rules).Count
    Hash           = $set.Hash
  }
}
