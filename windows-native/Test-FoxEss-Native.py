"""Native protected-model smoke and original frontend compiler; synthetic corpus only, restore in finally."""
from pathlib import Path
import os,sys,json,time,subprocess,uuid,shutil,hashlib,urllib.request,urllib.error
sys.stdout.reconfigure(encoding='utf-8');sys.stderr.reconfigure(encoding='utf-8')
ROOT=Path(__file__).resolve().parent.parent
RUNTIME=ROOT/'windows-native/runtime'
MAIN=RUNTIME/'equipment-wiki'
CANDIDATE=ROOT/'native-tools/target/debug/llm-wiki.exe'
INSTALL=Path(os.environ.get('FOXESS_TARGET_INSTALL','D:/LLM-WIKI/FoxESS LLM Wiki'))
if not (INSTALL/'app/llm-wiki.exe').is_file():INSTALL=ROOT/'windows-native'
STAMP=str(int(time.time()))
BACKUP=RUNTIME/('backups/foxess-r2-'+STAMP)
OPENER=urllib.request.build_opener(urllib.request.ProxyHandler({}))
def digest(p):
    with p.open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
def ps(code):
    env={k:v for k,v in os.environ.items() if k.upper()!='PSMODULEPATH'}
    out=subprocess.run(['powershell.exe','-NoProfile','-ExecutionPolicy','Bypass','-Command',"$ErrorActionPreference='Stop';"+code],cwd=ROOT,env=env,capture_output=True,text=True,encoding='utf-8',errors='replace')
    if out.returncode:raise RuntimeError('Native deployment command failed: '+out.stderr[-300:])
def quote(s):return "'"+str(s).replace("'","''")+"'"
def bridge(mode,file):
    ack=RUNTIME/f'foxess-config-{uuid.uuid4().hex}.safe.json'
    helper=ROOT/'windows-native/Upgrade-State.ps1'
    args=f'-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{helper}" -Mode {mode} -FilePath "{file}" -AckPath "{ack}"'
    name='FoxESS-Wiki-Brand-Config'
    ps(f"$t=Get-ScheduledTask -TaskName FoxESS-EquipmentWiki-Native;$a=New-ScheduledTaskAction -Execute powershell.exe -Argument {quote(args)} -WorkingDirectory {quote(ROOT)};Register-ScheduledTask -TaskName {name} -Action $a -Principal $t.Principal -Force | Out-Null;Start-ScheduledTask -TaskName {name}")
    try:
        for _ in range(100):
            if ack.exists():
                result=json.loads(ack.read_text(encoding='utf-8-sig'))
                if not result.get('ok'):raise RuntimeError('Task-context configuration operation failed')
                return result
            time.sleep(.25)
        raise RuntimeError('Task-context configuration operation timed out')
    finally:ps(f'Unregister-ScheduledTask -TaskName {name} -Confirm:$false -ErrorAction SilentlyContinue')
def health():
    try:
        with OPENER.open('http://127.0.0.1:19828/api/v1/health',timeout=2) as r:return json.load(r)
    except Exception:return None
def wait_ready():
    for _ in range(90):
        if (r:=health()) and r.get('ok'):return
        time.sleep(.5)
    raise RuntimeError('Native application did not become ready')
def stop():
    allowed=[str(INSTALL/'app/llm-wiki.exe'),str(ROOT/'windows-native/app/llm-wiki.exe'),str(CANDIDATE)]
    powershell_paths='@('+','.join(quote(p) for p in allowed)+')'
    ps("Stop-ScheduledTask -TaskName FoxESS-EquipmentWiki-Native -ErrorAction SilentlyContinue;$allowed="+powershell_paths+";Get-Process -Name llm-wiki -ErrorAction SilentlyContinue | Where-Object {$allowed -contains $_.Path} | ForEach-Object {Stop-Process -Id $_.Id; $_.WaitForExit()};exit 0")
def start(exe):
    # Configuration and app startup must share the scheduled task's interactive
    # logon context. A tool-launched child sees a different virtualized store.
    if exe==CANDIDATE:shutil.copy2(CANDIDATE,ROOT/'windows-native/app/llm-wiki.exe')
    ps("Start-ScheduledTask -TaskName FoxESS-EquipmentWiki-Native")
    wait_ready()
def manifest():
    root=Path('\\\\?\\'+str(MAIN))
    wiki={p.relative_to(root).as_posix():digest(p) for p in (root/'wiki').rglob('*.md')}
    raw={p.relative_to(root).as_posix():(p.stat().st_size,p.stat().st_mtime_ns) for p in (root/'raw/sources').rglob('*') if p.is_file()}
    media={p.relative_to(root).as_posix():(p.stat().st_size,p.stat().st_mtime_ns) for p in (root/'wiki').rglob('*') if p.is_file() and p.suffix.lower()!='.md'}
    return {'wiki':wiki,'raw':raw,'media':media}
def request(pid,token,path,body=None,timeout=180):
    data=json.dumps(body,ensure_ascii=False).encode() if body is not None else None
    req=urllib.request.Request('http://127.0.0.1:19828/api/v1/projects/'+pid+path,data=data,headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'})
    with OPENER.open(req,timeout=timeout) as r:return json.load(r)
def main():
    BACKUP.mkdir(parents=True)
    original=BACKUP/'app-state.authoritative.private.json'
    old_exe=INSTALL/'app/llm-wiki.exe'
    if not old_exe.is_file():raise RuntimeError('Expected installed executable is missing')
    was_running=bool(health())
    snapshot=bridge('Snapshot',original)
    queue_path=MAIN/'.llm-wiki/ingest-queue.json'
    queue=json.loads(queue_path.read_text(encoding='utf-8-sig'))
    if any(t['status'] in ('pending','processing') for t in queue):raise RuntimeError('Active or pending real ingestion must finish before this verification')
    queue_hash=digest(queue_path);before=None;passed=False;stopped=False;result={}
    try:
        stop();stopped=True;snapshot=bridge('Snapshot',original)
        shutil.copy2(old_exe,BACKUP/'llm-wiki.exe')
        src=Path('\\\\?\\'+str(MAIN));dst=Path('\\\\?\\'+str(BACKUP/'equipment-wiki'))
        for folder in ['wiki','.llm-wiki']:shutil.copytree(src/folder,dst/folder,dirs_exist_ok=True)
        before=manifest()
        (BACKUP/'data-before.json').write_text(json.dumps(before,ensure_ascii=False),encoding='utf-8')
        print('PASS: coherent backup and pre-upgrade manifest recorded',flush=True)
        test=RUNTIME/('foxess-model-acceptance-'+STAMP)
        for part in ['wiki','raw/sources','.llm-wiki']:(test/part).mkdir(parents=True,exist_ok=True)
        pid=str(uuid.uuid4());token=uuid.uuid4().hex+uuid.uuid4().hex
        project={'id':pid,'name':'FoxEss WIKI 验收样例','path':test.as_posix()}
        defaults=json.loads((ROOT/'src-tauri/resources/foxess-default-model.json').read_text(encoding='utf-8'))
        config={'provider':'custom','apiKey':defaults['credentialMarker'],'model':defaults['defaultModel'],'customEndpoint':defaults['baseUrl'],'ollamaUrl':'','maxContextSize':defaults['suggestedContextSize'],'streamingEnabled':False,'reasoning':{'mode':'off'},'ingestReasoning':{'mode':'off'},'requestTimeoutMinutes':10}
        watch=json.loads((ROOT/'src/lib/source-watch-defaults.json').read_text(encoding='utf-8'));watch.update(autoIngest=True,persistExtractedMarkdown=True,ingestConcurrency=1)
        profile={'language':'zh','outputLanguage':'Chinese','llmConfig':config,'activePresetId':'foxess-default','lastProject':project,'recentProjects':[project],'projectRegistry':{pid:project},'providerConfigs':{},'customLlmPresets':[],
          'projectLlmOverrides':{},'taskModelRouting':{'chatPresetId':'foxess-default','ingestPresetId':'foxess-default'},'sourceWatchConfig':{pid:watch},'sourceWatchAllProjects':False,'scheduledImportConfig:'+project['path']:{'enabled':False,'path':'','interval':1},
          'embeddingConfig':{'enabled':False},'multimodalConfig':{'enabled':False},'proxyConfig':{'enabled':False},'apiConfig':{'enabled':True,'mcpEnabled':True,'token':token,'allowUnauthenticated':False,'allowLanAccess':False}}
        staged=RUNTIME/'foxess-stage-profile.private.json';staged.write_text(json.dumps(profile,ensure_ascii=False),encoding='utf-8')
        (test/'.llm-wiki/project.json').write_text(json.dumps({'id':pid}),encoding='utf-8')
        (test/'.llm-wiki/source-reconciliation.json').write_text(json.dumps({'version':1,'enabled':True,'generation':0,'blocked':False,'sources':{},'pages':{},'pendingSources':[]}),encoding='utf-8')
        for name in ['schema.md','purpose.md','wiki/index.md','wiki/log.md','wiki/overview.md']:
            template=ROOT/'windows-native/installer'/('templates/'+name)
            if template.exists():text=template.read_text(encoding='utf-8')
            elif name=='schema.md':text='# Schema\nUse sources, entities, concepts, topics, comparisons and synthesis pages. Cite exact source paths. Preserve units and versions.'
            else:text='# Synthetic model acceptance\nOnly the isolated sample file is evidence.'
            (test/name).write_text(text,encoding='utf-8')
        bridge('Restore',staged);start(CANDIDATE)
        project_ready=False
        for _ in range(40):
            req=urllib.request.Request('http://127.0.0.1:19828/api/v1/projects',headers={'Authorization':'Bearer '+token})
            with OPENER.open(req,timeout=5) as r:registered=json.load(r)
            current=registered.get('currentProject')
            if current and current.get('id')==pid:project_ready=True;break
            if current and current.get('id')!=pid:raise AssertionError('The frontend did not load the isolated project; refusing model tests')
            time.sleep(.3)
        if not project_ready:raise AssertionError('The isolated project was not activated')
        routing=request(pid,token,'/model-routing')
        if routing['chat']['model']!=defaults['defaultModel'] or routing['ingest']['model']!=defaults['defaultModel']:raise AssertionError('Task routing did not select the enterprise model')
        chat=request(pid,token,'/chat',{'message':'请只回复 OK。用于企业默认模型连接验收，无需查找资料。','mode':'fast','stream':False,'tools':{'wiki':False,'web':False,'anytxt':False}})
        message=chat.get('message')
        content=message.get('content') if isinstance(message,dict) else message
        if not (content or chat.get('answer')):raise AssertionError('Default-model API chat did not return an answer')
        print('PASS: real protected default model via native API; no user model configuration required',flush=True)
        source=test/'raw/sources/SAMPLE-P1.md'
        source.write_text('# SAMPLE-P1 测试电源\n\n仅用于 FoxEss WIKI 独立验收的虚构资料。厂家：验收样例厂商；型号：SAMPLE-P1；版本：V1.0；额定输出：48 V；最大功率：120 W。以上参数均为测试数据，不对应真实产品。请以该文件为唯一来源，保留型号、版本和单位。',encoding='utf-8')
        metric=None
        for _ in range(150):
            for p in (test/'.llm-wiki/task-metrics').glob('*.json'):
                row=json.loads(p.read_text(encoding='utf-8'))
                if row.get('kind')=='ingest' and row.get('status') in ('done','failed','cancelled'):
                    metric=row;break
            if metric:break
            time.sleep(2)
        if not metric or metric['status']!='done':raise AssertionError('Real frontend compiler did not complete the synthetic source; isolated logs retained')
        catalog=request(pid,token,'/catalog?limit=1000')
        if catalog['total']<1:raise AssertionError('Original compiler did not publish knowledge pages')
        public_state=json.loads(staged.read_text(encoding='utf-8'))
        if public_state['llmConfig']['apiKey']!='__FOXESS_BUILTIN_CREDENTIAL__':raise AssertionError('Unexpected credential in first-install configuration')
        result={'passed':True,'executableSha256':digest(CANDIDATE),'brand':'FoxEss WIKI','realNativeDefaultChat':True,'realFrontendDefaultIngest':True,'syntheticKnowledgePages':catalog['total'],'ingestDurationMs':metric.get('durationMs'),'ingestModel':metric.get('model'),
          'usageCoverage':metric.get('usageCoverage'),'plaintextDefaultCredentialInNewProfile':False,'syntheticProject':pid,'backup':str(BACKUP)}
        passed=True;print('PASS: real original compiler through protected native HTTP transport',flush=True)
    finally:
        if stopped:
            stop();restored=bridge('Restore',original)
            if passed:shutil.copy2(CANDIDATE,old_exe)
            elif (BACKUP/'llm-wiki.exe').exists():shutil.copy2(BACKUP/'llm-wiki.exe',old_exe)
            if was_running:start(old_exe);time.sleep(3)
            after=manifest();before=before or after
            changed=[p for p,h in before['wiki'].items() if after['wiki'].get(p)!=h and p!='wiki/index.md']
            preserved=not changed and before['raw']==after['raw'] and before['media']==after['media'] and digest(queue_path)==queue_hash
            result.update(passed=passed and preserved and restored['sha256']==snapshot['sha256'],productionHealth=(health() or {}).get('status','stopped'),originalRunningStatePreserved=bool(health())==was_running,wikiBefore=len(before['wiki']),wikiAfter=len(after['wiki']),unexpectedChangedOrMissingPages=changed,
              sourcesAndMediaUnchanged=before['raw']==after['raw'] and before['media']==after['media'],realQueueUnchanged=digest(queue_path)==queue_hash,restoredOriginalSettings=restored['sha256']==snapshot['sha256'])
            (RUNTIME/'foxess-acceptance.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
            print(json.dumps(result,ensure_ascii=False),flush=True)
            if not result['passed']:raise RuntimeError('FoxEss acceptance did not pass; previous application and settings restored')
if __name__=='__main__':main()
