# scorecard.ps1 -- the headline metrics for daml-fuzz.
#
# Runs `daml test` on the PoC and reports the two numbers a grant committee
# cares about:
#   1. MUTATION SCORE  -- of the known planted bugs, how many did the fuzzer
#                         catch? (caught = the mutant's script passes)
#   2. CHOICE COVERAGE -- what fraction of the contracts' choices were exercised?
# Plus the clean-run result (false positives on the correct contract).
#
# Run from the project root:  ./scripts/scorecard.ps1
# Requires the Daml SDK on PATH (see docs/02).

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

if (-not (Get-Command daml -ErrorAction SilentlyContinue)) {
    Write-Host "ERROR: 'daml' is not on your PATH. See docs/02-install-the-sdk-and-run.md" -ForegroundColor Red
    exit 1
}

# Inventory. Add a row when you add a mutant.
$cleanScenarios = @("fuzzStateClean", "fuzzAuthClean", "fuzzPrivacyClean")
$mutants = @(
    @{ id = "B1"; name = "fuzzB1"; bug = "Split inflates value (conservation)" },
    @{ id = "B2"; name = "fuzzB2"; bug = "Negative split amount (non-negativity)" },
    @{ id = "B3"; name = "fuzzB3"; bug = "Wrong controller (authorization)" },
    @{ id = "B4"; name = "fuzzB4"; bug = "Merge double-adds (conservation)" },
    @{ id = "B5"; name = "fuzzB5"; bug = "Archive without payout (conservation)" },
    @{ id = "B6"; name = "fuzzB6"; bug = "Proposal accepted twice (workflow)" },
    @{ id = "B7"; name = "fuzzB7"; bug = "Expired offer still executes (workflow)" },
    @{ id = "B8"; name = "fuzzB8"; bug = "Extra observer (privacy/disclosure)" }
)

Write-Host ""
Write-Host "=== daml-fuzz scorecard ===" -ForegroundColor Cyan
Write-Host "Running 'daml test' ..." -ForegroundColor Yellow

$prevEAP = $ErrorActionPreference
$ErrorActionPreference = "Continue"
Push-Location $root
$out  = & daml test --no-legacy-assistant-warning 2>&1 | Out-String
$code = $LASTEXITCODE
Pop-Location
$ErrorActionPreference = $prevEAP

$lines = $out -split "`r?`n"
function Passed($name) {
    if ($code -eq 0) { return $true }
    $line = $lines | Where-Object { $_ -match [regex]::Escape($name) } | Select-Object -First 1
    return ($line -match "(?i)\bok\b")
}

# Mutation score
$caught = 0
foreach ($m in $mutants) { if (Passed $m.name) { $caught++ } }
$total = $mutants.Count
$pct = if ($total -gt 0) { [math]::Round(100.0 * $caught / $total, 1) } else { 0 }

# False positives (clean scenarios that failed)
$fp = 0
foreach ($c in $cleanScenarios) { if (-not (Passed $c)) { $fp++ } }

# Choice coverage (from daml test's own report)
$covText = "n/a"
for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match "Internal template choices") {
        $defined = ($lines[$i+1] -replace '[^0-9]', '')
        if ($lines[$i+2] -match "(\d+)\s*\(\s*([\d.]+)%\)\s*exercised") {
            $covText = "$($matches[1]) / $defined choices exercised ($($matches[2])%)"
        }
        break
    }
}

Write-Host ""
Write-Host "MUTATION SCORE : $caught / $total planted bugs caught ($pct%)" -ForegroundColor Green
foreach ($m in $mutants) {
    $mark = if (Passed $m.name) { "caught " } else { "MISSED " }
    $col  = if (Passed $m.name) { "Green" } else { "Red" }
    Write-Host ("  {0}  {1}  {2}" -f $m.id, $mark, $m.bug) -ForegroundColor $col
}
Write-Host ""
if ($fp -eq 0) { $fpCol = "Green" } else { $fpCol = "Red" }
Write-Host "FALSE POSITIVES: $fp  (correct-contract scenarios that wrongly flagged)" -ForegroundColor $fpCol
Write-Host "CHOICE COVERAGE: $covText" -ForegroundColor Green
Write-Host ""
if ($code -eq 0) {
    Write-Host "RESULT: PASS -- $caught/$total bugs caught, 0 false positives." -ForegroundColor Green
} else {
    Write-Host "RESULT: see details above (daml test exit $code)." -ForegroundColor Red
}
Write-Host ""
exit $code
