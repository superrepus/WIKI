Set-StrictMode -Version 2
$ErrorActionPreference='Stop'
function Write-Utf8Json {
  param([string]$Path,$Value,[switch]$CreateOnly)
  $parent=Split-Path -Parent $Path
  [IO.Directory]::CreateDirectory($parent) | Out-Null
  $temp=$Path+'.'+[guid]::NewGuid().ToString('N')+'.tmp'
  [IO.File]::WriteAllText($temp,($Value | ConvertTo-Json -Depth 100),[Text.UTF8Encoding]::new($false))
  try {
    if(!$CreateOnly -and [IO.File]::Exists($Path)){[IO.File]::Replace($temp,$Path,$null)}else{[IO.File]::Move($temp,$Path)}
  } finally {if([IO.File]::Exists($temp)){[IO.File]::Delete($temp)}}
}
function New-ManagedWiki {
  param([string]$ProjectPath,[string]$Name,[string]$SourcePath,[string]$BaseUrl,[string]$Model,[string]$ApiKey,[string]$StatePath,[bool]$AutoIngest=$false)
  # This is first-run provisioning only. Never rewrite an existing app profile or attach by overwriting files.
  if(Test-Path -LiteralPath $StatePath){throw 'Existing application settings found. Use the application to manage existing projects; no settings were changed.'}
  $projectRoot=[IO.Path]::GetFullPath($ProjectPath).TrimEnd('\','/')
  $installRoot=[IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent)).TrimEnd('\')
  if($projectRoot.Equals($installRoot,[StringComparison]::OrdinalIgnoreCase) -or $projectRoot.StartsWith($installRoot+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Choose a knowledge directory outside the program directory.'}
  if((Test-Path -LiteralPath $projectRoot) -and @(Get-ChildItem -LiteralPath $projectRoot -Force).Count){throw 'Choose an empty directory for a new knowledge base. Existing projects must be opened in the application.'}
  if($SourcePath){
    $sourceRoot=[IO.Path]::GetFullPath($SourcePath).TrimEnd('\','/')
    if(!(Test-Path -LiteralPath $sourceRoot -PathType Container)){throw 'The current Windows account cannot access the source directory.'}
    if($projectRoot.Equals($sourceRoot,[StringComparison]::OrdinalIgnoreCase) -or $projectRoot.StartsWith($sourceRoot+'\',[StringComparison]::OrdinalIgnoreCase) -or $sourceRoot.StartsWith($projectRoot+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Source and knowledge directories must not contain each other.'}
    # Check enumeration permission without reading source document bodies.
    $null=Get-ChildItem -LiteralPath $sourceRoot -Force | Select-Object -First 1
  }
  if($BaseUrl){$uri=[uri]$BaseUrl;if($uri.Scheme -notin @('http','https') -or !$uri.Host){throw 'Model Base URL must be an absolute HTTP(S) URL.'}}
  $useEnterprise=(!$BaseUrl -and !$Model)
  $enterprise=$null
  $builtinCredentialAvailable=$false
  if($useEnterprise){
    $enterprise=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'foxess-default-model.json'),[Text.Encoding]::UTF8) | ConvertFrom-Json
    # Missing metadata preserves the original r5 enterprise installer behavior.
    $builtinCredentialAvailable=!(($enterprise.PSObject.Properties.Name -contains 'credentialIncluded') -and !$enterprise.credentialIncluded)
  }
  if(!$useEnterprise -and (!$BaseUrl -or !$Model)){throw 'Provide both model Base URL and model name, or leave both empty to use the enterprise default.'}
  if($AutoIngest -and !$SourcePath){throw 'Automatic ingestion requires a source directory.'}
  if($AutoIngest -and $useEnterprise -and !$builtinCredentialAvailable){throw 'The public installer does not include a model key. Configure a model before enabling automatic ingestion.'}
  $id=[guid]::NewGuid().ToString();$now=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  foreach($relative in @('raw/sources','raw/assets','wiki/entities','wiki/concepts','wiki/sources','wiki/queries','wiki/comparisons','wiki/synthesis','wiki/topics','.llm-wiki')){[IO.Directory]::CreateDirectory((Join-Path $projectRoot $relative)) | Out-Null}
  foreach($file in @('schema.md','purpose.md','wiki/index.md','wiki/overview.md','wiki/log.md')){
    $text=[IO.File]::ReadAllText((Join-Path $PSScriptRoot ('templates/'+$file)),[Text.Encoding]::UTF8)
    [IO.File]::WriteAllText((Join-Path $projectRoot $file),$text,[Text.UTF8Encoding]::new($false))
  }
  Write-Utf8Json (Join-Path $projectRoot '.llm-wiki/project.json') @{id=$id;createdAt=$now}
  Write-Utf8Json (Join-Path $projectRoot '.llm-wiki/source-reconciliation.json') @{version=1;enabled=$true;generation=0;blocked=$false;sources=@{};pages=@{};pendingSources=@()}
  $project=@{id=$id;name=$Name;path=$projectRoot.Replace('\','/')}
  $modelConfig=@{provider='custom';model=$Model;apiKey=$ApiKey;customEndpoint=$BaseUrl;ollamaUrl='http://localhost:11434';apiMode='chat_completions';maxContextSize=64000;requestTimeoutMinutes=10;streamingEnabled=$false;reasoning=@{mode='off'};ingestReasoning=@{mode='off'}}
  if($useEnterprise){$modelConfig.model=$enterprise.defaultModel;$modelConfig.customEndpoint=$enterprise.baseUrl;$modelConfig.apiKey=$(if($builtinCredentialAvailable){$enterprise.credentialMarker}else{''});$modelConfig.maxContextSize=$enterprise.suggestedContextSize;$modelConfig.requestTimeoutMinutes=$enterprise.requestTimeoutMinutes}
  $rng=[Security.Cryptography.RandomNumberGenerator]::Create();$bytes=New-Object byte[] 32;$rng.GetBytes($bytes);$rng.Dispose()
  $token=[BitConverter]::ToString($bytes).Replace('-','').ToLowerInvariant()
  $watch=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'source-watch-defaults.json')) | ConvertFrom-Json
  $watch.autoIngest=$AutoIngest;$watch.persistExtractedMarkdown=$true;$watch.ingestConcurrency=1
  $state=@{language='zh';outputLanguage='Chinese';llmConfig=$modelConfig;lastProject=$project;recentProjects=@($project);projectRegistry=@{$id=$project};
    projectOutputLanguages=@{$id='Chinese'};sourceWatchConfig=@{$id=$watch};sourceWatchAllProjects=$false;
    taskModelRouting=@{chatPresetId=$null;ingestPresetId=$null};proxyConfig=@{enabled=$false;url='';bypassLocal=$true};
    apiConfig=@{enabled=$true;mcpEnabled=$true;allowUnauthenticated=$false;allowLanAccess=$false;token=$token}}
  $state['scheduledImportConfig:'+$project.path]=@{enabled=[bool]$SourcePath;path=$SourcePath;interval=1;lastScan=$null}
  if($useEnterprise -and $builtinCredentialAvailable){$state.activePresetId='foxess-default'}else{$state.activePresetId=$null}
  Write-Utf8Json $StatePath $state -CreateOnly
  return @{id=$id;path=$project.path;autoIngest=$AutoIngest;sourceConfigured=[bool]$SourcePath;modelConfigured=[bool](($useEnterprise -and $builtinCredentialAvailable) -or ($BaseUrl -and $Model))}
}
