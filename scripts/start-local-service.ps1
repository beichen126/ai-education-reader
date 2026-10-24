param([switch]$UseSystemProxy)
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
  $readerArgs += '"' + (Join-Path $readerRoot 'server\supervise.mjs') + '"'
  $readerProcess = Start-Process -FilePath $readerNode -ArgumentList $readerArgs -WorkingDirectory $readerRoot -WindowStyle Hidden -PassThru
  Write-Output "Reader background supervisor started (PID $($readerProcess.Id)); closing this terminal will not stop it."
} finally {
  foreach ($key in $readerEnvKeys) { [Environment]::SetEnvironmentVariable($key, $readerOldEnv[$key], 'Process') }
}
