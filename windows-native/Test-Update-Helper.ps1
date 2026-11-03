param([string]$TestRoot)
$ErrorActionPreference='Stop'
Import-Module "$PSHOME/Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1" -ErrorAction Stop
$repo=Split-Path $PSScriptRoot -Parent
if(!$TestRoot){$TestRoot=Join-Path $repo ('.installer-tests/update-helper-'+[Guid]::NewGuid().ToString('N'))}
$TestRoot=[IO.Path]::GetFullPath($TestRoot)
$safeRoot=[IO.Path]::GetFullPath((Join-Path $repo '.installer-tests')).TrimEnd('\')+'\'
if(!$TestRoot.StartsWith($safeRoot,[StringComparison]::OrdinalIgnoreCase) -or (Test-Path -LiteralPath $TestRoot)){throw 'Fixture root must be a fresh checkout .installer-tests child'}
[IO.Directory]::CreateDirectory($TestRoot) | Out-Null
function Assert($Value,[string]$Message){if(!$Value){throw $Message}}
function Hash([string]$Path){return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()}
function Json([string]$Path,$Value){[IO.File]::WriteAllText($Path,($Value | ConvertTo-Json -Depth 12),[Text.UTF8Encoding]::new($false))}
function CompileApp([string]$Name,[string]$Path){
  $code=@'
using System;
using System.IO;
using System.Threading;
public class CLASS_NAME {
  public static void Main(string[] args) {
    if(args.Length>0 && args[0]=="-hold"){Thread.Sleep(5000);return;}
    File.WriteAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"MARKER_NAME-launched.marker"),"synthetic-only");
  }
}
'@
  Add-Type -TypeDefinition $code.Replace('CLASS_NAME',($Name+'Program')).Replace('MARKER_NAME',$Name) -OutputAssembly $Path -OutputType ConsoleApplication
}
$templates=Join-Path $TestRoot 'templates';[IO.Directory]::CreateDirectory($templates) | Out-Null
CompileApp 'old' (Join-Path $templates 'old.exe')
CompileApp 'new' (Join-Path $templates 'new.exe')
$installerCode=@'
using System;
using System.IO;
using System.Linq;
public class InstallerFixtureProgram {
  public static int Main(string[] args) {
    File.WriteAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"synthetic-installer-args.txt"),String.Join("|",args)+"\n"+Environment.GetEnvironmentVariable("FOXESS_UPDATE_FIXTURE_PAYLOAD"));
    int start=Array.FindIndex(args,a=>a.StartsWith("/D="));
    if(start<0)return 70;
    string target=String.Join(" ",args.Skip(start)).Substring(3);
    string payload=Environment.GetEnvironmentVariable("FOXESS_UPDATE_FIXTURE_PAYLOAD");
    bool extract=args.Contains("/EXTRACTONLY");
    Directory.CreateDirectory(target);
    if(!extract && Environment.GetEnvironmentVariable("FOXESS_UPDATE_FIXTURE_MODE")=="failure") {
      Directory.CreateDirectory(Path.Combine(target,"app"));
      File.Copy(Path.Combine(payload,"app","llm-wiki.exe"),Path.Combine(target,"app","llm-wiki.exe"),true);
      return 37;
    }
    foreach(string file in Directory.GetFiles(payload,"*",SearchOption.AllDirectories)) {
      string relative=file.Substring(payload.Length).TrimStart(Path.DirectorySeparatorChar);
      string destination=Path.Combine(target,relative);
      Directory.CreateDirectory(Path.GetDirectoryName(destination));
      File.Copy(file,destination,true);
    }
    if(extract)File.WriteAllText(Path.Combine(target,"extract-only.marker"),"synthetic-only");
    return 0;
  }
}
'@
Add-Type -TypeDefinition $installerCode -ReferencedAssemblies @('System.dll','System.Core.dll') -OutputAssembly (Join-Path $templates 'installer.exe') -OutputType ConsoleApplication
$helper=Join-Path $repo 'windows-native/installer/Update.ps1'
$powershell=Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
$records=@()
$previousPayload=$env:FOXESS_UPDATE_FIXTURE_PAYLOAD;$previousMode=$env:FOXESS_UPDATE_FIXTURE_MODE
try {
 foreach($mode in @('success','failure','collision','cancel')) {
  $case=Join-Path $TestRoot $mode
  $root=Join-Path $case 'installed app';$cache=Join-Path $case 'cache';$run=Join-Path $cache 'run';$payload=Join-Path $case 'new payload'
  foreach($dir in @((Join-Path $root 'app'),$run,(Join-Path $payload 'app'),(Join-Path $root 'knowledge/wiki'))){[IO.Directory]::CreateDirectory($dir) | Out-Null}
  $exe=Join-Path $root 'app/llm-wiki.exe'
  Copy-Item -LiteralPath (Join-Path $templates 'old.exe') -Destination $exe
  [IO.File]::WriteAllText((Join-Path $root 'readme.txt'),'old-program-file')
  [IO.File]::WriteAllText((Join-Path $root 'Uninstall.exe'),'synthetic-uninstaller')
  [IO.File]::WriteAllText((Join-Path $root 'knowledge/wiki/user-page.md'),'USER_KNOWLEDGE_MUST_SURVIVE')
  [IO.File]::WriteAllText((Join-Path $case 'model-config.json'),'SYNTHETIC_USER_CONFIGURATION')
  $userHash=Hash (Join-Path $root 'knowledge/wiki/user-page.md');$configHash=Hash (Join-Path $case 'model-config.json')
  $oldFiles=@('app/llm-wiki.exe','readme.txt') | ForEach-Object {$p=Join-Path $root $_;@{path=$_;sha256=(Hash $p);size=(Get-Item -LiteralPath $p).Length}}
  Json (Join-Path $root 'install-manifest.json') @{product='FoxEss WIKI';version='1.0.0';files=@($oldFiles)}
  $oldExeHash=Hash $exe;$oldManifestHash=Hash (Join-Path $root 'install-manifest.json')
  Copy-Item -LiteralPath (Join-Path $templates 'new.exe') -Destination (Join-Path $payload 'app/llm-wiki.exe')
  [IO.File]::WriteAllText((Join-Path $payload 'readme.txt'),'new-program-file')
  [IO.File]::WriteAllText((Join-Path $payload 'Uninstall.exe'),'synthetic-new-uninstaller')
  $newPaths=@('app/llm-wiki.exe','readme.txt')
  if($mode -eq 'collision') {
    [IO.File]::WriteAllText((Join-Path $root 'new-only.txt'),'UNKNOWN_USER_FILE')
    [IO.File]::WriteAllText((Join-Path $payload 'new-only.txt'),'NEW_PROGRAM_FILE')
    $newPaths+='new-only.txt'
  }
  $newFiles=$newPaths | ForEach-Object {$p=Join-Path $payload $_;@{path=$_;sha256=(Hash $p);size=(Get-Item -LiteralPath $p).Length}}
  Json (Join-Path $payload 'install-manifest.json') @{product='FoxEss WIKI';version='1.1.0';files=@($newFiles)}
  $installer=Join-Path $run 'FoxEss-WIKI-1.1.0-x64-Setup.exe'
  Copy-Item -LiteralPath (Join-Path $templates 'installer.exe') -Destination $installer
  # UTF-8 BOM is intentional: production launches Windows PowerShell 5.1.
  [IO.File]::WriteAllText((Join-Path $run 'Update.ps1'),[IO.File]::ReadAllText($helper,[Text.Encoding]::UTF8),[Text.UTF8Encoding]::new($true))
  $env:FOXESS_UPDATE_FIXTURE_PAYLOAD=$payload;$env:FOXESS_UPDATE_FIXTURE_MODE=$mode
  $parent=Start-Process -FilePath $exe -ArgumentList '-hold' -WindowStyle Hidden -PassThru
  $plan=Join-Path $run 'plan.json'
  Json $plan @{schema=1;version='1.1.0';parentPid=$parent.Id;installRoot=$root;executable=$exe;installer=$installer;installerSha256=(Hash $installer);executableSha256=(Hash (Join-Path $payload 'app/llm-wiki.exe'));resultFile=(Join-Path $cache 'last-update-result.json')}
  $process=Start-Process -FilePath $powershell -ArgumentList ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "'+(Join-Path $run 'Update.ps1')+'" -Plan "'+$plan+'"') -WindowStyle Hidden -PassThru
  $deadline=[DateTime]::UtcNow.AddSeconds(25)
  while(!(Test-Path -LiteralPath (Join-Path $run 'helper.ready')) -and !$process.HasExited -and [DateTime]::UtcNow -lt $deadline){Start-Sleep -Milliseconds 100;$process.Refresh()}
  Assert (Test-Path -LiteralPath (Join-Path $run 'helper.ready')) ('Fixture helper failed to become ready: '+$mode)
  if($mode -eq 'cancel'){[IO.File]::WriteAllText((Join-Path $run 'cancel.update'),'cancel')}else{[IO.File]::WriteAllText((Join-Path $run 'commit.update'),'commit')}
  Assert ($process.WaitForExit(90000)) ('Fixture helper timed out: '+$mode)
  $process.Refresh()
  $parent.WaitForExit()
  if($mode -eq 'success') {
    Assert ($process.ExitCode -eq 0) 'Synthetic successful update returned failure'
    Assert ((Hash $exe) -eq (Hash (Join-Path $payload 'app/llm-wiki.exe'))) 'New program was not installed'
    $result=[IO.File]::ReadAllText((Join-Path $cache 'last-update-result.json')) | ConvertFrom-Json
    Assert ($result.status -eq 'updated') 'Successful update status missing'
    $marker=Join-Path $root 'app/new-launched.marker'
  }else{
    Assert ((Hash $exe) -eq $oldExeHash) ('Old executable changed: '+$mode)
    Assert ((Hash (Join-Path $root 'install-manifest.json')) -eq $oldManifestHash) ('Old manifest changed: '+$mode)
    if($mode -eq 'failure') {
      $result=[IO.File]::ReadAllText((Join-Path $cache 'last-update-result.json')) | ConvertFrom-Json
      Assert ($result.status -eq 'rolled-back' -and $process.ExitCode -eq 40) 'Failed installer did not roll back'
    }
    if($mode -eq 'collision'){Assert ([IO.File]::ReadAllText((Join-Path $root 'new-only.txt')) -eq 'UNKNOWN_USER_FILE') 'Unknown user file was overwritten'}
    $marker=Join-Path $root 'app/old-launched.marker'
  }
  if($mode -ne 'cancel') {
    $deadline=[DateTime]::UtcNow.AddSeconds(10)
    while(!(Test-Path -LiteralPath $marker) -and [DateTime]::UtcNow -lt $deadline){Start-Sleep -Milliseconds 100}
    Assert (Test-Path -LiteralPath $marker) ('Synthetic program did not restart: '+$mode)
  }else{Assert (!(Test-Path -LiteralPath (Join-Path $run 'extracted'))) 'Cancelled update still extracted or installed'}
  Assert ((Hash (Join-Path $root 'knowledge/wiki/user-page.md')) -eq $userHash) 'Synthetic knowledge data changed'
  Assert ((Hash (Join-Path $case 'model-config.json')) -eq $configHash) 'Synthetic model configuration changed'
  $records+=@{scenario=$mode;passed=$true;exitCode=$process.ExitCode;syntheticKnowledgeAndConfigPreserved=$true}
 }
 $report=@{passed=$true;fixtureRoot=$TestRoot;helperSha256=(Hash $helper);scenarios=$records;realAppStarted=$false;realModelCalled=$false;realSharedDriveAccessed=$false;realProfileModified=$false}
 Json (Join-Path $repo 'windows-native/runtime/v1-update-helper-tests.json') $report
 Write-Output ($report | ConvertTo-Json -Depth 8 -Compress)
} finally {
 $env:FOXESS_UPDATE_FIXTURE_PAYLOAD=$previousPayload;$env:FOXESS_UPDATE_FIXTURE_MODE=$previousMode
}
