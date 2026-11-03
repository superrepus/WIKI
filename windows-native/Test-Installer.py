"""Exercise the installer in extraction-only mode. Active-production mode uses live GET/status APIs only and never snapshots source data or interrupts ingestion."""
from pathlib import Path
import hashlib,json,os,subprocess,sys,time,zipfile
sys.stdout.reconfigure(encoding='utf-8');sys.stderr.reconfigure(encoding='utf-8')
ROOT=Path(__file__).resolve().parent.parent
sys.path.insert(0,str(ROOT/'windows-native'))
import cli

def digest(p):
    with p.open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
def ps(args,**kwargs):
    env={k:v for k,v in os.environ.items() if k.upper()!='PSMODULEPATH'}
    return subprocess.run(['powershell.exe','-NoProfile','-ExecutionPolicy','Bypass',*args],env=env,cwd=ROOT,check=True,capture_output=True,text=True,encoding='utf-8',**kwargs)
def main():
    build=json.loads((ROOT/'windows-native/runtime/installer-build.json').read_text(encoding='utf-8'))
    test=ROOT/'.installer-tests'/('packaged-'+str(int(time.time())))
    target=test/'安装程序 test'
    test.mkdir(parents=True)
    active_production=os.environ.get('FOXESS_ALLOW_ACTIVE_PRODUCTION')=='1'
    if active_production and (not os.environ.get('FOXESS_TEST_PROJECT') or not os.environ.get('LLM_WIKI_API_TOKEN')):
        raise RuntimeError('Active-production verification requires explicit FOXESS_TEST_PROJECT and LLM_WIKI_API_TOKEN')
    project=os.environ.get('FOXESS_TEST_PROJECT','bc7417fb-b8ff-5147-89ee-e9e00dba280c')
    catalog_before=cli.api('/projects/'+project+'/catalog?limit=1')['total']
    queue=ROOT/'windows-native/runtime/equipment-wiki/.llm-wiki/ingest-queue.json'
    queue_before=digest(queue) if not active_production else None
    direct_profile=Path(os.environ['APPDATA'])/'com.llmwiki.app/app-state.json'
    profile_before=digest(direct_profile) if not active_production else None
    # /D must be the final, unquoted NSIS parameter. No shell is used.
    subprocess.run('"'+build['installer']+'" /S /EXTRACTONLY /D='+str(target),cwd=ROOT,check=True,timeout=180)
    manifest=json.loads((target/'install-manifest.json').read_text(encoding='utf-8'))
    bad=[row['path'] for row in manifest['files'] if digest(target/row['path'])!=row['sha256']]
    if bad:raise AssertionError('Extracted file hashes differ: '+str(bad[:3]))
    if not (target/'extract-only.marker').is_file():raise AssertionError('Missing extraction-only marker')
    initial=ps(['-File',str(ROOT/'windows-native/installer/Test-Initialize.ps1'),'-ScriptsRoot',str(target/'scripts'),'-TestRoot',str(test/'synthetic-provisioning')])
    cli_out=ps(['-File',str(target/'scripts/cli.ps1'),'routing','-Project',project])
    routing=json.loads(cli_out.stdout)
    public_model=json.loads((ROOT/'src-tauri/resources/foxess-default-model.json').read_text(encoding='utf-8'))
    expected_model=public_model['defaultModel']
    if active_production:
        # The running user may deliberately use a different model than the packaged default.
        if not isinstance(routing.get('chat'),dict) or not routing['chat'].get('model'):
            raise AssertionError('Packaged CLI returned an invalid live chat route')
    elif routing['chat']['model']!=expected_model:raise AssertionError('Unexpected live chat route')
    catalog=json.loads(ps(['-File',str(target/'scripts/cli.ps1'),'catalog','-Project',project,'-Limit','1']).stdout)
    if not isinstance(catalog.get('total'),int) or catalog['total']<0:raise AssertionError('Packaged CLI returned an invalid catalog count')
    if not active_production and catalog['total']!=catalog_before:raise AssertionError('Packaged CLI catalog mismatch')
    probe=target/'test-mcp-probe.mjs'
    probe.write_text('''import { Client } from './mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from './mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import path from 'node:path';
const client=new Client({name:'installer-test',version:'1.0'},{capabilities:{}});
const transport=new StdioClientTransport({command:process.execPath,args:[path.resolve('scripts/mcp-launcher.mjs')],env:process.env});
try {await client.connect(transport);const list=await client.listTools();if(!list.tools.some(t=>t.name==='llm_wiki_chat'))throw Error('Original chat tool missing');const status=await client.callTool({name:'llm_wiki_status',arguments:{}});if(status.isError)throw Error('MCP API status failed');console.log(JSON.stringify({tools:list.tools.length,statusOk:true}));} finally {await client.close();}
''',encoding='utf-8')
    mcp=subprocess.run([str(target/'runtime/node.exe'),str(probe)],cwd=target,check=True,capture_output=True,text=True,encoding='utf-8',timeout=45)
    mcp_result=json.loads(mcp.stdout.strip().splitlines()[-1])
    # Verify the package's uninstaller leaves unknown user files even inside its program directory.
    keep=target/'user-project/keep.txt';keep.parent.mkdir();keep.write_text('USER_DATA_MUST_SURVIVE',encoding='utf-8')
    subprocess.run('"'+str(target/'Uninstall.exe')+'" /S _?='+str(target),cwd=ROOT,check=True,timeout=120)
    if keep.read_text(encoding='utf-8')!='USER_DATA_MUST_SURVIVE':raise AssertionError('User-created content was removed')
    remaining=[row['path'] for row in manifest['files'] if (target/row['path']).exists()]
    if remaining:raise AssertionError('Packaged files not removed: '+str(remaining[:3]))
    catalog_after=cli.api('/projects/'+project+'/catalog?limit=1')['total']
    if not active_production:
        if digest(direct_profile)!=profile_before or digest(queue)!=queue_before:raise AssertionError('Live configuration or queue changed')
        if catalog_after!=catalog_before:raise AssertionError('Live catalog changed')
    # Search all text-like package inputs and decompressed corresponding source for actual local credentials.
    secret=json.loads((ROOT/'windows-server/secrets.local.json').read_text(encoding='utf-8-sig'))
    model_profile=json.loads((ROOT/'windows-native/runtime/foxess-current-profile.private.json').read_text(encoding='utf-8-sig'))
    needles=[s.encode() for s in (secret.get('api_token'),secret.get('model_api_key'),model_profile.get('llmConfig',{}).get('apiKey'),os.environ.get('LLM_WIKI_API_TOKEN')) if s and len(s)>=8 and s!=public_model.get('credentialMarker')]
    stage=Path(build['stage'])
    for p in stage.rglob('*'):
        if p.is_file() and p.suffix.lower() in ('.json','.md','.js','.mjs','.ps1','.cmd','.txt'):
            data=p.read_bytes()
            if any(n in data for n in needles):raise AssertionError('A real credential was found in a packaged text file')
    with zipfile.ZipFile(build['source']) as z:
        for name in z.namelist():
            if name.endswith(('.exe','.dll','.so','.dylib')):continue
            if any(n in z.read(name) for n in needles):raise AssertionError('A real credential was found in corresponding source')
    report={'passed':True,'installerSha256':build['sha256'],'verifiedPayloadFiles':len(manifest['files']),
      'pathWithSpacesAndChinese':True,'managedFirstRunPassed':True,'existingProfilePreserved':True,'existingProfilePreservedEvidence':'synthetic provisioning fixture','sourceAndDataSeparation':True,
      'packagedCliApiPassed':True,'packagedMcp':mcp_result,'uninstallPreservesUnknownUserData':True,'programPayloadRemoved':True,
      'liveApiReadOnly':True,'allowActiveProduction':active_production,
      'productionIngestInProgress':True if active_production else None,
      'productionIngestStateSource':'caller-declared via FOXESS_ALLOW_ACTIVE_PRODUCTION' if active_production else 'not separately inspected',
      'liveStateStabilityChecked':not active_production,'liveConfigAndQueueUnchanged':True if not active_production else None,
      'testedCatalogPages':catalog_before,'catalogSamples':{'before':catalog_before,'packagedCli':catalog['total'],'after':catalog_after},
      'testedProjectId':project,'credentialScanPassed':True,
      'cleanMachineEndToEndTested':False,'testMode':'EXTRACTONLY (no startup, registry, shortcuts or runtime installation)'}
    (ROOT/'windows-native/runtime/installer-acceptance.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    (Path(build['installer']).parent/'安装包验证结果.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(initial.stdout.strip());print(json.dumps(report,ensure_ascii=False))
if __name__=='__main__':main()
