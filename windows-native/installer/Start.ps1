param([switch]$Monitor)
$ErrorActionPreference='Stop'
$installRoot=Split-Path $PSScriptRoot -Parent
$exe=Join-Path $installRoot 'app/llm-wiki.exe'
$profile=Join-Path $env:APPDATA 'com.llmwiki.app/app-state.json'
if(!(Test-Path -LiteralPath $profile)){
  & powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'Configure.ps1')
  if(!(Test-Path -LiteralPath $profile)){exit 0}
}
$other=@(Get-Process -Name llm-wiki -ErrorAction SilentlyContinue)
if($other.Count){
  if($Monitor -and $other[0].Path -eq $exe){$other[0].WaitForExit()}
  exit 0
}
$logs=Join-Path $env:LOCALAPPDATA 'FoxESS/LLMWiki/logs'
[IO.Directory]::CreateDirectory($logs) | Out-Null
$env:LLM_WIKI_BIND_HOST='127.0.0.1'
$proc=Start-Process -FilePath $exe -WorkingDirectory (Split-Path $exe -Parent) -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logs 'stdout.log') -RedirectStandardError (Join-Path $logs 'stderr.log')
if($Monitor){$proc.WaitForExit();exit $proc.ExitCode}
