param([switch]$UseSystemProxy, [switch]$Foreground)
$ErrorActionPreference = 'Stop'
$readerRoot = Split-Path $PSScriptRoot -Parent
$readerNode = (Get-Command node -ErrorAction Stop).Source
try {
  $readerHealth = Invoke-RestMethod 'http://127.0.0.1:8091/health' -Headers @{ Origin = 'http://127.0.0.1:5173' } -TimeoutSec 2
  if ($readerHealth.service -eq 'reader-local') { Write-Output 'Reader service is already running; no duplicate was started.'; return }
} catch { }
# Proxy values remain in this process environment; never write them to the repo.
$readerEnvKeys = @('HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY')
$readerOldEnv = @{}
foreach ($key in $readerEnvKeys) { $readerOldEnv[$key] = [Environment]::GetEnvironmentVariable($key, 'Process') }
try {
  $readerArgs = @()
  if ($UseSystemProxy) {
    $readerInternet = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
    if (!$readerInternet.ProxyEnable) { throw 'Windows system proxy is disabled; refusing silent direct fallback.' }
    $readerProxyValue = [string]$readerInternet.ProxyServer
    if ($readerProxyValue -match '(?:^|;)https=([^;]+)') { $readerProxyValue = $Matches[1] }
    elseif ($readerProxyValue -match '(?:^|;)http=([^;]+)') { $readerProxyValue = $Matches[1] }
    $readerProxyValue = $readerProxyValue -replace '^https?://', ''
    if ($readerProxyValue -notmatch '^(127\.0\.0\.1|localhost):\d{1,5}$') { throw 'Expected a loopback HTTP system proxy; no proxy configuration was printed or saved.' }
    $env:HTTP_PROXY = 'http://' + $readerProxyValue
    $env:HTTPS_PROXY = $env:HTTP_PROXY
    $env:NO_PROXY = '127.0.0.1,localhost,::1'
    $readerArgs += '--use-env-proxy'
  }
  $readerArgs += Join-Path $readerRoot 'server\supervise.mjs'
  if ($Foreground) {
    Set-Location -LiteralPath $readerRoot
    & $readerNode @readerArgs
    return
  }
  # WMI creates the launcher outside the invoking terminal/tool's job tree.
  # The child reads the system proxy itself; no credentials enter command arguments.
  $readerShell = (Get-Process -Id $PID).Path
  $readerScript = Join-Path $readerRoot 'scripts\start-local-service.ps1'
  $readerCommand = '"' + $readerShell + '" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $readerScript + '" -Foreground'
  if ($UseSystemProxy) { $readerCommand += ' -UseSystemProxy' }
  $readerStartup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }
  $readerCreated = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $readerCommand; CurrentDirectory = $readerRoot; ProcessStartupInformation = $readerStartup }
  if ($readerCreated.ReturnValue -ne 0) { throw "Independent launch failed (Windows code $($readerCreated.ReturnValue))." }
  $readerReady = $false
  for ($readerAttempt = 0; $readerAttempt -lt 15; $readerAttempt++) {
    Start-Sleep -Milliseconds 500
    try {
      $readerHealth = Invoke-RestMethod 'http://127.0.0.1:8091/health' -Headers @{ Origin = 'http://127.0.0.1:5173' } -TimeoutSec 1
      if ($readerHealth.service -eq 'reader-local') { $readerReady = $true; break }
    } catch { }
  }
  if (!$readerReady) { throw 'Independent launcher started, but health check failed. Do not assume service is ready.' }
  Write-Output "Reader independent launcher is healthy (PID $($readerCreated.ProcessId)); no startup task or proxy settings were installed."
} finally {
  foreach ($key in $readerEnvKeys) { [Environment]::SetEnvironmentVariable($key, $readerOldEnv[$key], 'Process') }
}
