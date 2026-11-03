# -*- coding: utf-8 -*-
Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "x64.nsh"
!include "WinVer.nsh"
!ifndef APP_VERSION
  !define APP_VERSION "1.0.0"
!endif
!ifndef APP_FILE_VERSION
  !define APP_FILE_VERSION "1.0.0.0"
!endif
Name "FoxEss WIKI"
OutFile "${OUTPUT}"
InstallDir "$LOCALAPPDATA\Programs\FoxEss WIKI"
InstallDirRegKey HKCU "Software\FoxESS\LLMWiki" "InstallDir"
RequestExecutionLevel user
SetCompressor zlib
VIProductVersion "${APP_FILE_VERSION}"
VIAddVersionKey /LANG=2052 "ProductName" "FoxEss WIKI"
VIAddVersionKey /LANG=2052 "FileDescription" "FoxEss WIKI Windows 原生安装包"
VIAddVersionKey /LANG=2052 "FileVersion" "${APP_VERSION}"
VIAddVersionKey /LANG=2052 "LegalCopyright" "LLM Wiki contributors; local enhancements. GPL-3.0."
!define MUI_ICON "${PAYLOAD}\app\foxess.ico"
!define MUI_UNICON "${PAYLOAD}\app\foxess.ico"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT "配置并打开 FoxEss WIKI"
!define MUI_FINISHPAGE_RUN_FUNCTION LaunchWiki
!define MUI_FINISHPAGE_TEXT "程序安装完成。知识数据和模型设置保存在独立目录，升级和卸载时保留。首次运行选择知识库位置、来源及可用模型；已有设置继续沿用。"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"
Var PortableTest
Var UpdateMode
Var Parameters
Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "此安装包需要 64 位 Windows。"
    Abort
  ${EndIf}
  ${IfNot} ${AtLeastWin10}
    MessageBox MB_ICONSTOP "此安装包需要 Windows 10 或更新的带桌面系统。"
    Abort
  ${EndIf}
  SetShellVarContext current
  SetRegView 64
  ${GetParameters} $Parameters
  ClearErrors
  ${GetOptions} $Parameters "/EXTRACTONLY" $PortableTest
  ${IfNot} ${Errors}
    StrCpy $PortableTest "1"
    Return
  ${EndIf}
  StrCpy $PortableTest "0"
  StrCpy $UpdateMode "0"
  ClearErrors
  ${GetOptions} $Parameters "/UPDATE" $UpdateMode
  ${IfNot} ${Errors}
    StrCpy $UpdateMode "1"
    SetSilent silent
  ${EndIf}
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File /oname=Manage.ps1 "${PAYLOAD}\scripts\Manage.ps1"
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\Manage.ps1" -Mode Preflight'
  Pop $0
  Pop $1
  ${If} $0 != 0
    IfSilent +2
    MessageBox MB_ICONSTOP "请先退出正在运行的 FoxEss WIKI，再安装或升级。现有知识库将保留。"
    SetErrorLevel 20
    Abort
  ${EndIf}
FunctionEnd
Section "FoxEss WIKI"
  SetOutPath "$INSTDIR"
  ClearErrors
  File /r "${PAYLOAD}\*"
  ${If} ${Errors}
    SetErrorLevel 40
    Abort
  ${EndIf}
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  ${If} $PortableTest == "1"
    FileOpen $0 "$INSTDIR\extract-only.marker" w
    FileWrite $0 "No startup, shortcuts, registry, runtime installation or launch was performed."
    FileClose $0
    Goto Done
  ${EndIf}
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\scripts\Manage.ps1" -Mode CheckRuntime'
  Pop $0
  Pop $1
  ${If} $0 != 0
    DetailPrint "正在安装 Microsoft WebView2 运行时…"
    ExecWait '"$INSTDIR\prerequisites\MicrosoftEdgeWebView2RuntimeInstallerX64.exe" /silent /install' $0
    nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\scripts\Manage.ps1" -Mode CheckRuntime'
    Pop $0
    Pop $1
    ${If} $0 != 0
      IfSilent +2
      MessageBox MB_ICONSTOP "WebView2 尚未安装成功。请联系管理员安装微软 WebView2，再打开 FoxEss WIKI。程序文件已保留。"
      SetErrorLevel 30
      Abort
    ${EndIf}
  ${EndIf}
  CreateDirectory "$SMPROGRAMS\FoxEss WIKI"
  CreateShortCut "$SMPROGRAMS\FoxEss WIKI\FoxEss WIKI.lnk" "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$INSTDIR\scripts\Start.ps1"' "$INSTDIR\app\llm-wiki.exe"
  CreateShortCut "$DESKTOP\FoxEss WIKI.lnk" "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$INSTDIR\scripts\Start.ps1"' "$INSTDIR\app\llm-wiki.exe"
  CreateShortCut "$SMPROGRAMS\FoxEss WIKI\首次配置.lnk" "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" '-NoProfile -STA -ExecutionPolicy Bypass -File "$INSTDIR\scripts\Configure.ps1"'
  CreateShortCut "$SMPROGRAMS\FoxEss WIKI\使用说明.lnk" "$INSTDIR\FoxEss-WIKI-使用手册.html"
  WriteRegStr HKCU "Software\FoxESS\LLMWiki" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\FoxESSLLMWiki" "DisplayName" "FoxEss WIKI"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\FoxESSLLMWiki" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\FoxESSLLMWiki" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\FoxESSLLMWiki" "QuietUninstallString" '"$INSTDIR\Uninstall.exe" /S'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\FoxESSLLMWiki" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\FoxESSLLMWiki" "DisplayIcon" "$INSTDIR\app\llm-wiki.exe"
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\FoxESSLLMWiki" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\FoxESSLLMWiki" "NoRepair" 1
  ${If} $UpdateMode != "1"
    nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\scripts\Manage.ps1" -Mode InstallStartup'
    Pop $0
    Pop $1
  ${EndIf}
  Done:
SectionEnd
Function LaunchWiki
  ${If} $PortableTest == "1"
    Return
  ${EndIf}
  ${If} $UpdateMode == "1"
    Return
  ${EndIf}
  Exec '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File "$INSTDIR\scripts\Start.ps1"'
FunctionEnd
Function un.onInit
  SetShellVarContext current
  SetRegView 64
  IfFileExists "$INSTDIR\install-manifest.json" +3
    MessageBox MB_ICONSTOP "安装清单缺失，停止卸载以保护现有文件。"
    Abort
  IfFileExists "$INSTDIR\extract-only.marker" UnReady
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\scripts\Manage.ps1" -Mode Preflight'
  Pop $0
  Pop $1
  ${If} $0 != 0
    IfSilent +2
    MessageBox MB_ICONSTOP "请先退出 FoxEss WIKI，再卸载。"
    SetErrorLevel 20
    Abort
  ${EndIf}
  UnReady:
FunctionEnd
Section "Uninstall"
  IfFileExists "$INSTDIR\extract-only.marker" UnFiles
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\scripts\Manage.ps1" -Mode Uninstall'
  Pop $0
  Pop $1
  Delete "$DESKTOP\FoxEss WIKI.lnk"
  Delete "$SMPROGRAMS\FoxEss WIKI\FoxEss WIKI.lnk"
  Delete "$SMPROGRAMS\FoxEss WIKI\首次配置.lnk"
  Delete "$SMPROGRAMS\FoxEss WIKI\使用说明.lnk"
  RMDir "$SMPROGRAMS\FoxEss WIKI"
  DeleteRegKey HKCU "Software\FoxESS\LLMWiki"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\FoxESSLLMWiki"
  UnFiles:
  ; Generated explicit file list: no recursive deletion of user-created content.
  !include "${DELETE_MANIFEST}"
  Delete "$INSTDIR\extract-only.marker"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
SectionEnd
