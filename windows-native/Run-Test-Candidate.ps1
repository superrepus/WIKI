param([Parameter(Mandatory)][string]$ExecutablePath,[int]$DebugPort=0)
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent)).TrimEnd('\')
$exe=[IO.Path]::GetFullPath($ExecutablePath)
if(!$exe.StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase) -or !(Test-Path -LiteralPath $exe)){throw 'Test executable must be inside this workspace'}
$env:LLM_WIKI_BIND_HOST='127.0.0.1'
if($DebugPort){$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port='+$DebugPort+' --remote-debugging-address=127.0.0.1'}
$proc=Start-Process -FilePath $exe -WorkingDirectory (Split-Path $exe -Parent) -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $PSScriptRoot 'runtime/foxess-preview.stdout.log') -RedirectStandardError (Join-Path $PSScriptRoot 'runtime/foxess-preview.stderr.log')
$proc.WaitForExit();exit $proc.ExitCode
