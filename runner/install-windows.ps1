$ErrorActionPreference = "Stop"
$installDir = Join-Path $env:LOCALAPPDATA "A2AcRunner"
$configDir = Join-Path $env:USERPROFILE ".config\a2ac-runner"
$startupDir = [Environment]::GetFolderPath("Startup")
$runnerUrl = "https://raw.githubusercontent.com/CtrlAltForgot/A2Ac/main/runner/a2ac-runner.mjs"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Node.js 22+ is required. Install it, reopen PowerShell, then rerun this installer." }
$codex = Get-Command codex.cmd -ErrorAction SilentlyContinue
if (-not $codex) { $codex = Get-Command codex -ErrorAction SilentlyContinue }
if (-not $codex) { throw "Codex CLI was not found in PATH. Install/login to Codex CLI, reopen PowerShell, then rerun this installer." }

New-Item -ItemType Directory -Force $installDir, $configDir | Out-Null
Invoke-WebRequest $runnerUrl -OutFile (Join-Path $installDir "a2ac-runner.mjs")

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
$daemon = "@echo off`r`nnode `"$installDir\a2ac-runner.mjs`" daemon >> `"$installDir\runner.log`" 2>&1"
Set-Content -Encoding ASCII (Join-Path $startupDir "A2Ac Runner.cmd") $daemon

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (($userPath -split ';') -notcontains $installDir) { [Environment]::SetEnvironmentVariable("Path", ($userPath.TrimEnd(';') + ";" + $installDir), "User") }
Start-Process -WindowStyle Hidden node -ArgumentList @((Join-Path $installDir "a2ac-runner.mjs"), "daemon")
& node (Join-Path $installDir "a2ac-runner.mjs") enable
Write-Host "Installed and armed permanently. Open a new PowerShell, then use: a2ac-runner status|enable|disable"
