$ErrorActionPreference = 'Continue'
# 1. Kill hung test electrons: main processes whose cmdline contains test/dom/main.js + firstrun
$targets = Get-CimInstance Win32_Process -Filter "Name='electron.exe'" |
  Where-Object { $_.CommandLine -match 'test/dom/main\.js' -and $_.CommandLine -match 'firstrun' }
"Killing main PIDs: $($targets.ProcessId -join ', ')"
foreach ($t in $targets) { Stop-Process -Id $t.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 3
$left = Get-CimInstance Win32_Process -Filter "Name='electron.exe'"
"electron.exe remaining after kill: $($left.Count)"
$left | ForEach-Object { "  PID=$($_.ProcessId) Cmd=$($_.CommandLine)" }

# 2. Remove all llmb-* temp dirs
$d = [IO.Directory]::GetDirectories($env:TEMP, 'llmb-*')
"Removing $($d.Count) dirs..."
foreach ($x in $d) { Remove-Item $x -Recurse -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 1
$after = [IO.Directory]::GetDirectories($env:TEMP, 'llmb-*')
"llmb-* count after cleanup: $($after.Count)"
$after | ForEach-Object { "  LEFT: $_" }
