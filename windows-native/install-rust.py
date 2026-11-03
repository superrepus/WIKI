"""Install verified official Rust components without rustup rename operations.

All URLs and SHA256 checks come from Rust's official channel manifest. Only
regular files beneath known component directories are extracted.
"""
import hashlib
import json
from pathlib import Path
import tarfile
import tomllib
from urllib import request

ROOT=Path(__file__).resolve().parent.parent
TOOLS=ROOT/'native-tools'
DEST=TOOLS/'manual-rust'
TARGET='x86_64-pc-windows-msvc'
TOOLS.mkdir(exist_ok=True)
print('Reading official Rust channel manifest',flush=True)
with request.urlopen('https://static.rust-lang.org/dist/channel-rust-stable.toml',timeout=60) as r:
    manifest=tomllib.loads(r.read().decode())
report=[]
for component in ('rustc','rust-std','cargo'):
    item=manifest['pkg'][component]['target'][TARGET]
    url=item['xz_url'];expected=item['xz_hash']
    assert url.startswith('https://static.rust-lang.org/dist/')
    archive=TOOLS/(component+'.tar.xz')
    def sha(p):
        h=hashlib.sha256()
        with p.open('rb') as f:
            for b in iter(lambda:f.read(1024*1024),b''):h.update(b)
        return h.hexdigest()
    if not archive.exists() or sha(archive)!=expected:
        print('Downloading',component,flush=True)
        with request.urlopen(url,timeout=180) as r,archive.open('wb') as f:
            for block in iter(lambda:r.read(1024*1024),b''):f.write(block)
    if sha(archive)!=expected:raise RuntimeError('SHA256 mismatch: '+component)
    print('Verified and extracting',component,flush=True)
    count=0
    with tarfile.open(archive,'r:xz') as tf:
        for member in tf:
            parts=Path(member.name).parts
            if len(parts)<3 or not member.isfile():continue
            # rustc-VERSION-TARGET/rustc/... or rust-std-VERSION-TARGET/rust-std-TARGET/...
            if not parts[1].startswith(component):continue
            rel=Path(*parts[2:])
            dest=(DEST/rel).resolve()
            if not dest.is_relative_to(DEST.resolve()):raise RuntimeError('Invalid archive path')
            if rel.name=='manifest.in':continue
            dest.parent.mkdir(parents=True,exist_ok=True)
            with tf.extractfile(member) as src,dest.open('wb') as out:
                for b in iter(lambda:src.read(1024*1024),b''):out.write(b)
            count+=1
    report.append({'component':component,'sha256':expected,'files':count})
(TOOLS/'rust-component-verification.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
print('Official Rust components ready',flush=True)
