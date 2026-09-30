$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$pythonPath = Join-Path $env:USERPROFILE 'anaconda3\python.exe'
if (-not (Test-Path -LiteralPath $pythonPath)) { throw 'Set $pythonPath to your Python 3.10+ executable.' }
$cacheDir = Join-Path $PSScriptRoot '.nashville_cache'
New-Item -ItemType Directory -Path $cacheDir -Force | Out-Null
# Background Codex processes need Modify access to generated files, not source data.
$siteDir = Join-Path $PSScriptRoot 'nashville_site'
New-Item -ItemType Directory -Path $siteDir -Force | Out-Null
if (Get-LocalGroup -Name 'CodexSandboxUsers' -ErrorAction SilentlyContinue) {
    foreach ($directory in @($cacheDir, $siteDir)) {
        $resolved = (Resolve-Path -LiteralPath $directory).Path
        if (-not $resolved.StartsWith($PSScriptRoot + '\', [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Generated directory outside workspace' }
        icacls $resolved /grant 'CodexSandboxUsers:(OI)(CI)M' /T /C | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Cannot grant watcher write access: $resolved" }
    }
}
$pidPath = Join-Path $cacheDir 'watcher.pid'
if (Test-Path -LiteralPath $pidPath) {
    $watcherId = [int](Get-Content -LiteralPath $pidPath)
    $existing = Get-CimInstance Win32_Process -Filter "ProcessId = $watcherId" -ErrorAction SilentlyContinue
    if ($existing -and $existing.CommandLine -like '*build_nashville.py*--watch*') {
        Write-Output "Already running: PID $watcherId. Open http://127.0.0.1:8765"
        exit 0
    }
}
$stopPath = Join-Path $cacheDir 'STOP'
if (Test-Path -LiteralPath $stopPath) { Remove-Item -LiteralPath $stopPath }
$process = Start-Process -FilePath $pythonPath -ArgumentList '-u','build_nashville.py','--watch','--serve','8765' -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $cacheDir 'watcher.log') -RedirectStandardError (Join-Path $cacheDir 'watcher.error.log') -PassThru
$process.Id | Set-Content -LiteralPath $pidPath
Write-Output "Watcher started: PID $($process.Id). Open http://127.0.0.1:8765"
Write-Output "Logs: $cacheDir\watcher.log"
