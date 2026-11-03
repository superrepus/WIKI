"""Publish only verified FoxEss release assets; use the local GitHub credential in memory."""
from pathlib import Path
import argparse, hashlib, json, os, re, subprocess, time, urllib.error, urllib.parse, urllib.request

ROOT = Path(__file__).resolve().parent.parent
REPO = 'superrepus/WIKI'
API = 'https://api.github.com'

def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()

def load(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))

def credential():
    result = subprocess.run(['git', '-c', 'credential.interactive=never', 'credential', 'fill'],
        input='protocol=https\nhost=github.com\n\n', text=True, capture_output=True, check=True,
        env={**os.environ, 'GIT_TERMINAL_PROMPT':'0', 'GCM_INTERACTIVE':'never'}, timeout=30)
    values = dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line)
    if not values.get('password'):
        raise RuntimeError('No local GitHub credential is available')
    return values['password']

def request(token, method, path, value=None, file=None):
    url = path if path.startswith('https://uploads.github.com/') else API + path
    if not url.startswith((API + '/', 'https://uploads.github.com/')):
        raise RuntimeError('Unexpected GitHub request destination')
    headers = {'Authorization':'Bearer '+token, 'Accept':'application/vnd.github+json',
               'X-GitHub-Api-Version':'2022-11-28', 'User-Agent':'FoxEss-WIKI-release'}
    if file:
        headers.update({'Content-Type':'application/octet-stream', 'Content-Length':str(file.stat().st_size)})
        with file.open('rb') as stream:
            req = urllib.request.Request(url, data=stream, headers=headers, method=method)
            with urllib.request.urlopen(req, timeout=600) as response:
                return json.load(response)
    data = json.dumps(value).encode() if value is not None else None
    if data is not None:
        headers['Content-Type']='application/json'
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=60) as response:
        body = response.read()
        return json.loads(body) if body else None

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--commit', required=True)
    parser.add_argument('--notes-file', type=Path, required=True)
    parser.add_argument('--publish', action='store_true', help='Publish after verified upload; otherwise leave a draft')
    parser.add_argument('--allow-public-enterprise-credential', action='store_true')
    args = parser.parse_args()
    if not re.fullmatch(r'[0-9a-fA-F]{40}', args.commit):
        raise RuntimeError('An exact published source commit SHA is required')
    runtime = ROOT/'windows-native/runtime'
    build = load(runtime/'installer-build.json')
    accepted = load(runtime/'installer-acceptance.json')
    provenance = load(runtime/'build-provenance.json')
    version = load(ROOT/'package.json')['version']
    release_dir = ROOT/'windows-native/releases'/('v'+version)
    installer = release_dir/f'FoxEss-WIKI-{version}-x64-Setup.exe'
    manifest = release_dir/f'FoxEss-WIKI-{version}-update.json'
    if not accepted.get('passed') or accepted.get('installerSha256') != digest(installer):
        raise RuntimeError('Final installer acceptance does not match this package')
    if build['sha256'] != digest(installer) or provenance['version'] != version:
        raise RuntimeError('Build provenance does not match this release')
    payload = load(Path(build['stage'])/'install-manifest.json')
    if payload.get('sourceCommit') != args.commit:
        raise RuntimeError('The installer does not refer to this source commit')
    signature = manifest.with_suffix(manifest.suffix+'.sig')
    if not signature.is_file():
        raise RuntimeError('The update manifest must be signed before upload')
    subprocess.run(['node', str(ROOT/'windows-native/Sign-Release.mjs'), '--verify-only'], cwd=ROOT, check=True)
    names = [installer.name, manifest.name, signature.name, 'llm-wiki-corresponding-source.zip',
             'SHA256SUMS.txt', 'FoxEss-WIKI-使用手册.html', 'FoxEss-WIKI-使用手册.md', '安装与使用说明.md', '验证结果.json']
    files = [release_dir/name for name in names]
    if not all(path.is_file() for path in files):
        raise RuntimeError('A required public release asset is missing')
    token = credential()
    repo = request(token, 'GET', '/repos/'+REPO)
    commit = request(token, 'GET', '/repos/'+REPO+'/commits/'+args.commit)
    if commit.get('sha') != args.commit:
        raise RuntimeError('The source commit is not available in the target repository')
    if args.publish and provenance.get('credentialMode') == 'enterprise' and repo.get('visibility') == 'public' and not args.allow_public_enterprise_credential:
        raise RuntimeError('Public release with an embedded enterprise credential requires explicit user authorization')
    tag = 'v'+version
    try:
        release = request(token, 'GET', '/repos/'+REPO+'/releases/tags/'+tag)
        if not release.get('draft'):
            raise RuntimeError('This stable release already exists; use a new version')
    except urllib.error.HTTPError as error:
        if error.code != 404:
            raise
        release = request(token, 'POST', '/repos/'+REPO+'/releases', {
            'tag_name':tag, 'target_commitish':args.commit, 'name':'FoxEss WIKI '+tag,
            'body':args.notes_file.read_text(encoding='utf-8'), 'draft':True, 'prerelease':False})
    release_id = release['id']
    existing = {row['name']:row for row in release.get('assets',[])}
    uploaded = []
    for path in files:
        expected = 'sha256:'+digest(path)
        asset = existing.get(path.name)
        if asset and (asset.get('size') != path.stat().st_size or asset.get('digest') != expected):
            # Only the private draft created for this release is modified.
            request(token, 'DELETE', '/repos/'+REPO+'/releases/assets/'+str(asset['id']))
            asset = None
        if not asset:
            asset = request(token, 'POST', f'https://uploads.github.com/repos/{REPO}/releases/{release_id}/assets?'+urllib.parse.urlencode({'name':path.name}), file=path)
        for attempt in range(6):
            if asset.get('digest'):
                break
            time.sleep(2)
            asset = request(token, 'GET', '/repos/'+REPO+'/releases/assets/'+str(asset['id']))
        if asset.get('size') != path.stat().st_size or asset.get('digest') != expected or asset.get('state') != 'uploaded':
            raise RuntimeError('Uploaded asset digest does not match: '+path.name)
        uploaded.append({'name':path.name, 'size':asset['size'], 'sha256':expected[7:]})
        print(json.dumps({'assetVerified':path.name, 'size':asset['size']}, ensure_ascii=False), flush=True)
    if args.publish:
        release = request(token, 'PATCH', '/repos/'+REPO+'/releases/'+str(release_id), {
            'draft':False, 'prerelease':False, 'make_latest':'true', 'target_commitish':args.commit,
            'body':args.notes_file.read_text(encoding='utf-8')})
    report = {'passed':True, 'repository':REPO, 'version':version, 'published':not release['draft'],
              'url':release['html_url'], 'commit':args.commit, 'assets':uploaded}
    (runtime/'github-release-published.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps(report,ensure_ascii=False))

if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Do not print HTTP request headers, credential-helper output or response bodies.
        print(json.dumps({'passed':False, 'errorType':type(error).__name__,
                          'httpStatus':getattr(error,'code',None)}))
        raise SystemExit(1)
