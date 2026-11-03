param([ValidateSet('Preflight','InstallStartup','RemoveStartup','Uninstall','CheckRuntime')][string]$Mode,[string]$InstallRoot=(Split-Path $PSScriptRoot -Parent))
$ErrorActionPreference='Stop'
$InstallRoot=[IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$taskName='FoxESS-LLMWiki-'+$identity.User.Value
$startup=Join-Path ([Environment]::GetFolderPath('Startup')) 'FoxESS LLM Wiki.lnk'
if($Mode -eq 'Preflight'){
  if(Get-Process -Name llm-wiki -ErrorAction SilentlyContinue){Write-Error 'Please exit the running LLM Wiki before installation or upgrade. Your data will be retained.';exit 20}
  exit 0
}
if($Mode -eq 'CheckRuntime'){
  $id='{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
  foreach($key in @("HKCU:\Software\Microsoft\EdgeUpdate\Clients\$id","HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\$id","HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\$id")){
    $pv=(Get-ItemProperty -LiteralPath $key -ErrorAction SilentlyContinue).pv
    if($pv -and $pv -ne '0.0.0.0'){exit 0}
  }
  exit 10
}
if($Mode -in @('RemoveStartup','Uninstall')){
  $task=Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if($task -and @($task.Actions | Where-Object {$_.Arguments -like ('*'+$InstallRoot+'*')}).Count){Unregister-ScheduledTask -TaskName $taskName -Confirm:$false}
  if(Test-Path -LiteralPath $startup){
    $shell=New-Object -ComObject WScript.Shell;$link=$shell.CreateShortcut($startup)
    if($link.Arguments -like ('*'+$InstallRoot+'*')){Remove-Item -LiteralPath $startup}
  }
  exit 0
}
if($Mode -eq 'InstallStartup'){
  $launch=Join-Path $InstallRoot 'scripts/Start.ps1'
  # An earlier hand deployment owns the same application profile and port.
  # Do not replace it or schedule a competing deployment.
  $legacy=Get-ScheduledTask -TaskName 'FoxESS-EquipmentWiki-Native' -ErrorAction SilentlyContinue
  if($legacy -and $legacy.State -ne 'Disabled') { Write-Output 'Existing deployment task retained; new automatic startup was not enabled.';exit 0 }
  try{
    $action=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "'+$launch+'" -Monitor') -WorkingDirectory $InstallRoot
    $trigger=New-ScheduledTaskTrigger -AtLogOn -User $identity.Name
    $principal=New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType Interactive -RunLevel Limited
    $settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
  }catch{
    $shell=New-Object -ComObject WScript.Shell;$link=$shell.CreateShortcut($startup)
    $link.TargetPath=Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
    $link.Arguments='-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "'+$launch+'" -Monitor'
    $link.WorkingDirectory=$InstallRoot;$link.Save()
    Write-Output 'Task policy prevented registration; installed a current-user Startup shortcut instead.'
  }
}
