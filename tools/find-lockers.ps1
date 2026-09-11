Get-CimInstance Win32_Process | Where-Object {
  $_.Name -like '*LLM Usage*' -or ($_.CommandLine -like '*llm-usage-limit-board*' -and $_.Name -ne 'node.exe')
} | Select-Object ProcessId, Name, CommandLine | Format-List
"---"
"done"
