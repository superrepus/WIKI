//! Persisted operational metadata only: no prompts, completions, keys or headers.
use std::{fs, path::Path, sync::{Arc, Mutex}, time::{Instant, SystemTime, UNIX_EPOCH}};
use serde_json::{json, Value};
pub type Calls = Arc<Mutex<Vec<Value>>>;
tokio::task_local! { pub static CALLS: Calls; }
pub fn now_ms() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64 }

pub struct ModelCall { calls: Calls, index: usize, start: Instant }
impl ModelCall {
    pub fn start(model: &str) -> Self {
        let calls = CALLS.try_with(Clone::clone).unwrap_or_default();
        let index = { let mut rows = calls.lock().unwrap_or_else(|p| p.into_inner()); let i = rows.len();
            rows.push(json!({"model":model,"stage":"agent","startedAt":now_ms(),"status":"running","usage":null})); i };
        Self { calls, index, start: Instant::now() }
    }
    pub fn usage(&self, payload: &Value) {
        let Some(usage) = parse_usage(payload) else { return; };
        let mut rows = self.calls.lock().unwrap_or_else(|p| p.into_inner());
        let mut merged = rows[self.index]["usage"].as_object().cloned().unwrap_or_default();
        for (k,v) in usage.as_object().unwrap() { if !v.is_null() { merged.insert(k.clone(), v.clone()); } }
        if let (Some(a),Some(b)) = (merged.get("inputTokens").and_then(Value::as_u64), merged.get("outputTokens").and_then(Value::as_u64)) {
            if usage.get("totalTokens").is_none_or(Value::is_null) { merged.insert("totalTokens".into(), json!(a+b)); }
        }
        rows[self.index]["usage"] = Value::Object(merged);
    }
    pub fn finish(&self, status: &str) {
        let mut rows = self.calls.lock().unwrap_or_else(|p| p.into_inner());
        if rows[self.index]["status"] != "running" { return; }
        rows[self.index]["endedAt"] = json!(now_ms()); rows[self.index]["durationMs"] = json!(self.start.elapsed().as_millis() as u64);
        rows[self.index]["status"] = json!(status);
    }
}
impl Drop for ModelCall { fn drop(&mut self) { self.finish("failed"); } }

pub fn parse_usage(p: &Value) -> Option<Value> {
    let u = p.get("usage").or_else(|| p.pointer("/message/usage")).or_else(|| p.pointer("/response/usage"))
        .or_else(|| p.get("usageMetadata")).or_else(|| if p.get("prompt_eval_count").is_some() { Some(p) } else { None })?;
    let find = |keys: &[&str]| keys.iter().find_map(|k| u.get(*k).and_then(Value::as_u64));
    let mut input = find(&["prompt_tokens","input_tokens","promptTokenCount","prompt_eval_count"]);
    if u.get("prompt_tokens").is_none() && u.get("input_tokens").is_some() {
        input=input.map(|n|n+find(&["cache_read_input_tokens"]).unwrap_or(0)+find(&["cache_creation_input_tokens"]).unwrap_or(0));
    }
    let output = find(&["completion_tokens","output_tokens","candidatesTokenCount","eval_count"]);
    let total = find(&["total_tokens","totalTokenCount"]).or_else(|| input.zip(output).map(|(a,b)|a+b));
    if input.is_none() && output.is_none() && total.is_none() { return None; }
    Some(json!({"inputTokens":input,"outputTokens":output,"totalTokens":total,
        "cachedInputTokens":u.pointer("/prompt_tokens_details/cached_tokens").or_else(||u.get("cache_read_input_tokens")).or_else(||u.get("cachedContentTokenCount")),
        "cacheCreationInputTokens":u.get("cache_creation_input_tokens"),
        "reasoningTokens":u.pointer("/completion_tokens_details/reasoning_tokens").or_else(||u.get("thoughtsTokenCount"))}))
}

pub fn summarize(requests: &[Value]) -> Value {
    let total = |key: &str| requests.iter().filter_map(|r|r["usage"][key].as_u64()).sum::<u64>();
    let complete = |key: &str| requests.iter().all(|r|r["usage"][key].as_u64().is_some());
    let unknown = requests.iter().filter(|r|r["usage"]["totalTokens"].as_u64().is_none()).count();
    json!({"inputTokens":if complete("inputTokens"){Some(total("inputTokens"))}else{None},
        "outputTokens":if complete("outputTokens"){Some(total("outputTokens"))}else{None},
        "totalTokens":if complete("totalTokens"){Some(total("totalTokens"))}else{None},
        "reportedTokens":total("totalTokens"),"unknownUsageRequests":unknown,
        "usageCoverage":if requests.is_empty(){"no-model-requests"}else if unknown==0{"complete"}else if unknown==requests.len(){"unavailable"}else{"partial"}})
}

pub async fn write(project: &str, record: &Value) -> Result<(), String> {
    if !Path::new(project).is_dir() { return Err("Project directory is missing".into()); }
    let dir = Path::new(project).join(".llm-wiki/task-metrics"); fs::create_dir_all(&dir).map_err(|e|e.to_string())?;
    let id = record["id"].as_str().ok_or("metrics id is missing")?;
    if id.chars().any(|c| !c.is_ascii_alphanumeric() && c!='-') { return Err("Invalid metrics id".into()); }
    let path = dir.join(format!("{id}.json"));
    // Windows rename cannot overwrite an existing file. Use the same replace
    // primitive as native atomic writes to avoid readers seeing partial JSON.
    crate::commands::fs::write_file_atomic(path.to_string_lossy().to_string(),serde_json::to_string(record).map_err(|e|e.to_string())?).await
}

pub fn read(project: &str) -> Result<Vec<Value>, String> {
    let dir = Path::new(project).join(".llm-wiki/task-metrics");
    if !dir.exists() { return Ok(vec![]); }
    let mut rows = Vec::new();
    for item in fs::read_dir(dir).map_err(|e|e.to_string())? {
        let item = item.map_err(|e|e.to_string())?;
        if !item.file_type().map_err(|e|e.to_string())?.is_file() || item.path().extension().and_then(|s|s.to_str())!=Some("json") { continue; }
        let raw = fs::read(item.path()).map_err(|e|e.to_string())?;
        rows.push(serde_json::from_slice(&raw).map_err(|e|format!("Invalid task metric: {e}"))?);
    }
    rows.sort_by_key(|r:&Value| std::cmp::Reverse(r["startedAt"].as_u64().unwrap_or(0))); Ok(rows)
}

#[cfg(test)] mod tests {
    use super::*;
    #[test] fn usage_is_reported_not_estimated() {
        assert_eq!(parse_usage(&json!({"usage":{"prompt_tokens":11,"completion_tokens":7,"total_tokens":18}})).unwrap()["totalTokens"],18);
        assert_eq!(parse_usage(&json!({"prompt_eval_count":20,"eval_count":4})).unwrap()["totalTokens"],24);
        assert!(parse_usage(&json!({"text":"not token evidence"})).is_none());
        let rows=vec![json!({"usage":{"inputTokens":11,"outputTokens":7,"totalTokens":18}}),json!({"usage":null})];
        let s=summarize(&rows);assert_eq!(s["usageCoverage"],"partial");assert!(s["totalTokens"].is_null());assert_eq!(s["reportedTokens"],18);
    }
    #[tokio::test] async fn scoped_calls_do_not_cross_concurrent_tasks() {
        let a:Calls=Arc::default();let b:Calls=Arc::default();
        let ((),())=tokio::join!(CALLS.scope(a.clone(),async{let c=ModelCall::start("A");c.usage(&json!({"usage":{"prompt_tokens":3,"completion_tokens":2}}));c.finish("done");}),
            CALLS.scope(b.clone(),async{let c=ModelCall::start("B");c.finish("failed");}));
        assert_eq!(a.lock().unwrap()[0]["model"],"A");assert_eq!(b.lock().unwrap()[0]["model"],"B");
        assert_eq!(summarize(&a.lock().unwrap())["totalTokens"],5);assert!(summarize(&b.lock().unwrap())["totalTokens"].is_null());
    }
}
