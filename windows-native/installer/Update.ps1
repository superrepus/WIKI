param([Parameter(Mandatory)][string]$Plan)
$ErrorActionPreference='Stop'
Import-Module "$PSHOME/Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1" -ErrorAction Stop

# Only this trusted embedded helper may install a native-verified release. It
# receives a fixed JSON file, never a shell command or an arbitrary download URL.
function FullPath([string]$Value) {
  if([string]::IsNullOrWhiteSpace($Value) -or $Value -match '[\x00-\x1f"]' -or ![IO.Path]::IsPathRooted($Value)){throw 'Invalid absolute update path'}
  return [IO.Path]::GetFullPath($Value).TrimEnd('\','/')
}
function IsWithin([string]$Path,[string]$Directory) {
  $left=FullPath $Path; $right=FullPath $Directory
  return $left.Equals($right,[StringComparison]::OrdinalIgnoreCase) -or $left.StartsWith($right+'\',[StringComparison]::OrdinalIgnoreCase)
}
function NoReparse([string]$Path) {
  $node=FullPath $Path
  while($node) {
    if(Test-Path -LiteralPath $node) {
      $item=Get-Item -LiteralPath $node -Force
      if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Reparse points are not supported for program updates'}
    }
    $parent=[IO.Path]::GetDirectoryName($node)
    if($parent -eq $node){break}; $node=$parent
  }
}
function ManagedPath([string]$Root,[string]$Relative) {
  if([string]::IsNullOrWhiteSpace($Relative) -or [IO.Path]::IsPathRooted($Relative) -or $Relative -match '[:\x00-\x1f"]' -or @($Relative.Replace('\','/').Split('/') | Where-Object {$_ -in @('','.','..')}).Count){throw 'Unsafe program manifest path'}
  $destination=FullPath (Join-Path $Root $Relative)
  if(!(IsWithin $destination $Root)){throw 'Program manifest escaped install root'}
  NoReparse $destination
  return $destination
}
function ReadJson([string]$Path) {
  if((Get-Item -LiteralPath $Path).Length -gt 8MB){throw 'Oversized update metadata'}
  return [IO.File]::ReadAllText($Path,[Text.Encoding]::UTF8) | ConvertFrom-Json
}
function WriteJson([string]$Path,$Value) {
  $parent=Split-Path $Path -Parent
  if(!(Test-Path -LiteralPath $parent)){[IO.Directory]::CreateDirectory($parent) | Out-Null}
  $temporary=$Path+'.tmp'
  [IO.File]::WriteAllText($temporary,($Value | ConvertTo-Json -Depth 12),[Text.UTF8Encoding]::new($false))
  if(Test-Path -LiteralPath $Path){
    $previous=$Path+'.previous-'+[Guid]::NewGuid().ToString('N')
    [IO.File]::Replace($temporary,$Path,$previous)
    Remove-Item -LiteralPath $previous -Force
  }else{[IO.File]::Move($temporary,$Path)}
}
function Hash([string]$Path) {return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()}
function RunInstaller([string]$File,[string[]]$Arguments) {
  # Keep the process handle alive before waiting: Windows PowerShell 5.1 can
  # otherwise expose a null ExitCode for a quickly exiting child process.
  $process=Start-Process -FilePath $File -ArgumentList $Arguments -WindowStyle Hidden -PassThru
  $processHandle=$process.Handle
  $process.WaitForExit()
  $process.Refresh()
  return $process.ExitCode
}
function Manifest([string]$Root) {
  $value=ReadJson (Join-Path $Root 'install-manifest.json')
  if($value.product -ne 'FoxEss WIKI' -or !$value.files -or @($value.files | Where-Object {$_.path -eq 'app/llm-wiki.exe'}).Count -ne 1){throw 'Invalid FoxEss WIKI installation manifest'}
  $seen=@{}
  foreach($entry in $value.files) {
    $path=ManagedPath $Root $entry.path
    $key=$entry.path.Replace('\','/').ToLowerInvariant()
    if($seen.ContainsKey($key) -or $entry.sha256 -notmatch '^[a-fA-F0-9]{64}$'){throw 'Duplicate or invalid program manifest entry'}
    $seen[$key]=$true
  }
  return $value
}
function StartWiki {
  if(!(Test-Path -LiteralPath $script:executable)){return}
  $running=@(Get-Process -Name 'llm-wiki' -ErrorAction SilentlyContinue | Where-Object {try{$_.Path -eq $script:executable}catch{$false}})
  if(!$running.Count){Start-Process -FilePath $script:executable -WorkingDirectory (Split-Path $script:executable -Parent) -WindowStyle Hidden | Out-Null}
}
function Result([string]$Status,[string]$Message) {
  WriteJson $script:resultFile @{status=$Status;version=$script:configuration.version;message=$Message;completedAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()}
}

$configuration=$null; $resultFile=$null; $root=$null; $executable=$null; $installAttempted=$false; $backupComplete=$false
try {
  $runRoot=FullPath $PSScriptRoot
  $planPath=FullPath $Plan
  if(!(Split-Path $planPath -Parent).Equals($runRoot,[StringComparison]::OrdinalIgnoreCase)){throw 'Plan is outside the update staging directory'}
  NoReparse $runRoot
  $configuration=ReadJson $planPath
  if($configuration.schema -ne 1 -or $configuration.version -notmatch '^\d+\.\d+\.\d+$' -or $configuration.parentPid -le 0 -or $configuration.installerSha256 -notmatch '^[a-fA-F0-9]{64}$' -or $configuration.executableSha256 -notmatch '^[a-fA-F0-9]{64}$'){throw 'Invalid verified update plan'}
  $root=FullPath $configuration.installRoot
  if($root -notmatch '^[a-zA-Z]:\\'){throw 'Updates require a local Windows installation'}
  NoReparse $root
  $executable=FullPath $configuration.executable
  if(!$executable.Equals((Join-Path $root 'app\llm-wiki.exe'),[StringComparison]::OrdinalIgnoreCase)){throw 'Unexpected application executable'}
  $installer=FullPath $configuration.installer
  if(!(Split-Path $installer -Parent).Equals($runRoot,[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($installer) -ne ('FoxEss-WIKI-'+$configuration.version+'-x64-Setup.exe')){throw 'Unexpected update installer'}
  $resultFile=FullPath $configuration.resultFile
  $expectedResult=Join-Path (Split-Path $runRoot -Parent) 'last-update-result.json'
  if(!$resultFile.Equals($expectedResult,[StringComparison]::OrdinalIgnoreCase)){throw 'Unexpected update result path'}
  $old=Manifest $root
  if((Hash $installer) -ne $configuration.installerSha256.ToLowerInvariant()){throw 'Installer changed after download verification'}
  $ready=Join-Path $runRoot 'helper.ready'; $commit=Join-Path $runRoot 'commit.update'; $cancel=Join-Path $runRoot 'cancel.update'
  if(Test-Path -LiteralPath $cancel){exit 21}
  [IO.File]::WriteAllText($ready,'ready')
  $deadline=[DateTime]::UtcNow.AddMinutes(30)
  while(!(Test-Path -LiteralPath $commit)) {
    if((Test-Path -LiteralPath $cancel) -or [DateTime]::UtcNow -gt $deadline){exit 21}
    Start-Sleep -Milliseconds 100
  }
  if(Test-Path -LiteralPath $cancel){exit 21}
  try {
    $parent=Get-Process -Id ([int]$configuration.parentPid) -ErrorAction Stop
    if(!$parent.Path.Equals($executable,[StringComparison]::OrdinalIgnoreCase)){throw 'Parent process identity changed'}
    $remaining=[Math]::Max(1,[int]($deadline-[DateTime]::UtcNow).TotalMilliseconds)
    if(!$parent.WaitForExit($remaining)){throw 'Application did not exit; update cancelled without terminating it'}
  }catch [Microsoft.PowerShell.Commands.ProcessCommandException] { }
  if((Test-Path -LiteralPath $cancel) -or [DateTime]::UtcNow -gt $deadline){exit 21}
  if(Get-Process -Name 'llm-wiki' -ErrorAction SilentlyContinue){throw 'Another FoxEss WIKI process is still running'}
  $staging=Join-Path $runRoot 'extracted'
  if(Test-Path -LiteralPath $staging){throw 'Update extraction directory must be fresh'}
  $extractExit=RunInstaller $installer @('/S','/EXTRACTONLY',('/D='+$staging))
  if($extractExit -ne 0 -or !(Test-Path -LiteralPath (Join-Path $staging 'extract-only.marker'))){throw 'Verified installer extraction failed'}
  $next=Manifest $staging
  if($next.version -ne $configuration.version){throw 'Extracted version differs from signed release'}
  foreach($entry in $next.files) {
    $path=ManagedPath $staging $entry.path
    if(!(Test-Path -LiteralPath $path -PathType Leaf) -or (Get-Item -LiteralPath $path).Length -ne $entry.size -or (Hash $path) -ne $entry.sha256.ToLowerInvariant()){throw 'Extracted program payload is damaged'}
  }
  if((Hash (Join-Path $staging 'app\llm-wiki.exe')) -ne $configuration.executableSha256.ToLowerInvariant()){throw 'Extracted application differs from signed release'}
  $oldPaths=@{}
  foreach($entry in $old.files){$oldPaths[$entry.path.Replace('\','/').ToLowerInvariant()]=$true}
  foreach($entry in $next.files) {
    $destination=ManagedPath $root $entry.path
    if((Test-Path -LiteralPath $destination) -and !$oldPaths.ContainsKey($entry.path.Replace('\','/').ToLowerInvariant())){throw 'A new program file would overwrite unknown user content'}
  }
  $backup=Join-Path $runRoot 'backup'; [IO.Directory]::CreateDirectory($backup) | Out-Null
  $backedUp=@()
  foreach($relative in @($old.files.path)+@('install-manifest.json','Uninstall.exe')) {
    $path=ManagedPath $root $relative
    if(Test-Path -LiteralPath $path -PathType Leaf) {
      $copy=ManagedPath $backup $relative
      [IO.Directory]::CreateDirectory((Split-Path $copy -Parent)) | Out-Null
      Copy-Item -LiteralPath $path -Destination $copy
      if((Hash $copy) -ne (Hash $path)){throw 'Program backup verification failed'}
      $backedUp+=@{path=$relative;sha256=(Hash $copy)}
    }
  }
  WriteJson (Join-Path $runRoot 'backup-manifest.json') @{files=$backedUp}
  $backupComplete=$true
  if(Get-Process -Name 'llm-wiki' -ErrorAction SilentlyContinue){throw 'FoxEss WIKI was reopened before installation'}
  $installAttempted=$true
  $installExit=RunInstaller $installer @('/S','/UPDATE',('/D='+$root))
  if($installExit -ne 0){throw 'Installer did not complete successfully'}
  $installed=Manifest $root
  if($installed.version -ne $configuration.version -or (Hash $executable) -ne $configuration.executableSha256.ToLowerInvariant()){throw 'Installed version verification failed'}
  foreach($entry in $installed.files) {
    $path=ManagedPath $root $entry.path
    if(!(Test-Path -LiteralPath $path -PathType Leaf) -or (Get-Item -LiteralPath $path).Length -ne $entry.size -or (Hash $path) -ne $entry.sha256.ToLowerInvariant()){throw 'Installed program payload verification failed'}
  }
  Result 'updated' '更新已完成，已重启 FoxEss WIKI。'
  StartWiki
  exit 0
}catch {
  $detail=$_.Exception.Message
  try {if($runRoot){[IO.File]::WriteAllText((Join-Path $runRoot 'update-error.log'),$detail,[Text.UTF8Encoding]::new($false))}}catch{}
  if($installAttempted -and $backupComplete) {
    try {
      # Restore only known program files. Unknown user directories are never moved
      # or recursively deleted, even when a partially completed installer fails.
      foreach($entry in $next.files) {
        $destination=ManagedPath $root $entry.path
        if(!$oldPaths.ContainsKey($entry.path.Replace('\','/').ToLowerInvariant()) -and (Test-Path -LiteralPath $destination -PathType Leaf)) {
          if((Hash $destination) -eq $entry.sha256.ToLowerInvariant()){Remove-Item -LiteralPath $destination -Force}
        }
      }
      foreach($entry in $backedUp) {
        $source=ManagedPath $backup $entry.path; $destination=ManagedPath $root $entry.path
        [IO.Directory]::CreateDirectory((Split-Path $destination -Parent)) | Out-Null
        Copy-Item -LiteralPath $source -Destination $destination -Force
        if((Hash $destination) -ne $entry.sha256){throw 'Rollback program verification failed'}
      }
      Result 'rolled-back' '更新未完成，已恢复旧程序；原有配置和知识库保留。'
      StartWiki
      exit 40
    }catch {
      try {Result 'failed' '更新失败，程序恢复未完成；原有配置和知识库未修改。请运行安装包修复程序。'}catch{}
      exit 41
    }
  }
  try {if($resultFile){Result 'failed' '更新未完成，原程序、配置和知识库保留。'}}catch{}
  # A timeout must never launch a competing app while the original remains alive.
  try {if($executable -and !(Get-Process -Name 'llm-wiki' -ErrorAction SilentlyContinue)){StartWiki}}catch{}
  exit 42
}
