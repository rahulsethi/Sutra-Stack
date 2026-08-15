# SPDX-License-Identifier: Apache-2.0
<#
.SYNOPSIS
  INGEST — intake -> manifest -> extract -> classify.

.DESCRIPTION
  Stage one of the four-stage pipeline. Everything a person or a machine drops
  into `raw/inbox/` becomes a manifest in `raw/manifests/` with an extract in
  `compiled/extracts/`, classified and tiered.

  ── CLASSIFICATION HAPPENS HERE, AND IT FLOORS FIRST ───────────────────────
  A manifest is tiered BEFORE anything downstream can read it. `Invoke-Classify`
  is the same code path the gate and the commit hook use, over the same rules.

  ── D23 · A REASON ENUM, NOT A MESSAGE STRING ──────────────────────────────
  Upstream, ONE literal - `trafilatura: no content or uv unavailable` - covered
  both "the tool is not installed on this node" and "the page returned no
  content". 240 of 319 pending items were unseparable from the manifests alone.

  It reads like a precise diagnosis. Nobody notices a conflation until they try
  to decide whether the backlog is RECOVERABLE, and cannot.

  So `extract_reason` is an ENUM and retry policy is a function of it:

    ok              extracted
    tool-missing    RETRY once the tool exists
    source-empty    do NOT retry, ever - the source genuinely had nothing
    unsupported     no extractor for this type
    too-large       exceeded the size budget
    failed          the extractor ran and errored

  ── D3 · the stamp is not the authority ────────────────────────────────────
  A missing `extract:` key once hid 697 already-extracted sources - 2.3x the
  entire compiled corpus, invisible, because every count in the system measured
  manifests-WITH-a-stamp. Never let a derived flag be the sole authority on a
  fact the filesystem already knows; `-Reconcile` checks stamps against disk.

.PARAMETER VaultRoot
  The vault. Positional so `sutra ingest` can pass it directly.

.PARAMETER Reconcile
  D3 - report manifests whose stamp disagrees with what is on disk.

.PARAMETER Apply
  With -Reconcile, fix the stamps (key-scoped write only).
#>

[CmdletBinding()]
param(
  [Parameter(Position = 0)][string]$VaultRoot,
  [string]$InstallRoot,
  [switch]$Reconcile,
  [switch]$Apply
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $VaultRoot) { $VaultRoot = $env:SUTRA_VAULT }
if (-not $VaultRoot) { throw "no vault root. Pass it positionally or set SUTRA_VAULT." }
if (-not $InstallRoot) { $InstallRoot = if ($env:SUTRA_HOME) { $env:SUTRA_HOME } else { (Resolve-Path "$PSScriptRoot/../..").Path } }

. "$PSScriptRoot/lib/Frontmatter.ps1"
. "$PSScriptRoot/lib/Tier.ps1"
. "$PSScriptRoot/lib/Classify.ps1"

$InboxDir     = Join-VaultPath -Root $VaultRoot -Parts @('raw', 'inbox')
$ManifestDir  = Join-VaultPath -Root $VaultRoot -Parts @('raw', 'manifests')
$ExtractDir   = Join-VaultPath -Root $VaultRoot -Parts @('compiled', 'extracts')
$VaultInbox   = Join-VaultPath -Root $VaultRoot -Parts @('vault', '00-inbox')

foreach ($d in @($InboxDir, $ManifestDir, $ExtractDir)) {
  if (-not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
}

# ── Extractors ───────────────────────────────────────────────────────────────
# Each declares the engine name it stamps. I16: an OCR engine here floors the
# resulting extract to `secret` regardless of how benign its text looks, so the
# engine name is a GOVERNANCE field, not a diagnostic one.
$Extractors = @{
  '.md'   = @{ Engine = 'text-passthrough'; Kind = 'markdown' }
  '.txt'  = @{ Engine = 'text-passthrough'; Kind = 'text' }
  '.json' = @{ Engine = 'text-passthrough'; Kind = 'data' }
  '.csv'  = @{ Engine = 'text-passthrough'; Kind = 'data' }
  '.html' = @{ Engine = 'trafilatura';      Kind = 'web' }
  '.htm'  = @{ Engine = 'trafilatura';      Kind = 'web' }
  '.pdf'  = @{ Engine = 'pdftotext';        Kind = 'pdf' }
}

function Get-ExtractReason {
  <#
  .SYNOPSIS
    D23 - decide the reason ENUM for a file we could not fully extract.
  .DESCRIPTION
    The whole value of this function is that "tool-missing" and "source-empty"
    are DIFFERENT ANSWERS. One is a backlog that recovers when you install
    something; the other is a backlog that never recovers and should stop being
    counted as one.
  #>
  param(
    [Parameter(Mandatory)][string]$Extension,
    [Parameter(Mandatory)][long]$Bytes,
    [AllowEmptyString()][string]$ExtractedText
  )

  if (-not $Extractors.ContainsKey($Extension)) { return 'unsupported' }
  if ($Bytes -gt 64MB) { return 'too-large' }

  $engine = $Extractors[$Extension].Engine
  if ($engine -ne 'text-passthrough') {
    $tool = switch ($engine) {
      'trafilatura' { 'uv' }
      'pdftotext'   { 'pdftotext' }
      default       { $engine }
    }
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { return 'tool-missing' }
  }

  if ([string]::IsNullOrWhiteSpace($ExtractedText)) { return 'source-empty' }
  return 'ok'
}

function Get-SourceId {
  param([Parameter(Mandatory)][string]$ManifestDir)
  $year = (Get-Date).Year
  $existing = @(Get-ChildItem -LiteralPath $ManifestDir -Filter "src-$year-*.md" -ErrorAction SilentlyContinue)
  $n = $existing.Count + 1
  do {
    $id = "src-$year-{0:D6}" -f $n
    $n++
  } while (Test-Path -LiteralPath ([IO.Path]::Combine($ManifestDir, "$id.md")))
  return $id
}

function Get-Sha256 {
  param([Parameter(Mandatory)][string]$Path)
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    $fs = [IO.File]::OpenRead($Path)
    try { return ([BitConverter]::ToString($sha.ComputeHash($fs)) -replace '-', '').ToLowerInvariant() }
    finally { $fs.Dispose() }
  } finally { $sha.Dispose() }
}

# ── D3 · reconcile mode ──────────────────────────────────────────────────────
if ($Reconcile) {
  $problems = @()
  foreach ($m in (Get-ChildItem -LiteralPath $ManifestDir -Filter '*.md' -ErrorAction SilentlyContinue)) {
    $text = Read-NoteFile -Path $m.FullName
    $parsed = Split-Frontmatter -Text $text
    if ($null -eq $parsed.FrontMatter) { continue }

    $id = $m.BaseName
    $extractPath = [IO.Path]::Combine($ExtractDir, "$id.txt")
    $onDisk = [IO.File]::Exists($extractPath)
    $stamped = $parsed.FrontMatter.ContainsKey('extract') -and $parsed.FrontMatter['extract'] -ne ''

    if ($onDisk -and -not $stamped) {
      $problems += [pscustomobject]@{ Id = $id; Issue = 'extract on disk, NO STAMP'; Path = $m.FullName }
      if ($Apply) {
        # KEY-SCOPED. Only the `extract` line changes; every other byte is verified.
        $new = Set-FrontmatterKey -Text $text -Key 'extract' -Value 'ok' -Verify
        if ($null -eq $new) {
          # The key is absent entirely, so there is nothing to rewrite. Refuse
          # rather than restructure the file - D3's actual lesson.
          Write-Warning "$id has no 'extract:' key to rewrite. Refusing to restructure the file; add the key by hand."
        } else {
          Write-NoteFile -Path $m.FullName -Content $new
        }
      }
    } elseif (-not $onDisk -and $stamped -and $parsed.FrontMatter['extract'] -eq 'ok') {
      $problems += [pscustomobject]@{ Id = $id; Issue = 'stamped ok, NO EXTRACT ON DISK'; Path = $m.FullName }
    }
  }

  Write-Host "reconcile: $($problems.Count) manifest(s) whose stamp disagrees with the filesystem"
  foreach ($p in $problems) { Write-Host "  $($p.Id): $($p.Issue)" }
  if ($problems.Count -gt 0 -and -not $Apply) {
    Write-Host "  re-run with -Apply to fix the stamps (key-scoped write only)"
  }
  Write-Host "considered: $($problems.Count)"
  Write-Host "produced: $(if ($Apply) { $problems.Count } else { 0 })"
  exit 0
}

# ── Normal ingest ────────────────────────────────────────────────────────────
$considered = 0
$produced = 0
$reasons = @{}

$candidates = @(Get-ChildItem -LiteralPath $InboxDir -File -ErrorAction SilentlyContinue |
                Where-Object { -not $_.Name.StartsWith('.') })

# A vault-inbox capture is ALSO intake: it is a note the user or an agent wrote
# and has not reviewed. It gets classified like anything else.
$captures = @(Get-ChildItem -LiteralPath $VaultInbox -File -Filter '*.md' -ErrorAction SilentlyContinue |
              Where-Object { -not $_.Name.StartsWith('.') })

foreach ($f in $candidates) {
  $considered++
  $ext = $f.Extension.ToLowerInvariant()
  $spec = if ($Extractors.ContainsKey($ext)) { $Extractors[$ext] } else { $null }
  $engine = if ($spec) { $spec.Engine } else { 'none' }

  # Extract. Only the passthrough path is implemented in-tree; everything else
  # is delegated, and its absence is a REASON, not a silent skip.
  $extracted = ''
  if ($engine -eq 'text-passthrough') {
    try { $extracted = [IO.File]::ReadAllText($f.FullName, [Text.Encoding]::UTF8) } catch { $extracted = '' }
  }

  $reason = Get-ExtractReason -Extension $ext -Bytes $f.Length -ExtractedText $extracted
  if (-not $reasons.ContainsKey($reason)) { $reasons[$reason] = 0 }
  $reasons[$reason]++

  $id = Get-SourceId -ManifestDir $ManifestDir
  $hash = Get-Sha256 -Path $f.FullName

  # THE CLASSIFIER. Same rules, same code path as the gate and the hook.
  $cls = Invoke-Classify -Text $extracted -InstallRoot $InstallRoot `
                         -RelPath "raw/inbox/$($f.Name)" -ExtractEngine $engine
  $display = Get-TierDisplay $cls.Tier

  if ($reason -eq 'ok') {
    Write-NoteFile -Path ([IO.Path]::Combine($ExtractDir, "$id.txt")) -Content $extracted
    $produced++
  }

  $manifest = @(
    '---'
    "id: $id"
    'type: Source'
    "kind: $(if ($spec) { $spec.Kind } else { 'unknown' })"
    'status: imported'
    "sensitivity: $display"
    "source_date: $($f.LastWriteTime.ToString('yyyy-MM-dd'))"
    "ingested_at: $((Get-Date).ToUniversalTime().ToString('o'))"
    "hash: $hash"
    "source_bytes: $($f.Length)"
    "extract: $reason"
    "extract_engine: $engine"
    "extract_chars: $($extracted.Length)"
    "pattern_hash: $($cls.PatternHash)"
    'related_to: []'
    '---'
    ''
    "# Source manifest - $($f.Name)"
    ''
    '## Original'
    "- filename: $($f.Name)"
    "- bytes: $($f.Length)"
    "- sha256: $hash"
    ''
    '## Classification'
    "- tier: $display"
    $(if ($cls.Reasons.Count -gt 0) { $cls.Reasons | ForEach-Object { "- $_" } } else { '- no rule matched; default tier applied' })
    ''
  ) -join "`n"

  Write-NoteFile -Path ([IO.Path]::Combine($ManifestDir, "$id.md")) -Content $manifest

  # Move the source out of the inbox so it is not re-ingested. Additive: the
  # original is preserved under raw/, never deleted.
  $keepDir = Join-VaultPath -Root $VaultRoot -Parts @('raw', 'sources', (Get-Date).ToString('yyyy-MM'))
  if (-not (Test-Path -LiteralPath $keepDir)) { New-Item -ItemType Directory -Path $keepDir -Force | Out-Null }
  Move-Item -LiteralPath $f.FullName -Destination ([IO.Path]::Combine($keepDir, "$id$ext")) -Force
}

# Classify the vault inbox in place. Raise-only: a capture already marked
# `secret` stays secret.
foreach ($c in $captures) {
  $considered++
  $text = Read-NoteFile -Path $c.FullName
  $parsed = Split-Frontmatter -Text $text
  if ($null -eq $parsed.FrontMatter) { continue }

  $current = if ($parsed.FrontMatter.ContainsKey('sensitivity')) { [string]$parsed.FrontMatter['sensitivity'] } else { '' }
  $cls = Invoke-Classify -Text $parsed.Body -InstallRoot $InstallRoot `
                         -RelPath "vault/00-inbox/$($c.Name)" -CurrentTier $current
  $raised = Get-RaisedTier -Current (Resolve-Tier $current) -Proposed $cls.Tier

  if ($raised -ne (Resolve-Tier $current)) {
    $new = Set-FrontmatterKey -Text $text -Key 'sensitivity' -Value (Get-TierDisplay $raised) -Verify
    if ($null -ne $new) {
      Write-NoteFile -Path $c.FullName -Content $new
      Write-Host "  raised $($c.Name): $(Get-TierDisplay $current) -> $(Get-TierDisplay $raised)"
      $produced++
    }
  }
}

# ── Report. Five outcomes, never one counter (D11). ──────────────────────────
Write-Host ""
Write-Host "ingest: $considered considered, $produced produced"
foreach ($k in ($reasons.Keys | Sort-Object)) {
  $label = switch ($k) {
    'ok'           { 'extracted' }
    'tool-missing' { 'PENDING (tool missing - will retry when installed)' }
    'source-empty' { 'skipped (source genuinely empty - will NOT retry)' }
    'unsupported'  { 'skipped (no extractor for this type)' }
    'too-large'    { 'skipped (over the size budget)' }
    'failed'       { 'FAILED (the extractor ran and errored)' }
    default        { $k }
  }
  Write-Host "  $($reasons[$k].ToString().PadLeft(4))  $label"
}
Write-Host ""
Write-Host "considered: $considered"
Write-Host "produced: $produced"
exit 0
