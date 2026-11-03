"""Assemble a clean per-user Windows installer from the verified executable, without user data."""
from pathlib import Path
import argparse,hashlib,json,os,re,shutil,subprocess,time,zipfile,sys
sys.stdout.reconfigure(encoding='utf-8');sys.stderr.reconfigure(encoding='utf-8')

ROOT=Path(__file__).resolve().parent.parent
SCRIPTS=ROOT/'windows-native/installer'
TOOLS=ROOT/'native-tools/installer-downloads'
VERSION=json.loads((ROOT/'package.json').read_text(encoding='utf-8'))['version']
if not re.fullmatch(r'(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)', VERSION):
    raise RuntimeError('A stable semantic package version is required')
RELEASE=ROOT/'windows-native/releases'/('v'+VERSION)
STAGE=ROOT/'windows-native/runtime'/('package-stage-'+str(int(time.time())))
PAYLOAD=STAGE/'payload'

def digest(path):
    with path.open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
def copy(src,relative):
    dest=PAYLOAD/relative;dest.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(src,dest)
def write(relative,text,bom=False):
    dest=PAYLOAD/relative;dest.parent.mkdir(parents=True,exist_ok=True);dest.write_text(text,encoding='utf-8-sig' if bom else 'utf-8')
def run(args,**kwargs):
    if Path(args[0]).name.lower()=='powershell.exe':
        env=kwargs.pop('env',os.environ.copy());kwargs['env']={k:v for k,v in env.items() if k.upper()!='PSMODULEPATH'}
    subprocess.run(args,cwd=ROOT,check=True,**kwargs)

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--credential-mode', choices=('public','enterprise'), default='public')
    args=parser.parse_args()
    RELEASE.mkdir(parents=True,exist_ok=True);PAYLOAD.mkdir(parents=True)
    provenance=json.loads((ROOT/'windows-native/runtime/build-provenance.json').read_text(encoding='utf-8-sig'))
    source_exe=Path(provenance['executable'])
    if provenance.get('credentialMode') != args.credential_mode or provenance.get('version') != VERSION or provenance.get('executableSha256') != digest(source_exe):
        raise RuntimeError('Rebuild the candidate with the requested version and credential mode before packaging')
    verified=json.loads((ROOT/'windows-native/runtime/upgrade-data-preservation.json').read_text(encoding='utf-8'))
    if not verified.get('passed'):raise RuntimeError('A passing data-preservation acceptance report is required')
    accepted=json.loads((ROOT/'windows-native/runtime/external-release-acceptance.json').read_text(encoding='utf-8'))
    if not accepted.get('passed') or accepted.get('executableSha256')!=digest(source_exe):raise RuntimeError('The candidate must pass external-source release acceptance before packaging')
    run(['cmd.exe','/d','/c','npm','--prefix','mcp-server','run','build'])
    copy(source_exe,'app/llm-wiki.exe');copy(ROOT/'windows-native/app/pdfium.dll','app/pdfium.dll')
    copy(ROOT/'src-tauri/icons/icon.ico','app/foxess.ico')
    # App-local release CRT from the licensed Visual Studio redistributable directory, not debug/system DLLs.
    vs=subprocess.check_output([r'C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe','-latest','-products','*','-property','installationPath'],text=True).strip()
    crt=sorted(Path(vs).glob('VC/Redist/MSVC/*/x64/Microsoft.VC*.CRT'))[-1]
    for name in ['vcruntime140.dll','vcruntime140_1.dll','msvcp140.dll']:
        copy(crt/name,'app/'+name)
        copy(crt/name,'runtime/'+name)
    node=Path(shutil.which('node.exe') or shutil.which('node') or '')
    if not node.is_file():raise RuntimeError('A redistributable Node executable is required')
    copy(node,'runtime/node.exe')
    copy(TOOLS/'NODE-LICENSE.txt','licenses/NODE-LICENSE.txt')
    copy(ROOT/'LICENSE','licenses/LLM-WIKI-GPL-3.0.txt')
    for name in ['PDFIUM-LICENSE.txt','PDFIUM-NOTICES.txt']:
        if not (TOOLS/name).is_file():raise RuntimeError('Required third-party notice missing: '+name)
        copy(TOOLS/name,'licenses/'+name)
    webview=TOOLS/'MicrosoftEdgeWebView2RuntimeInstallerX64.exe'
    # Refuse HTML downloads or unsigned/replaced redistributables.
    env=os.environ.copy();env['WIKI_RUNTIME_TO_VERIFY']=str(webview)
    run(['powershell.exe','-NoProfile','-Command',"Import-Module \"$PSHOME/Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1\" -ErrorAction Stop;$s=Get-AuthenticodeSignature -LiteralPath $env:WIKI_RUNTIME_TO_VERIFY;if($s.Status -ne 'Valid' -or $s.SignerCertificate.Subject -notlike '*Microsoft Corporation*'){exit 1}"],env=env)
    copy(webview,'prerequisites/'+webview.name)
    for name in ['Initialize.ps1','Configure.ps1','Start.ps1','Manage.ps1','cli.ps1','Update.ps1']:
        write('scripts/'+name,(SCRIPTS/name).read_text(encoding='utf-8-sig'),bom=True)
    copy(SCRIPTS/'mcp-launcher.mjs','scripts/mcp-launcher.mjs')
    copy(ROOT/'src/lib/source-watch-defaults.json','scripts/source-watch-defaults.json')
    default_model=json.loads((ROOT/'src-tauri/resources/foxess-default-model.json').read_text(encoding='utf-8'))
    default_model['credentialIncluded']=args.credential_mode == 'enterprise'
    write('scripts/foxess-default-model.json',json.dumps(default_model,ensure_ascii=False,indent=2)+'\n')
    copy(SCRIPTS/'FoxEss-WIKI-使用手册.html','FoxEss-WIKI-使用手册.html')
    copy(SCRIPTS/'FoxEss-WIKI-使用手册.md','FoxEss-WIKI-使用手册.md')
    copy(SCRIPTS/'安装与使用说明.md','安装与使用说明.md')
    skill_source=ROOT/'skills/llm-wiki/SKILL.md'
    if not skill_source.is_file():raise RuntimeError('Repository Skill asset is missing: skills/llm-wiki/SKILL.md')
    copy(skill_source,'skills/llm-wiki/SKILL.md')
    shutil.copytree(ROOT/'mcp-server/dist/src',PAYLOAD/'mcp-server/dist/src')
    shutil.copytree(ROOT/'mcp-server/node_modules',PAYLOAD/'mcp-server/node_modules',ignore=shutil.ignore_patterns('typescript','@types','.bin'))
    copy(ROOT/'mcp-server/package.json','mcp-server/package.json');copy(ROOT/'mcp-server/package-lock.json','mcp-server/package-lock.json')
    original=(ROOT/'src-tauri/src/commands/project.rs').read_text(encoding='utf-8-sig')
    schema=re.search(r'let schema_content = format!\(\s*r#"(.*?)"#\s*\);',original,re.S)
    if not schema:raise RuntimeError('Upstream project schema template missing')
    write('scripts/templates/schema.md',schema[1].replace('{{','{').replace('}}','}')+'\n\n## Product evidence\nPreserve exact product model, manufacturer, version, conditions, units, source path and original page references. Mark contradictions; do not blend parameters from different models.\n')
    templates={'purpose.md':'# 知识库目标\n\n维护共享目录中的产品、设备手册、参数及标准。保留实体、概念、来源、主题、比较、综合、查询页和跨文档链接。按目录组织主题；事实记录来源及原文页码，不同型号和版本分开，矛盾并列记录。\n',
      'wiki/index.md':'# 知识库索引\n','wiki/overview.md':'# 知识库总览\n\n由原版知识编译流程生成和维护。\n','wiki/log.md':'# Wiki Log\n'}
    for name,text in templates.items():write('scripts/templates/'+name,text)
    run(['powershell.exe','-NoProfile','-ExecutionPolicy','Bypass','-File',str(SCRIPTS/'Test-Initialize.ps1'),'-ScriptsRoot',str(PAYLOAD/'scripts'),'-TestRoot',str(ROOT/'.installer-tests'/STAGE.name)])
    write('wiki.cmd','@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\\cli.ps1" %*\r\n')
    write('mcp.cmd','@echo off\r\n"%~dp0runtime\\node.exe" "%~dp0scripts\\mcp-launcher.mjs" %*\r\n')
    write('licenses/THIRD-PARTY.md','# Third-party components\n\nLLM Wiki is GPL-3.0; corresponding source is included. Node.js licenses are in NODE-LICENSE.txt. MCP dependency licenses remain alongside each packaged npm module. PDFium license and notices are included. VC release runtime DLLs are redistributable components from Visual Studio; Microsoft terms apply. The signed WebView2 standalone installer includes Microsoft terms and is installed only when missing. No model weights are distributed.\n')
    # Explicit allowlist: never archive local databases, credentials, runtime, build tools or user documentation.
    sources=RELEASE/'llm-wiki-corresponding-source.zip'
    source_files=[]
    for dirname in ['src','src-tauri','scripts','public','vendor','.github','skills']:
        for p in (ROOT/dirname).rglob('*'):
            rel=p.relative_to(ROOT)
            if p.is_file() and not any(x in ('target','gen','node_modules','__pycache__') for x in rel.parts) and p.suffix.lower() not in ('.exe','.dll','.so','.dylib','.pdb'):
                source_files.append(p)
    for dirname in ['mcp-server/src','mcp-server/test','windows-native/installer']:
        source_files.extend(p for p in (ROOT/dirname).rglob('*') if p.is_file())
    for name in ['package.json','package-lock.json','tsconfig.json','tsconfig.node.json','tsconfig.app.json','vite.config.ts','components.json','index.html','LICENSE','README.md','UPSTREAM_README.md','PUBLISHING.md','mcp-server/package.json','mcp-server/package-lock.json','mcp-server/tsconfig.json','windows-native/Build.ps1','windows-native/Build-Installer.py','windows-native/Validate-External-Release.py','windows-native/Test-Installer.py','windows-native/install-rust.py','windows-native/Prepare-FoxEss-Model.py','windows-native/Test-FoxEss-Native.py','windows-native/Test-FoxEss-UI.py','windows-native/test-foxess-ui.mjs','windows-native/Run-Test-Candidate.ps1']:
        if (ROOT/name).is_file():source_files.append(ROOT/name)
    for name in ['Test-R5-Offline-Installer.py','Test-Offline-Installer.py','Sign-Release.mjs','Sign-Release.test.mjs','Publish-GitHub-Release.py','Test-Update-Helper.ps1','cli.py','Upgrade-State.ps1','Prepare-GitHub-Source.py']:
        source_files.append(ROOT/'windows-native'/name)
    # Preserve the exact upstream PDFium redistributable used by this build as an available build input.
    source_files.append(ROOT/'src-tauri/pdfium/pdfium.dll')
    with zipfile.ZipFile(sources,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=6) as z:
        for p in sorted(set(source_files)):z.write(p,p.relative_to(ROOT).as_posix())
        z.writestr('BUILD-WINDOWS.md','Install Node.js, Rust MSVC, Visual Studio C++ Build Tools and protoc. Run npm ci; npm --prefix mcp-server ci; npm run mcp:build; npm run build. Build src-tauri/Cargo.toml with --locked --features tauri/custom-protocol and set PROTOC_INCLUDE/PROTOC to your protobuf installation. Copy pdfium.dll beside the executable. The reference local Build.ps1 and all modified application sources, lockfiles and vendor patches are included. The installer ships the previously verified dev-profile executable. Build tools and dependencies can be installed from their official sources; user settings/data are excluded.\n')
    copy(sources,'source/'+sources.name)
    files=sorted(p for p in PAYLOAD.rglob('*') if p.is_file())
    upstream_commit=subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip()
    source_commit=os.environ.get('FOXESS_SOURCE_COMMIT',upstream_commit)
    if not re.fullmatch(r'[a-fA-F0-9]{40}|[a-fA-F0-9]{64}',source_commit):raise RuntimeError('FOXESS_SOURCE_COMMIT must be a complete commit hash')
    manifest={'product':'FoxEss WIKI','version':VERSION,'architecture':'x64','sourceCommit':source_commit.lower(),'upstreamCommit':upstream_commit,'builtAt':int(time.time()*1000),'files':[{'path':p.relative_to(PAYLOAD).as_posix(),'size':p.stat().st_size,'sha256':digest(p)} for p in files]}
    write('install-manifest.json',json.dumps(manifest,ensure_ascii=False,indent=2))
    files=sorted(p for p in PAYLOAD.rglob('*') if p.is_file())
    dirs=sorted((p for p in PAYLOAD.rglob('*') if p.is_dir()),key=lambda p:len(p.parts),reverse=True)
    def nsis_path(p):return str(p.relative_to(PAYLOAD)).replace('$','$$').replace('"','$\\"')
    delete_manifest=STAGE/'uninstall-files.nsh'
    delete_manifest.write_text('\n'.join(['Delete "$INSTDIR\\'+nsis_path(p)+'"' for p in files]+['RMDir "$INSTDIR\\'+nsis_path(p)+'"' for p in dirs]),encoding='utf-8-sig')
    compiler=next((TOOLS/'nsis').glob('*/makensis.exe'))
    output=RELEASE/('FoxEss-WIKI-'+VERSION+'-x64-Setup.exe')
    log=ROOT/'windows-native/runtime/installer-build.log'
    with log.open('w',encoding='utf-8') as stream:
        run([str(compiler),'/V2','/DPAYLOAD='+str(PAYLOAD),'/DOUTPUT='+str(output),'/DDELETE_MANIFEST='+str(delete_manifest),'/DAPP_VERSION='+VERSION,'/DAPP_FILE_VERSION='+VERSION+'.0',str(SCRIPTS/'setup.nsi')],stdout=stream,stderr=subprocess.STDOUT)
    shutil.copy2(SCRIPTS/'安装与使用说明.md',RELEASE/'安装与使用说明.md')
    update_manifest=RELEASE/('FoxEss-WIKI-'+VERSION+'-update.json')
    update_manifest.write_text(json.dumps({'schema':1,'repo':'superrepus/WIKI','version':VERSION,'installer':{'name':output.name,'sha256':digest(output),'size':output.stat().st_size},'executableSha256':digest(source_exe)},ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    (RELEASE/'SHA256SUMS.txt').write_text('\n'.join(f'{digest(p)}  {p.name}' for p in [output,sources,update_manifest,RELEASE/'安装与使用说明.md'])+'\n',encoding='utf-8')
    for filename in ['FoxEss-WIKI-使用手册.html','FoxEss-WIKI-使用手册.md']:shutil.copy2(SCRIPTS/filename,RELEASE/filename)
    report={'version':VERSION,'sourceCommit':source_commit.lower(),'upstreamCommit':upstream_commit,'credentialMode':args.credential_mode,'executable':str(source_exe),'updateManifest':str(update_manifest),'installer':str(output),'sizeBytes':output.stat().st_size,'sha256':digest(output),'stage':str(PAYLOAD),'source':str(sources),'files':len(files),'containsUserData':False,'nativeDefaultCredentialIncluded':bool(provenance.get('nativeDefaultCredentialIncluded')),'plaintextDefaultCredentialInPublicConfig':False}
    (ROOT/'windows-native/runtime/installer-build.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(report,ensure_ascii=False))
if __name__=='__main__':main()
