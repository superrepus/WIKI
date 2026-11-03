param([Parameter(Position=0)][string]$Command='status',[Parameter(Position=1)][string]$Value,[string]$Project='current',[int]$Limit=100,[int]$Offset=0,[string]$Kind,[string]$Status,[string]$Query,[string]$Type,[string]$Model,[string]$Source,[string]$TaskId,[long]$Since=0,[long]$Until=0)
$ErrorActionPreference='Stop'
$base=$env:LLM_WIKI_API_BASE_URL;if(!$base){$base='http://127.0.0.1:19828'}
$base=$base.TrimEnd('/');if(!$base.EndsWith('/api/v1')){$base+='/api/v1'}
$token=$env:LLM_WIKI_API_TOKEN
if(!$token){$profile=Join-Path $env:APPDATA 'com.llmwiki.app/app-state.json';$settings=[IO.File]::ReadAllText($profile,[Text.Encoding]::UTF8) | ConvertFrom-Json;$token=$settings.apiConfig.token}
function Invoke-Wiki($Path,$Body=$null){
  $req=[Net.HttpWebRequest]::Create($base+$Path);$req.Proxy=$null;$req.Timeout=600000;$req.Headers['Authorization']='Bearer '+$token
  if($null -ne $Body){$req.Method='POST';$req.ContentType='application/json';$bytes=[Text.Encoding]::UTF8.GetBytes(($Body | ConvertTo-Json -Depth 20 -Compress));$req.ContentLength=$bytes.Length;$stream=$req.GetRequestStream();$stream.Write($bytes,0,$bytes.Length);$stream.Dispose()}
  $resp=$req.GetResponse();$reader=New-Object IO.StreamReader($resp.GetResponseStream(),[Text.Encoding]::UTF8)
  try{return ($reader.ReadToEnd() | ConvertFrom-Json)}finally{$reader.Dispose();$resp.Dispose()}
}
try{
  $prefix='/projects/'+[uri]::EscapeDataString($Project)
  switch($Command){
    'status' {$result=@{health=(Invoke-Wiki '/health');projects=(Invoke-Wiki '/projects')}}
    'projects' {$result=Invoke-Wiki '/projects'}
    'files' {$result=Invoke-Wiki ($prefix+'/files?recursive=true')}
    'inventory' {$result=Invoke-Wiki ($prefix+'/files?root=sources&recursive=true')}
    'graph' {$result=Invoke-Wiki ($prefix+'/graph')}
    'reviews' {$result=Invoke-Wiki ($prefix+'/reviews')}
    'routing' {$result=Invoke-Wiki ($prefix+'/model-routing')}
    'rescan' {$result=Invoke-Wiki ($prefix+'/sources/rescan') @{}}
    'read' {$result=Invoke-Wiki ($prefix+'/files/content?path='+[uri]::EscapeDataString($Value))}
    'search' {$result=Invoke-Wiki ($prefix+'/search') @{query=$Value;topK=$Limit;includeContent=$true}}
    'chat' {$result=Invoke-Wiki ($prefix+'/chat') @{message=$Value;stream=$false;retrievalMode='faithful'}}
    {$_ -in @('catalog','metrics')} {
      $filters=@{offset=$Offset;limit=$Limit};foreach($item in @(@('kind',$Kind),@('status',$Status),@('q',$Query),@('type',$Type),@('model',$Model),@('source',$Source),@('taskId',$TaskId),@('since',$Since),@('until',$Until))){if($item[1]){$filters[$item[0]]=$item[1]}}
      $qs=($filters.GetEnumerator() | ForEach-Object {[uri]::EscapeDataString($_.Key)+'='+[uri]::EscapeDataString([string]$_.Value)}) -join '&'
      $route=if($Command -eq 'catalog'){'catalog'}else{'task-metrics'};$result=Invoke-Wiki ($prefix+'/'+$route+'?'+$qs)
    }
    default {throw 'Commands: status, projects, files, inventory, graph, reviews, routing, rescan, read, search, chat, catalog, metrics'}
  }
  [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$result | ConvertTo-Json -Depth 100
}catch{[Console]::Error.WriteLine('LLM Wiki API request failed: '+$_.Exception.Message);exit 1}
