"""Temporarily load the already verified synthetic project for native WebView UI testing."""
from pathlib import Path
import importlib.util,json,subprocess,time,sys,os
sys.stdout.reconfigure(encoding='utf-8');sys.stderr.reconfigure(encoding='utf-8')
root=Path(__file__).resolve().parent.parent;runtime=root/'windows-native/runtime'
spec=importlib.util.spec_from_file_location('foxess_native_test',root/'windows-native/Test-FoxEss-Native.py');native=importlib.util.module_from_spec(spec);spec.loader.exec_module(native)
original=runtime/('foxess-ui-original-'+str(int(time.time()))+'.private.json');snapshot=native.bridge('Snapshot',original)
profile=json.loads((runtime/'foxess-stage-profile.private.json').read_text(encoding='utf-8'))
for watch in profile['sourceWatchConfig'].values():watch.update(enabled=False,autoIngest=False)
profile['theme']='light';profile['sourceWatchAllProjects']=False
staged=runtime/'foxess-ui-stage.private.json';staged.write_text(json.dumps(profile,ensure_ascii=False),encoding='utf-8')
task='FoxESS-Wiki-Preview';passed=False;was_running=bool(native.health())
try:
    native.stop();native.bridge('Restore',staged)
    script=root/'windows-native/Run-Test-Candidate.ps1'
    args=f'-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{script}" -ExecutablePath "{native.CANDIDATE}" -DebugPort 9224'
    native.ps(f"$t=Get-ScheduledTask -TaskName FoxESS-EquipmentWiki-Native;$a=New-ScheduledTaskAction -Execute powershell.exe -Argument {native.quote(args)} -WorkingDirectory {native.quote(root)};Register-ScheduledTask -TaskName {task} -Action $a -Principal $t.Principal -Force | Out-Null;Start-ScheduledTask -TaskName {task}")
    native.wait_ready()
    if os.environ.get('FOXESS_VERIFY_INSTALLER')=='1':
        env=os.environ.copy();env['FOXESS_TEST_PROJECT']=profile['lastProject']['id'];env['LLM_WIKI_API_TOKEN']=profile['apiConfig']['token']
        subprocess.run([sys.executable,str(root/'windows-native/Test-Installer.py')],cwd=root,env=env,check=True,timeout=180)
    subprocess.run(['node',str(root/'windows-native/test-foxess-ui.mjs')],cwd=root,check=True,timeout=100)
    passed=True
finally:
    native.ps(f'Stop-ScheduledTask -TaskName {task} -ErrorAction SilentlyContinue;Unregister-ScheduledTask -TaskName {task} -Confirm:$false -ErrorAction SilentlyContinue;exit 0')
    native.stop();restored=native.bridge('Restore',original)
    if was_running:native.start(native.INSTALL/'app/llm-wiki.exe')
    if restored['sha256']!=snapshot['sha256']:raise RuntimeError('Original settings did not restore exactly')
    print(json.dumps({'uiPassed':passed,'originalSettingsRestored':True,'originalRunningStatePreserved':bool(native.health())==was_running}))
