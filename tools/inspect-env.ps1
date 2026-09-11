$procs = Get-CimInstance Win32_Process -Filter "Name='electron.exe'"
"electron.exe process count: $($procs.Count)"
foreach ($p in $procs) {
  "PID=$($p.ProcessId)  Created=$($p.CreationDate)"
  "  Cmd=$($p.CommandLine)"
}
"---TEMP llmb-* dirs---"
$d = [IO.Directory]::GetDirectories($env:TEMP, 'llmb-*')
"count: $($d.Count)"
$sum = 0
foreach ($x in $d) {
  $sz = (Get-ChildItem $x -Recurse -Force -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
  if ($null -eq $sz) { $sz = 0 }
  $sum += $sz
  "{0}  {1:N0} KB  mtime={2}" -f (Split-Path $x -Leaf), ($sz / 1KB), (Get-Item $x).LastWriteTime
}
"total: {0:N1} MB" -f ($sum / 1MB)
