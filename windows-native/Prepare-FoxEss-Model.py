"""Prepare public model metadata and private native build input; never print credentials."""
from pathlib import Path
import json,secrets,sys
root=Path(__file__).resolve().parent.parent
state=json.loads((root/'windows-native/runtime/foxess-current-profile.private.json').read_text(encoding='utf-8-sig'))
cfg=state['llmConfig']
if cfg.get('provider')!='custom' or cfg.get('apiMode','chat_completions')!='chat_completions':raise RuntimeError('The default model must currently use an OpenAI-compatible custom endpoint')
key=cfg.get('apiKey','').encode()
if not key or b'\r' in key or b'\n' in key:raise RuntimeError('No valid configured model credential is available')
public={'id':'foxess-default','label':'FoxEss 企业默认模型','provider':'custom','baseUrl':cfg['customEndpoint'].rstrip('/'),'defaultModel':cfg['model'],'apiMode':'chat_completions','suggestedContextSize':cfg.get('maxContextSize',64000),'streamingEnabled':cfg.get('streamingEnabled',False),'requestTimeoutMinutes':cfg.get('requestTimeoutMinutes',10),'credentialMarker':'__FOXESS_BUILTIN_CREDENTIAL__'}
mask=secrets.token_bytes(32)
private={'mask':list(mask),'encoded':list(bytes(c^mask[i%len(mask)] for i,c in enumerate(key)))}
(root/'src-tauri/resources/foxess-default-model.json').write_text(json.dumps(public,ensure_ascii=False,indent=2),encoding='utf-8')
(root/'windows-native/runtime/foxess-default-model.private.json').write_text(json.dumps(private),encoding='utf-8')
print(json.dumps({'model':public['defaultModel'],'provider':public['provider'],'credentials':'native-only; excluded from public configuration and source archive'},ensure_ascii=False))
