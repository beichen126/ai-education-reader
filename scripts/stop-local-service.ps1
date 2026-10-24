$ErrorActionPreference = 'Stop'
$readerRoot = Split-Path $PSScriptRoot -Parent
$readerSupervisor = Join-Path $readerRoot 'server\supervise.mjs'
$readerEntry = Join-Path $readerRoot 'server\start.mjs'
$readerSupervisors = @(Get-CimInstance Win32_Process -Filter "name='node.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($readerSupervisor) })
foreach ($readerParent in $readerSupervisors) {
  $readerChildren = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$($readerParent.ProcessId)" | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -and $_.CommandLine.Contains($readerEntry) })
  Stop-Process -Id $readerParent.ProcessId -ErrorAction SilentlyContinue
  foreach ($readerChild in $readerChildren) { Stop-Process -Id $readerChild.ProcessId -ErrorAction SilentlyContinue }
}
Write-Output "Stopped $($readerSupervisors.Count) Reader supervisor(s); unrelated Node processes were not touched."
