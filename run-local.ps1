# Loads .env into the current PowerShell session, then starts the server.
# Usage:  .\run-local.ps1          (start server)
#         .\run-local.ps1 -Check   (just verify Zoho credentials)

param([switch]$Check)

$envFile = Join-Path $PSScriptRoot ".env"
if (-not (Test-Path $envFile)) {
    Write-Host "No .env file found." -ForegroundColor Red
    Write-Host "Copy .env.example to .env and fill it in first:" -ForegroundColor Yellow
    Write-Host "  Copy-Item .env.example .env"
    exit 1
}

Get-Content $envFile | ForEach-Object {
    $line = $_.Trim()
    if ($line -eq "" -or $line.StartsWith("#")) { return }
    $idx = $line.IndexOf("=")
    if ($idx -lt 1) { return }
    $key = $line.Substring(0, $idx).Trim()
    $val = $line.Substring($idx + 1).Trim().Trim('"')
    Set-Item -Path "env:$key" -Value $val
}

Write-Host "Loaded .env" -ForegroundColor Green

if ($Check) { node (Join-Path $PSScriptRoot "check.js") }
else { node (Join-Path $PSScriptRoot "server.js") }
