# Launch the pet against the server-side AI. The Electron host opens the SSH tunnel itself,
# hidden, so there is no separate tunnel window to keep around.
$ErrorActionPreference = 'Stop'
$url = "ws://127.0.0.1:8787/desktop/v1/ws"

$runtime = Join-Path $env:USERPROFILE '.local\share\rp-pet-electron\electron\electron.exe'
if (-not (Test-Path $runtime)) { $runtime = Join-Path $env:TEMP 'rp-pet-webview\electron-full\electron.exe' }
if (-not (Test-Path $runtime)) { $runtime = Join-Path $PSScriptRoot 'node_modules\electron\dist\electron.exe' }
if (-not (Test-Path $runtime)) {
    Write-Host 'Electron runtime not found. See README.'
    Read-Host
    exit 1
}

Start-Process -FilePath $runtime -ArgumentList @("`"$PSScriptRoot`"", "--desktop-url=$url")
