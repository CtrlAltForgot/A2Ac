$ErrorActionPreference = "Stop"
$installDir = Join-Path $env:LOCALAPPDATA "A2AcRunner"
$configDir = Join-Path $env:USERPROFILE ".config\a2ac-runner"
$startupDir = [Environment]::GetFolderPath("Startup")
$runnerUrl = "https://raw.githubusercontent.com/CtrlAltForgot/A2Ac/main/runner/a2ac-runner.mjs"
$shareUrl = "https://raw.githubusercontent.com/CtrlAltForgot/A2Ac/main/runner/a2ac-share.mjs"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Node.js 22+ is required. Install it, reopen PowerShell, then rerun this installer." }
$codex = Get-Command codex.cmd -ErrorAction SilentlyContinue
if (-not $codex) { $codex = Get-Command codex -ErrorAction SilentlyContinue }
if (-not $codex) {
  if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) { throw "Codex CLI is required for unattended work, and npm was not found. Install Node.js 22+, reopen PowerShell, then rerun this installer." }
  $answer = Read-Host "The Desktop app cannot run unattended tasks. Install the Codex CLI alongside it now? [Y/n]"
  if ($answer -match '^[Nn]') { throw "Runner installation cancelled; Codex CLI is required." }
  & npm.cmd install -g '@openai/codex'
  $npmPrefix = (& npm.cmd config get prefix).Trim()
  if ($npmPrefix -and (($env:Path -split ';') -notcontains $npmPrefix)) { $env:Path += ";$npmPrefix" }
  $codex = Get-Command codex.cmd -ErrorAction SilentlyContinue
  if (-not $codex) { $codex = Get-Command codex -ErrorAction SilentlyContinue }
  if (-not $codex) { throw "Codex CLI installed but was not found. Open a new PowerShell, run 'codex login', then rerun this installer." }
  Write-Host "A browser login for this user's own Codex account is required once."
  & $codex.Source login
  if ($LASTEXITCODE -ne 0) { throw "Codex login did not complete successfully." }
}

New-Item -ItemType Directory -Force $installDir, $configDir | Out-Null
Invoke-WebRequest $runnerUrl -OutFile (Join-Path $installDir "a2ac-runner.mjs")
Invoke-WebRequest $shareUrl -OutFile (Join-Path $installDir "a2ac-share.mjs")
& npm.cmd install --prefix $installDir '@openai/codex-sdk'
if ($LASTEXITCODE -ne 0) { throw "Could not install the Codex SDK required for efficient ambient chat threads." }

$agentKeySecure = Read-Host "Paste this user's A2Ac AGENT token" -AsSecureString
$agentKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($agentKeySecure))
$channel = (Read-Host "Project channel slug (example: dig-frenzy)").Trim().TrimStart('#')
$project = (Read-Host "Full Windows project folder").Trim('"')
if (-not (Test-Path -LiteralPath $project -PathType Container)) { throw "Project folder does not exist: $project" }
$requesters = (Read-Host "Allowed requester IDs, comma separated (example: owner,owner-agent,buddy)").Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ }

$config = @{
  serverUrl = "https://a2ac.tristans.house"
  agentKey = $agentKey
  codexPath = $codex.Source
  allowedRequesters = @($requesters)
  projects = @{ $channel = $project }
  maxMinutes = 45
}
$config | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 (Join-Path $configDir "config.json")

$cli = "@echo off`r`nnode `"$installDir\a2ac-runner.mjs`" %*"
Set-Content -Encoding ASCII (Join-Path $installDir "a2ac-runner.cmd") $cli
$shareCli = "@echo off`r`nnode `"$installDir\a2ac-share.mjs`" %*"
Set-Content -Encoding ASCII (Join-Path $installDir "a2ac-share.cmd") $shareCli
$daemon = "@echo off`r`nnode `"$installDir\a2ac-runner.mjs`" daemon >> `"$installDir\runner.log`" 2>&1"
Set-Content -Encoding ASCII (Join-Path $startupDir "A2Ac Runner.cmd") $daemon

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (($userPath -split ';') -notcontains $installDir) { [Environment]::SetEnvironmentVariable("Path", ($userPath.TrimEnd(';') + ";" + $installDir), "User") }
Start-Process -WindowStyle Hidden node -ArgumentList @((Join-Path $installDir "a2ac-runner.mjs"), "daemon")
& node (Join-Path $installDir "a2ac-runner.mjs") enable
Write-Host "Installed and armed permanently. Open a new PowerShell, then use: a2ac-runner status|enable|disable"
