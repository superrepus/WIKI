param([Parameter(Mandatory)][string]$TestRoot,[string]$ScriptsRoot=$PSScriptRoot)
$ErrorActionPreference='Stop'
Import-Module "$PSHOME/Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1" -ErrorAction Stop
. (Join-Path $ScriptsRoot 'Initialize.ps1')
function Assert($Condition,$Message){if(!$Condition){throw $Message}}
[IO.Directory]::CreateDirectory($TestRoot) | Out-Null
$source=Join-Path $TestRoot 'synthetic-source';[IO.Directory]::CreateDirectory($source) | Out-Null
[IO.File]::WriteAllText((Join-Path $source 'manual.txt'),'SYNTHETIC_ONLY')
$sourceHash=(Get-FileHash -LiteralPath (Join-Path $source 'manual.txt')).Hash
$state=Join-Path $TestRoot 'profile/app-state.json';$project=Join-Path $TestRoot 'knowledge'
$result=New-ManagedWiki -ProjectPath $project -Name 'Installer fixture' -SourcePath $source -BaseUrl 'http://127.0.0.1:12345/v1' -Model 'test-model' -ApiKey 'TEST_ONLY_KEY' -StatePath $state
$cfg=[IO.File]::ReadAllText($state,[Text.Encoding]::UTF8) | ConvertFrom-Json
Assert ($cfg.apiConfig.token.Length -eq 64) 'Random API token not created'
Assert (!$cfg.apiConfig.allowUnauthenticated -and !$cfg.apiConfig.allowLanAccess) 'API defaults differ'
Assert (!$cfg.sourceWatchConfig.($result.id).autoIngest) 'Automatic model calls must be opt-in'
Assert ($cfg.('scheduledImportConfig:'+$result.path).path -eq $source) 'Shared-directory configuration missing'
Assert ($cfg.('scheduledImportConfig:'+$result.path).interval -eq 1) 'Expected one-minute scan configuration'
$reconciliation=[IO.File]::ReadAllText((Join-Path $project '.llm-wiki/source-reconciliation.json')) | ConvertFrom-Json
Assert ($reconciliation.enabled -and !$reconciliation.blocked -and $reconciliation.generation -eq 0) 'Managed features not enabled'
Assert ([IO.File]::ReadAllText((Join-Path $project 'schema.md')) -match 'Comparisons') 'Original page schema missing'
$before=(Get-FileHash $state).Hash;$rejected=$false
try{New-ManagedWiki -ProjectPath (Join-Path $TestRoot 'other') -Name 'No overwrite' -StatePath $state | Out-Null}catch{$rejected=$true}
Assert $rejected 'Existing profile must be rejected'
Assert ((Get-FileHash $state).Hash -eq $before) 'Existing profile changed'
$rejected=$false
try{New-ManagedWiki -ProjectPath (Join-Path $source 'nested') -Name 'Nested fixture' -SourcePath $source -StatePath (Join-Path $TestRoot 'nested-profile.json') | Out-Null}catch{$rejected=$true}
Assert $rejected 'Nested source and knowledge directory must be rejected'
$rejected=$false
try{New-ManagedWiki -ProjectPath $source -Name 'Existing data' -StatePath (Join-Path $TestRoot 'existing-profile.json') | Out-Null}catch{$rejected=$true}
Assert $rejected 'Nonempty existing knowledge directory must be rejected'
Assert ((Get-FileHash -LiteralPath (Join-Path $source 'manual.txt')).Hash -eq $sourceHash) 'Source document changed'
Write-Output 'PASS: managed project, default scan, opt-in model calls, fresh token, original schema, existing profile/data preservation, directory isolation and unchanged source.'
$defaultState=Join-Path $TestRoot 'default-profile/app-state.json'
$defaultResult=New-ManagedWiki -ProjectPath (Join-Path $TestRoot 'default-knowledge') -Name 'Enterprise default' -StatePath $defaultState
$defaultConfig=[IO.File]::ReadAllText($defaultState,[Text.Encoding]::UTF8) | ConvertFrom-Json
$packagedDefault=[IO.File]::ReadAllText((Join-Path $ScriptsRoot 'foxess-default-model.json'),[Text.Encoding]::UTF8) | ConvertFrom-Json
$packagedCredential=!(($packagedDefault.PSObject.Properties.Name -contains 'credentialIncluded') -and !$packagedDefault.credentialIncluded)
if($packagedCredential){
  Assert ($defaultConfig.activePresetId -eq 'foxess-default') 'Enterprise default not selected'
  Assert ($defaultConfig.llmConfig.apiKey -eq '__FOXESS_BUILTIN_CREDENTIAL__') 'Default profile must contain only the public credential marker'
  Assert ($defaultResult.modelConfigured) 'Enterprise installation without model fields must be ready'
}else{
  Assert (!$defaultConfig.activePresetId) 'Public installation must not activate an unavailable credential preset'
  Assert ($defaultConfig.llmConfig.apiKey -eq '') 'Public installation must have an empty model key'
  Assert (!$defaultResult.modelConfigured) 'Public installation must not claim an unconfigured model is ready'
}
Write-Output 'PASS: packaged credential mode is represented accurately; existing profiles are preserved.'
foreach($mode in @('public','enterprise')){
  $fixtureScripts=Join-Path $TestRoot ('model-profile-fixtures/'+$mode+'/scripts')
  [IO.Directory]::CreateDirectory($fixtureScripts) | Out-Null
  foreach($name in @('Initialize.ps1','source-watch-defaults.json')){Copy-Item -LiteralPath (Join-Path $ScriptsRoot $name) -Destination (Join-Path $fixtureScripts $name)}
  Copy-Item -LiteralPath (Join-Path $ScriptsRoot 'templates') -Destination (Join-Path $fixtureScripts 'templates') -Recurse
  $meta=[IO.File]::ReadAllText((Join-Path $ScriptsRoot 'foxess-default-model.json'),[Text.Encoding]::UTF8) | ConvertFrom-Json
  $meta | Add-Member -NotePropertyName credentialIncluded -NotePropertyValue ($mode -eq 'enterprise') -Force
  [IO.File]::WriteAllText((Join-Path $fixtureScripts 'foxess-default-model.json'),($meta | ConvertTo-Json),[Text.UTF8Encoding]::new($false))
  . (Join-Path $fixtureScripts 'Initialize.ps1')
  $modeState=Join-Path $TestRoot ($mode+'-mode-profile/app-state.json')
  $modeResult=New-ManagedWiki -ProjectPath (Join-Path $TestRoot ($mode+'-mode-knowledge')) -Name ($mode+' fixture') -StatePath $modeState
  $modeConfig=[IO.File]::ReadAllText($modeState,[Text.Encoding]::UTF8) | ConvertFrom-Json
  if($mode -eq 'public'){
    Assert (!$modeResult.modelConfigured -and $modeConfig.llmConfig.apiKey -eq '' -and !$modeConfig.activePresetId) 'Public mode falsely claims a built-in key is configured'
  }else{
    Assert ($modeResult.modelConfigured -and $modeConfig.llmConfig.apiKey -eq '__FOXESS_BUILTIN_CREDENTIAL__') 'Enterprise mode must use only the credential marker'
  }
}
Write-Output 'PASS: isolated public and enterprise first-run models, no real model calls.'
