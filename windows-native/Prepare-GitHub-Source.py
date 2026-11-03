"""Create an isolated, credential-scanned Git source snapshot. Never stage the live checkout."""
from pathlib import Path
import ast, hashlib, json, os, re, shutil, subprocess, time

ROOT=Path(__file__).resolve().parent.parent

def digest(path):
    with path.open('rb') as stream:return hashlib.file_digest(stream,'sha256').hexdigest()

def excluded(relative):
    parts=relative.parts
    return any(part in ('node_modules','target','gen','__pycache__','.git','.llm-wiki') for part in parts) or \
        '.private.' in relative.name or relative.name.endswith(('.pyc','.pdb','.log')) or \
        relative.name in ('secrets.local.json','config.local.json','mcp-config.local.json') or \
        str(relative).replace('\\','/').startswith(('windows-native/runtime/','windows-native/releases/','windows-native/app/','windows-server/','native-tools/','original-desktop/','.installer-tests/'))

def secrets():
    values=[]
    for name in ['windows-server/secrets.local.json','windows-native/runtime/foxess-current-profile.private.json']:
        p=ROOT/name
        if not p.is_file():continue
        data=json.loads(p.read_text(encoding='utf-8-sig'))
        values += [data.get('api_token'),data.get('model_api_key'),data.get('llmConfig',{}).get('apiKey'),data.get('apiConfig',{}).get('token')]
    values=[v for v in values if isinstance(v,str) and len(v)>=8 and v!='__FOXESS_BUILTIN_CREDENTIAL__']
    key=ROOT/'windows-native/runtime/update-signing-key.private.pem'
    if key.exists():values.append(key.read_text(encoding='utf-8').strip())
    if not values:raise RuntimeError('No local secret reference is available for source leak checking')
    return [form.encode(encoding) for value in values for form in (value,json.dumps(value,ensure_ascii=False)[1:-1],json.dumps(value,ensure_ascii=True)[1:-1]) for encoding in ('utf-8','utf-16-le')]

def main():
    tracked=subprocess.check_output(['git','ls-files','-z'],cwd=ROOT).decode().split('\0')
    files={ROOT/name for name in tracked if name and (ROOT/name).is_file()}
    for directory in ['src','src-tauri/src','src-tauri/icons','src-tauri/resources','scripts','vendor','skills','mcp-server/src','mcp-server/test','windows-native/installer']:
        files.update(p for p in (ROOT/directory).rglob('*') if p.is_file())
    # Share the release's explicit source allowlist instead of copying build/runtime directories.
    tree=ast.parse((ROOT/'windows-native/Build-Installer.py').read_text(encoding='utf-8'))
    for node in ast.walk(tree):
        if isinstance(node,ast.List):
            for item in node.elts:
                if isinstance(item,ast.Constant) and isinstance(item.value,str):
                    if item.value.startswith('windows-native/'):
                        path=ROOT/item.value
                    elif '/' not in item.value and '\\' not in item.value and Path(item.value).suffix in ('.py','.ps1','.mjs'):
                        path=ROOT/'windows-native'/item.value
                    else:
                        continue
                    if path.is_file():files.add(path)
    for name in ['PUBLISHING.md','UPSTREAM_README.md','windows-native/Prepare-GitHub-Source.py']:
        files.add(ROOT/name)
    files=sorted(p for p in files if not excluded(p.relative_to(ROOT)))
    needles=secrets()
    binary_suffixes={'.dll','.so','.dylib','.png','.jpg','.jpeg','.webp','.ico','.icns','.woff2','.pdf'}
    checked=0
    for p in files:
        if p.stat().st_size>=95*1024*1024:raise RuntimeError('A source file exceeds the safe Git upload size: '+p.relative_to(ROOT).as_posix())
        if p.suffix.lower() not in binary_suffixes:
            data=p.read_bytes();checked+=1
            if re.search(rb'^-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----\s*$',data,re.M) or any(value in data for value in needles):
                raise RuntimeError('Private credential found in source candidate: '+p.relative_to(ROOT).as_posix())
    destination=ROOT/'windows-native/runtime'/('github-v1-source-'+str(time.time_ns()))
    destination.mkdir()
    for p in files:
        relative=p.relative_to(ROOT);target=destination/relative
        target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(p,target)
    env={**os.environ,'GIT_TERMINAL_PROMPT':'0','GCM_INTERACTIVE':'never'}
    def git(*args):return subprocess.check_output(['git',*args],cwd=destination,env=env,text=True,stderr=subprocess.STDOUT).strip()
    git('init','-b','main')
    git('config','user.name','superrepus')
    git('config','user.email','102671195+superrepus@users.noreply.github.com')
    git('remote','add','origin','https://github.com/superrepus/WIKI.git')
    git('add','--all')
    git('commit','-m','Release FoxEss WIKI v1.0.0 with signed daily GitHub updates')
    commit=git('rev-parse','HEAD')
    report={'passed':True,'directory':str(destination),'commit':commit,'files':len(files),'secretScannedTextFiles':checked,
            'filesSha256':{p.relative_to(ROOT).as_posix():digest(p) for p in files},'originalCheckoutStaged':False,'pushed':False}
    (ROOT/'windows-native/runtime/github-source-staging.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({key:value for key,value in report.items() if key!='filesSha256'},ensure_ascii=False))

if __name__=='__main__':main()
