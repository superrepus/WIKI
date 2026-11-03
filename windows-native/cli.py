"""CLI adapter for the original Rust API. Never reads Wiki content directly."""
import argparse,json,os,sys
from pathlib import Path
from urllib import request,error,parse
ROOT=Path(__file__).resolve().parent.parent

def api(route,body=None):
    token=os.environ.get('LLM_WIKI_API_TOKEN')
    if not token:token=json.loads((ROOT/'windows-server/secrets.local.json').read_text(encoding='utf-8-sig'))['api_token']
    base=os.environ.get('LLM_WIKI_API_BASE_URL','http://127.0.0.1:19828').rstrip('/')
    if not base.endswith('/api/v1'):base+='/api/v1'
    req=request.Request(base+route,data=json.dumps(body,ensure_ascii=False).encode() if body is not None else None,headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'})
    try:
        with request.build_opener(request.ProxyHandler({})).open(req,timeout=600) as r:return json.load(r)
    except error.HTTPError as exc:raise RuntimeError(str(exc.code)+': '+exc.read().decode('utf-8')) from None

def main():
    sys.stdout.reconfigure(encoding='utf-8');sys.stderr.reconfigure(encoding='utf-8')
    p=argparse.ArgumentParser(description='原版 LLM Wiki 统一 API 客户端')
    p.add_argument('--project',default='current',help='原版项目 ID，默认当前桌面项目')
    sub=p.add_subparsers(dest='command',required=True)
    for command in ('status','projects','files','inventory','graph','reviews','rescan','routing'):sub.add_parser(command)
    for command in ('catalog','metrics'):
        extra=sub.add_parser(command);extra.add_argument('--offset',type=int,default=0);extra.add_argument('--limit',type=int,default=100)
        extra.add_argument('--kind',choices=['ingest','chat']);extra.add_argument('--model');extra.add_argument('--status');extra.add_argument('--source');extra.add_argument('--since',type=int);extra.add_argument('--until',type=int)
    s=sub.add_parser('search');s.add_argument('query');s.add_argument('--top',type=int,default=8)
    r=sub.add_parser('read');r.add_argument('path')
    c=sub.add_parser('chat');c.add_argument('message');c.add_argument('--session')
    args=p.parse_args();prefix='/projects/'+parse.quote(args.project,safe='')
    if args.command=='status':result={'health':api('/health'),'projects':api('/projects')}
    elif args.command=='projects':result=api('/projects')
    elif args.command=='files':result=api(prefix+'/files?recursive=true')
    elif args.command=='inventory':result=api(prefix+'/files?root=sources&recursive=true')
    elif args.command in ('graph','reviews'):result=api(prefix+'/'+args.command)
    elif args.command=='routing':result=api(prefix+'/model-routing')
    elif args.command in ('catalog','metrics'):
        query={k:getattr(args,k) for k in ('offset','limit','kind','model','status','source','since','until') if getattr(args,k,None) is not None}
        result=api(prefix+('/catalog' if args.command=='catalog' else '/task-metrics')+'?'+parse.urlencode(query))
    elif args.command=='rescan':result=api(prefix+'/sources/rescan',{})
    elif args.command=='search':result=api(prefix+'/search',{'query':args.query,'topK':args.top,'includeContent':True})
    elif args.command=='read':result=api(prefix+'/files/content?'+parse.urlencode({'path':args.path}))
    elif args.command=='chat':
        body={'message':args.message,'stream':False,'retrievalMode':'faithful'}
        if args.session:body['sessionId']=args.session
        result=api(prefix+'/chat',body)
    print(json.dumps(result,ensure_ascii=False,indent=2))
if __name__=='__main__':
    try:main()
    except Exception as exc:print(str(exc),file=sys.stderr);sys.exit(1)
