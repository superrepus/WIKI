param([switch]$Release,[switch]$Test,[switch]$NativeOnly,[ValidateSet('public','enterprise')][string]$CredentialMode='public')
$ErrorActionPreference='Stop'
$repoRoot=Split-Path $PSScriptRoot -Parent
$vsWhere='C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe'
$vsRoot=& $vsWhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if(!$vsRoot){throw '找不到 MSVC C++ 构建工具'}
$devCmd=Join-Path $vsRoot 'Common7\Tools\VsDevCmd.bat'
$envScript=Join-Path $repoRoot 'native-tools\build-env.cmd'
[IO.File]::WriteAllLines($envScript,@('@call "'+$devCmd+'" -arch=x64 >nul','@set'),[Text.Encoding]::ASCII)
$devEnv=& cmd.exe /d /c $envScript
foreach($line in $devEnv){
  if($line -match '^(INCLUDE|LIB|LIBPATH|Path|VCToolsInstallDir|WindowsSdkDir|WindowsSDKVersion|VCINSTALLDIR|VSINSTALLDIR)=(.*)$'){
    [Environment]::SetEnvironmentVariable($matches[1],$matches[2],'Process')
  }
}
$rustBin=Join-Path $repoRoot 'native-tools\manual-rust\bin'
$env:PATH=$rustBin+';'+$env:PATH
$env:CARGO_HOME=Join-Path $repoRoot 'native-tools\cargo-cache'
$env:CARGO_TARGET_DIR=Join-Path $repoRoot 'native-tools\target'
$env:CARGO_BUILD_JOBS='3'
$previousModelBuildInput=$env:FOXESS_DEFAULT_MODEL_FILE
$privateModel=Join-Path $PSScriptRoot 'runtime/foxess-default-model.private.json'
if($CredentialMode -eq 'enterprise'){
  if(!(Test-Path -LiteralPath $privateModel)){throw 'Enterprise credential build input is missing.'}
  $env:FOXESS_DEFAULT_MODEL_FILE=$privateModel
} else {
  Remove-Item Env:\FOXESS_DEFAULT_MODEL_FILE -ErrorAction SilentlyContinue
}
$protocRoot=Join-Path $env:LOCALAPPDATA 'FoxESSWikiBuild\protoc'
if(!(Test-Path -LiteralPath (Join-Path $protocRoot 'include\google\protobuf\empty.proto'))){
  New-Item -ItemType Directory -Path $protocRoot -Force | Out-Null
  Get-ChildItem -LiteralPath (Join-Path $repoRoot 'native-tools\protoc') | Copy-Item -Destination $protocRoot -Recurse -Force
}
$env:PROTOC=Join-Path $protocRoot 'bin\protoc.exe'
$env:PROTOC_INCLUDE=Join-Path $protocRoot 'include'
$proxy=[System.Net.WebRequest]::DefaultWebProxy.GetProxy([uri]'https://crates.io')
if($proxy.Host -ne 'crates.io'){ $env:HTTPS_PROXY=$proxy.AbsoluteUri; $env:HTTP_PROXY=$proxy.AbsoluteUri }
Push-Location $repoRoot
try {
  & (Join-Path $rustBin 'rustc.exe') --version
  if(!$Test -and !$NativeOnly){
    npm run build
    if($LASTEXITCODE -ne 0){throw '原版前端构建失败'}
  }
  $argsList=@($(if($Test){'test'}else{'build'}),'--manifest-path','src-tauri/Cargo.toml','--locked','--features','tauri/custom-protocol')
  if($Release){$argsList+='--release'}
  if($Test){$argsList+='--lib';if($env:LLM_WIKI_TEST_FILTER){$argsList+=$env:LLM_WIKI_TEST_FILTER};$argsList+=@('--','--test-threads=2')}
  & (Join-Path $rustBin 'cargo.exe') @argsList
  if($LASTEXITCODE -ne 0){throw '原版Rust后台构建失败'}
  if($Test){return}
  $targetDir=Join-Path $env:CARGO_TARGET_DIR $(if($Release){'release'}else{'debug'})
  $pdfium=Join-Path $repoRoot 'original-desktop\release\pdfium\pdfium.dll'
  Copy-Item -LiteralPath $pdfium -Destination (Join-Path $targetDir 'pdfium.dll') -Force
  $executable=Join-Path $targetDir 'llm-wiki.exe'
  $packageVersion=([IO.File]::ReadAllText((Join-Path $repoRoot 'package.json')) | ConvertFrom-Json).version
  $provenance=@{version=$packageVersion;credentialMode=$CredentialMode;nativeDefaultCredentialIncluded=($CredentialMode -eq 'enterprise');executable=$executable;executableSha256=(Get-FileHash -LiteralPath $executable -Algorithm SHA256).Hash.ToLower();builtAtUtc=[DateTime]::UtcNow.ToString('o')}
  [IO.Directory]::CreateDirectory((Join-Path $PSScriptRoot 'runtime')) | Out-Null
  [IO.File]::WriteAllText((Join-Path $PSScriptRoot 'runtime/build-provenance.json'),($provenance | ConvertTo-Json),[Text.UTF8Encoding]::new($false))
  Write-Host ('原版完整构建产物：'+$executable)
} finally {
  Pop-Location
  if($previousModelBuildInput){$env:FOXESS_DEFAULT_MODEL_FILE=$previousModelBuildInput}else{Remove-Item Env:\FOXESS_DEFAULT_MODEL_FILE -ErrorAction SilentlyContinue}
}
