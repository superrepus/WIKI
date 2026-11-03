param([Parameter(Mandatory)][ValidateSet('Snapshot','Stage','Restore')][string]$Mode,[Parameter(Mandatory)][string]$FilePath,[Parameter(Mandatory)][string]$AckPath)
$ErrorActionPreference='Stop'
$repoRoot=[IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
foreach($target in @($FilePath,$AckPath)) {
  $absolute=[IO.Path]::GetFullPath($target)
  if(!$absolute.StartsWith($repoRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Upgrade files must remain inside this workspace'}
}
$store=Join-Path $env:APPDATA 'com.llmwiki.app/app-state.json'
try {
  if($Mode -eq 'Snapshot') {
    $bytes=[IO.File]::ReadAllBytes($store)
    $null=([Text.Encoding]::UTF8.GetString($bytes).TrimStart([char]0xfeff) | ConvertFrom-Json)
    [IO.File]::WriteAllBytes($FilePath,$bytes)
  } elseif($Mode -eq 'Restore') {
    $bytes=[IO.File]::ReadAllBytes($FilePath)
    $null=([Text.Encoding]::UTF8.GetString($bytes).TrimStart([char]0xfeff) | ConvertFrom-Json)
    [IO.File]::WriteAllBytes($store,$bytes)
  } else {
    $spec=[IO.File]::ReadAllText($FilePath,[Text.Encoding]::UTF8) | ConvertFrom-Json
    $cfg=[IO.File]::ReadAllText($store,[Text.Encoding]::UTF8) | ConvertFrom-Json
    function Put($name,$value){$cfg | Add-Member -NotePropertyName $name -NotePropertyValue $value -Force}
    $llm=@{provider='custom';model='global-model';apiKey='fixture-key';customEndpoint=$spec.modelEndpoint;ollamaUrl='';maxContextSize=64000;streamingEnabled=$false}
    Put 'llmConfig' $llm;Put 'globalLlmConfig' $llm;Put 'activePresetId' 'custom-upgrade-global'
    Put 'customLlmPresets' @(@{id='custom-upgrade-global';label='Upgrade global'},@{id='custom-upgrade-chat';label='Upgrade chat'},@{id='custom-upgrade-ingest';label='Upgrade ingest'})
    Put 'providerConfigs' @{'custom-upgrade-global'=@{model='global-model';apiKey='fixture-key';baseUrl=$spec.modelEndpoint;streamingEnabled=$false};'custom-upgrade-chat'=@{model='chat-route-model';baseUrl=$spec.modelEndpoint;streamingEnabled=$false};'custom-upgrade-ingest'=@{model='ingest-route-model';baseUrl=$spec.modelEndpoint;streamingEnabled=$false}}
    Put 'taskModelRouting' @{chatPresetId='custom-upgrade-chat';ingestPresetId='custom-upgrade-ingest'}
    Put 'lastProject' $spec.project;Put 'recentProjects' @($spec.project);Put 'projectRegistry' @{$spec.project.id=$spec.project};Put 'projectLlmOverrides' @{}
    Put 'sourceWatchConfig' @{$spec.project.id=@{enabled=$false;autoIngest=$false;ingestConcurrency=1;parsingConcurrency=1}}
    Put 'sourceWatchAllProjects' $false
    foreach($property in @($cfg.PSObject.Properties)) {if($property.Name.StartsWith('scheduledImportConfig:')){ $property.Value | Add-Member -NotePropertyName enabled -NotePropertyValue $false -Force }}
    Put 'proxyConfig' @{enabled=$false};Put 'embeddingConfig' @{enabled=$false};Put 'multimodalConfig' @{enabled=$false}
    Put 'apiConfig' @{enabled=$true;token=$spec.token;allowUnauthenticated=$false;allowLanAccess=$false;mcpEnabled=$true}
    [IO.File]::WriteAllText($store,($cfg | ConvertTo-Json -Depth 100),[Text.UTF8Encoding]::new($false))
  }
  $bytes=[IO.File]::ReadAllBytes($store)
  $actual=([Text.Encoding]::UTF8.GetString($bytes).TrimStart([char]0xfeff) | ConvertFrom-Json)
  $hash=[BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($bytes)).Replace('-','').ToLowerInvariant()
  @{ok=$true;mode=$Mode;model=$actual.llmConfig.model;context=$actual.llmConfig.maxContextSize;projectId=$actual.lastProject.id;bytes=$bytes.Length;sha256=$hash} |
    ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $AckPath -Encoding UTF8
} catch {
  @{ok=$false;mode=$Mode;error=$_.Exception.GetType().Name} | ConvertTo-Json | Set-Content -LiteralPath $AckPath -Encoding UTF8
  exit 1
}
