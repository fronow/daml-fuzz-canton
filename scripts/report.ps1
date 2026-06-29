# report.ps1 -- run the fuzzer and generate a clean, self-contained report.html.
#
# WHAT IT DOES
#   1. Runs `daml test` and captures the full output + exit code.
#   2. Works out, per scenario, whether it passed.
#   3. Writes a styled, dependency-free `report.html` in the project root that
#      you can open in any browser (and archive as an audit artifact).
#
# HOW TO RUN (from anywhere, in PowerShell):
#   ./scripts/report.ps1
#   then open report.html
#
# Requires the Daml SDK on PATH. If you just want to SEE the design first,
# open report.sample.html (hand-filled example data, no SDK needed).

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$outFile = Join-Path $root "report.html"

if (-not (Get-Command daml -ErrorAction SilentlyContinue)) {
    Write-Host "ERROR: 'daml' is not on your PATH. Install the Daml SDK first" -ForegroundColor Red
    Write-Host "(see docs/02-install-the-sdk-and-run.md). To preview the UI without it," -ForegroundColor Red
    Write-Host "open report.sample.html instead." -ForegroundColor Red
    exit 1
}

Write-Host "Running 'daml test' ..." -ForegroundColor Yellow
# Capture stdout + stderr. We must relax ErrorActionPreference here: the daml
# launcher writes notices (e.g. the assistant-deprecation warning) to stderr,
# which PowerShell 5.1 would otherwise treat as a fatal error when merged with
# 2>&1. We run from the project root so no --package-root flag is needed
# (portable across Daml 2.x and 3.x).
$prevEAP = $ErrorActionPreference
$ErrorActionPreference = "Continue"
Push-Location $root
$raw  = & daml test --no-legacy-assistant-warning 2>&1 | Out-String
$code = $LASTEXITCODE
Pop-Location
$ErrorActionPreference = $prevEAP
$pass = ($code -eq 0)

# --- Scenario inventory ----------------------------------------------------
$cleanScenarios = @(
    @{ name = "fuzzStateClean";   tier = "Tier 1 - conservation and non-negativity" },
    @{ name = "fuzzAuthClean";    tier = "Tier 2 - adversary 'Eve' blocked" },
    @{ name = "fuzzPrivacyClean"; tier = "Tier 4 - Eve observes nothing" }
)
$zoo = @(
    @{ id = "B1"; name = "fuzzB1"; bug = "Split forgets to subtract -> value inflation"; tier = "Tier 1 - conservation"; status = "implemented" },
    @{ id = "B2"; name = "fuzzB2"; bug = "Split accepts negative amount -> negative balance"; tier = "Tier 1 - non-negativity"; status = "implemented" },
    @{ id = "B3"; name = "fuzzB3"; bug = "Wrong controller -> theft"; tier = "Tier 2 - authorization"; status = "implemented" },
    @{ id = "B4"; name = "fuzzB4"; bug = "Merge double-adds -> inflation"; tier = "Tier 1 - conservation"; status = "implemented" },
    @{ id = "B5"; name = "fuzzB5"; bug = "Archive without payout -> value vanishes"; tier = "Tier 1 - conservation"; status = "implemented" },
    @{ id = "B6"; name = "fuzzB6"; bug = "Proposal can be accepted twice -> double-spend"; tier = "Tier 3 - workflow"; status = "implemented" },
    @{ id = "B7"; name = "fuzzB7"; bug = "Expired offer still executes"; tier = "Tier 3 - workflow"; status = "implemented" },
    @{ id = "B8"; name = "fuzzB8"; bug = "Extra observer -> privacy leak"; tier = "Tier 4 - disclosure"; status = "implemented" }
)

$lines = $raw -split "`r?`n"

function Get-Status($name) {
    if ($pass) { return "pass" }
    $line = $lines | Where-Object { $_ -match [regex]::Escape($name) } | Select-Object -First 1
    if ($null -eq $line) { return "unknown" }
    if ($line -match "(?i)\b(ok|success|passed)\b") { return "pass" }
    if ($line -match "(?i)\b(fail|failure|error)\b") { return "fail" }
    return "unknown"
}
function Enc($s) { ($s -replace '&','&amp;' -replace '<','&lt;' -replace '>','&gt;') }
function BadgeClean($st) {
    if ($st -eq "pass") { return '<span class="badge clean">clean</span>' }
    if ($st -eq "fail") { return '<span class="badge fail">FALSE POSITIVE</span>' }
    return '<span class="badge planned">unknown</span>'
}
function BadgeMutant($st) {
    if ($st -eq "pass") { return '<span class="badge caught">caught</span>' }
    if ($st -eq "fail") { return '<span class="badge fail">MISSED</span>' }
    return '<span class="badge planned">unknown</span>'
}

# --- Build rows + counts ---------------------------------------------------
$cleanRows = ""
$falsePositives = 0
foreach ($s in $cleanScenarios) {
    $st = Get-Status $s.name
    if ($st -eq "fail") { $falsePositives++ }
    $badge = BadgeClean $st
    $cleanRows += "      <tr><td class=`"mono`">$($s.name)</td><td class=`"tier`">$($s.tier)</td><td>$badge</td></tr>`n"
}

$zooRows = ""
$implemented = 0
$caught = 0
foreach ($m in $zoo) {
    if ($m.status -eq "implemented") {
        $implemented++
        $st = Get-Status $m.name
        if ($st -eq "pass") { $caught++ }
        $badge = BadgeMutant $st
    } else {
        $badge = '<span class="badge planned">planned</span>'
    }
    $zooRows += "      <tr><td class=`"id`">$($m.id)</td><td>$(Enc $m.bug)</td><td class=`"tier`">$($m.tier)</td><td>$badge</td></tr>`n"
}

$scenariosRun = $cleanScenarios.Count + $implemented
if ($implemented -gt 0) { $mutPct = [math]::Round(100.0 * $caught / $implemented) } else { $mutPct = 0 }
# Findings = ESCAPED violations. A passing suite has none by definition, so we
# only surface captured recipe text when the run actually failed; otherwise we
# show the honest clean state (mislabeling green-run summary lines as findings
# would be misleading).
$findingLines = $lines | Where-Object { $_ -match "(?i)violated|Recipe to reproduce|FALSE POSITIVE|MISSED|^\s*step " }
if ((-not $pass) -and $findingLines) {
    $findings = Enc ($findingLines -join "`n")
    $findingsHtml = @"
    <div class="finding" style="border-left-color:var(--red);">
      <h3><span class="ftag" style="background:var(--red);">recipe</span> Reproduction detail captured from daml test output</h3>
      <div class="term"><div class="bar"><i class="r"></i><i class="y"></i><i class="g"></i><span>recipe</span></div><pre>$findings</pre></div>
    </div>
"@
} else {
    $findingsHtml = @"
    <div class="finding">
      <h3><span class="ftag">clean</span> No violations</h3>
      <div class="note">Every planted bug was caught and the correct contract produced no violation, so nothing escaped. On a failing run, each escaped property would appear here as a reproduction recipe (same seed, same steps, every time).</div>
    </div>
"@
}

if ($pass) { $bannerClass = "pass" } else { $bannerClass = "fail" }
if ($pass) { $bannerText = "PASS - no false positives on the correct contract, and every implemented planted bug was caught." } else { $bannerText = "FAIL - 'daml test' reported a problem. See the raw log below." }
if ($pass) { $resultWord = "PASS" } else { $resultWord = "FAIL" }
if ($pass) { $cardClass = "pass" } else { $cardClass = "fail" }
$stamp = Get-Date -Format "yyyy-MM-dd HH:mm"
$seed = 42       # matches Fuzz.daml (St seed = 42)
$rounds = 500    # matches Fuzz.daml (rounds)
$rawEsc = Enc $raw

# --- CSS (literal here-string; ASCII only) ---------------------------------
$css = @'
  :root{--bg:#eef1f6;--card:#fff;--ink:#0f172a;--muted:#64748b;--border:#e6eaf1;--green:#10b981;--green-ink:#0b7a44;--green-bg:#e6f7ee;--red:#ef4444;--red-ink:#b42323;--red-bg:#fdecec;--gray:#64748b;--gray-bg:#eef1f6;--accent:#4f46e5;--accent2:#7c3aed;--shadow:0 1px 2px rgba(15,23,42,.04),0 10px 28px rgba(15,23,42,.06);}
  *{box-sizing:border-box;}
  html{-webkit-text-size-adjust:100%;}
  body{margin:0;background:var(--bg);color:var(--ink);font-family:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;line-height:1.55;-webkit-font-smoothing:antialiased;}
  .wrap{max-width:1000px;margin:0 auto;padding:0 20px 72px;}
  .hero{margin:0 -20px 30px;padding:40px 42px 36px;color:#e9ecf6;border-radius:0 0 22px 22px;background:radial-gradient(1100px 380px at 0% -30%,#4338ca 0%,transparent 60%),linear-gradient(135deg,#0f172a 0%,#1e1b4b 52%,#4338ca 100%);}
  .hero-top{display:flex;justify-content:space-between;align-items:flex-start;gap:24px;flex-wrap:wrap;}
  .kicker{font-size:12px;letter-spacing:.2em;text-transform:uppercase;color:#a5b4fc;font-weight:600;}
  .hero h1{font-size:30px;line-height:1.12;margin:9px 0 7px;font-weight:700;letter-spacing:-.02em;color:#fff;}
  .hero .sub{color:#c7cdf0;font-size:15px;max-width:62ch;}
  .statuspill{flex:none;display:inline-flex;align-items:center;gap:9px;font-weight:700;font-size:14px;padding:9px 17px;border-radius:999px;}
  .statuspill .dot{width:9px;height:9px;border-radius:50%;}
  .statuspill.pass{background:rgba(16,185,129,.16);color:#6ee7b7;border:1px solid rgba(110,231,183,.35);}
  .statuspill.pass .dot{background:#34d399;box-shadow:0 0 0 4px rgba(52,211,153,.22);}
  .statuspill.fail{background:rgba(239,68,68,.16);color:#fca5a5;border:1px solid rgba(252,165,165,.35);}
  .statuspill.fail .dot{background:#f87171;box-shadow:0 0 0 4px rgba(248,113,113,.22);}
  .meta{margin-top:20px;display:flex;flex-wrap:wrap;gap:8px;}
  .chip{font-size:12.5px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.14);color:#dfe3f7;padding:5px 11px;border-radius:8px;}
  .chip b{color:#fff;font-weight:600;}
  .chip.sample{background:rgba(251,191,36,.16);border-color:rgba(251,191,36,.4);color:#fde68a;}
  .banner{display:flex;align-items:center;gap:11px;border-radius:13px;padding:14px 18px;font-weight:600;font-size:14.5px;margin:0 0 28px;}
  .banner.pass{background:var(--green-bg);color:var(--green-ink);border:1px solid #bdebd0;}
  .banner.fail{background:var(--red-bg);color:var(--red-ink);border:1px solid #f7c9c9;}
  .banner .dot{width:10px;height:10px;border-radius:50%;flex:none;}
  .banner.pass .dot{background:var(--green);} .banner.fail .dot{background:var(--red);}
  .cards{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;}
  .card{position:relative;background:var(--card);border:1px solid var(--border);border-radius:15px;padding:18px;box-shadow:var(--shadow);overflow:hidden;}
  .card::before{content:"";position:absolute;left:0;top:0;height:3px;width:100%;background:linear-gradient(90deg,var(--accent),var(--accent2));}
  .card.pass::before{background:linear-gradient(90deg,#10b981,#34d399);}
  .card.fail::before{background:linear-gradient(90deg,#ef4444,#f87171);}
  .card .label{font-size:11.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.07em;font-weight:600;}
  .card .value{font-size:30px;font-weight:750;margin-top:8px;letter-spacing:-.02em;line-height:1;}
  .card.pass .value{color:var(--green-ink);} .card.fail .value{color:var(--red-ink);}
  .card .hint{font-size:12px;color:var(--muted);margin-top:7px;}
  section{margin-top:36px;}
  h2{font-size:16px;margin:0 0 14px;font-weight:700;letter-spacing:-.01em;display:flex;align-items:center;gap:10px;}
  h2::before{content:"";width:4px;height:17px;border-radius:3px;background:linear-gradient(180deg,var(--accent),var(--accent2));}
  .h2note{font-weight:400;color:var(--muted);font-size:13px;}
  .tbl{background:var(--card);border:1px solid var(--border);border-radius:15px;box-shadow:var(--shadow);overflow:hidden;}
  table{width:100%;border-collapse:collapse;font-size:14px;}
  th,td{text-align:left;padding:13px 16px;border-bottom:1px solid var(--border);}
  thead th{background:#f7f9fc;font-size:11.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);font-weight:600;}
  tbody tr{transition:background .12s ease;} tbody tr:hover{background:#f7f9fc;}
  tbody tr:last-child td{border-bottom:none;}
  td.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;}
  td.id{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-weight:700;color:var(--accent);}
  .tier{color:var(--muted);font-size:13px;}
  .badge{display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:600;padding:3px 10px;border-radius:999px;border:1px solid transparent;}
  .badge.caught,.badge.clean{background:var(--green-bg);color:var(--green-ink);border-color:#bdebd0;}
  .badge.fail{background:var(--red-bg);color:var(--red-ink);border-color:#f7c9c9;}
  .badge.planned{background:var(--gray-bg);color:var(--gray);border-color:var(--border);}
  .finding{background:var(--card);border:1px solid var(--border);border-left:4px solid var(--green);border-radius:13px;padding:16px 18px;margin:14px 0;box-shadow:var(--shadow);}
  .finding h3{margin:0 0 11px;font-size:14.5px;display:flex;align-items:center;gap:9px;}
  .finding .note{color:var(--muted);font-size:13px;}
  .ftag{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;font-weight:700;color:#fff;background:var(--green);padding:2px 8px;border-radius:6px;}
  .term{background:#0b1020;border:1px solid #1c2740;border-radius:12px;overflow:hidden;}
  .term .bar{display:flex;align-items:center;gap:7px;padding:9px 13px;background:#121b35;border-bottom:1px solid #1c2740;}
  .term .bar i{width:11px;height:11px;border-radius:50%;display:inline-block;}
  .term .bar .r{background:#ff5f56;} .term .bar .y{background:#ffbd2e;} .term .bar .g{background:#27c93f;}
  .term .bar span{margin-left:7px;font-size:12px;color:#8b95b5;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;}
  pre{margin:0;background:#0b1020;color:#d7def0;padding:16px;overflow:auto;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;line-height:1.65;}
  details{margin-top:22px;border:1px solid var(--border);border-radius:13px;background:var(--card);overflow:hidden;box-shadow:var(--shadow);}
  summary{cursor:pointer;font-weight:600;color:var(--ink);padding:14px 16px;font-size:14px;list-style:none;}
  summary::-webkit-details-marker{display:none;}
  summary::before{content:"\25B8";color:var(--accent);margin-right:9px;display:inline-block;transition:transform .15s ease;}
  details[open] summary::before{transform:rotate(90deg);}
  details .term{border:none;border-radius:0;border-top:1px solid var(--border);}
  footer{margin-top:46px;color:var(--muted);font-size:12.5px;border-top:1px solid var(--border);padding-top:18px;}
  footer b{color:var(--ink);}
  @media(max-width:720px){.cards{grid-template-columns:repeat(2,1fr);}.hero{padding:30px 22px;}.hero h1{font-size:24px;}}
'@

# --- Compose HTML (interpolated here-string) -------------------------------
$html = @"
<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>daml-fuzz - Assurance Report</title>
<style>
$css
</style></head><body><div class="wrap">

  <header class="hero">
    <div class="hero-top">
      <div>
        <div class="kicker">Assurance Report</div>
        <h1>daml-fuzz</h1>
        <div class="sub">Property-based fuzzing for Daml smart contracts on the Canton Network.</div>
      </div>
      <div class="statuspill $bannerClass"><span class="dot"></span> $resultWord</div>
    </div>
    <div class="meta">
      <span class="chip"><b>Contract:</b> Token (PoC target)</span>
      <span class="chip"><b>Seed:</b> $seed</span>
      <span class="chip"><b>Rounds:</b> $rounds</span>
      <span class="chip"><b>Generated:</b> $stamp</span>
      <span class="chip"><b>Exit code:</b> $code</span>
    </div>
  </header>

  <div class="banner $bannerClass"><span class="dot"></span>$bannerText</div>

  <div class="cards">
    <div class="card"><div class="label">Scenarios run</div><div class="value">$scenariosRun</div><div class="hint">across 4 property tiers</div></div>
    <div class="card $cardClass"><div class="label">Bugs caught</div><div class="value">$caught / $implemented</div><div class="hint">mutation score $mutPct%</div></div>
    <div class="card $cardClass"><div class="label">False positives</div><div class="value">$falsePositives</div><div class="hint">on the correct contract</div></div>
    <div class="card $cardClass"><div class="label">Result</div><div class="value">$resultWord</div><div class="hint">exit code $code</div></div>
  </div>

  <section>
    <h2>Correct-contract checks <span class="h2note">- must find nothing</span></h2>
    <div class="tbl"><table><thead><tr><th>Scenario</th><th>Property tier</th><th>Outcome</th></tr></thead><tbody>
$cleanRows    </tbody></table></div>
  </section>

  <section>
    <h2>Bug zoo <span class="h2note">- planted bugs the fuzzer must catch</span></h2>
    <div class="tbl"><table><thead><tr><th>ID</th><th>Planted bug</th><th>Property tier</th><th>Status</th></tr></thead><tbody>
$zooRows    </tbody></table></div>
  </section>

  <section>
    <h2>Findings <span class="h2note">- reproduction recipes</span></h2>
$findingsHtml
  </section>

  <details><summary>Raw daml test log</summary>
    <div class="term"><div class="bar"><i class="r"></i><i class="y"></i><i class="g"></i><span>daml test</span></div><pre>$rawEsc</pre></div>
  </details>

  <footer><b>daml-fuzz</b> | Apache-2.0 | Self-contained (no external assets), suitable for archiving as an audit artifact.</footer>

</div></body></html>
"@

$html | Out-File -FilePath $outFile -Encoding utf8
Write-Host ""
Write-Host "Report written to: $outFile" -ForegroundColor Green
Write-Host "Open it in your browser to view the results." -ForegroundColor Green
exit $code
