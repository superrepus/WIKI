//! Serving guard for opt-in managed projects. Original retrieval/Agent stay intact.
use std::{fs, path::Path};
use serde_json::Value;

/// Merge the append-only journal in native code: large libraries must not load
/// hundreds of MB of duplicate JSONL into the WebView before withdrawing pages.
#[tauri::command]
pub async fn read_source_provenance(project_path: String) -> Result<std::collections::BTreeMap<String, Vec<String>>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use std::io::BufRead;
        use std::collections::{BTreeMap, BTreeSet};
        let path = Path::new(&project_path).join(".llm-wiki/source-page-dependencies.jsonl");
        let mut merged:BTreeMap<String,BTreeSet<String>>=BTreeMap::new();
        if !path.exists() { return Ok(BTreeMap::new()); }
        for line in std::io::BufReader::new(fs::File::open(path).map_err(|e|e.to_string())?).lines() {
            let line=line.map_err(|e|e.to_string())?; if line.trim().is_empty(){continue;}
            let record:Value=serde_json::from_str(&line).map_err(|e|format!("Incomplete dependency journal: {e}"))?;
            let page=record["path"].as_str().ok_or("Dependency path missing")?;
            let sources=record["sources"].as_array().ok_or("Dependency sources missing")?;
            for s in sources { if let Some(s)=s.as_str(){merged.entry(page.into()).or_default().insert(s.into());} }
        }
        Ok(merged.into_iter().map(|(k,v)|(k,v.into_iter().collect())).collect())
    }).await.map_err(|e|e.to_string())?
}

pub fn generation(project_path: &str) -> Result<Option<u64>, String> {
    let path = Path::new(project_path).join(".llm-wiki/source-reconciliation.json");
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("Source reconciliation state unavailable: {e}")),
    };
    let state: Value = serde_json::from_str(&raw).map_err(|e| format!("Invalid source reconciliation state: {e}"))?;
    if state.get("enabled").and_then(Value::as_bool) != Some(true) { return Ok(None); }
    if state.get("blocked").and_then(Value::as_bool) != Some(false) {
        return Err("Source retraction is in progress; project knowledge is temporarily unavailable".into());
    }
    state.get("generation").and_then(Value::as_u64).map(Some).ok_or_else(|| "Invalid source generation".into())
}

pub fn assert_unchanged(project_path: &str, initial: Option<u64>) -> Result<(), String> {
    if generation(project_path)? != initial {
        return Err("Source knowledge changed during this request; stale result discarded. Retry with current sources.".into());
    }
    Ok(())
}

pub fn session_history_current(project_path: &str, session_id: Option<&str>, current: u64) -> bool {
    let Some(session_id) = session_id else { return false; };
    if session_id.chars().any(|c| !c.is_ascii_alphanumeric() && c != '_' && c != '-') { return false; }
    let path = Path::new(project_path).join(".llm-wiki/agent-sessions").join(format!("{session_id}.json"));
    fs::read_to_string(path).ok().and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.get("knowledgeGeneration").and_then(Value::as_u64)) == Some(current)
}

/// Independent append-only provenance avoids racing the frontend state writer.
/// Unknown legacy pages are conservatively invalidated by the frontend planner.
pub fn record_written_page(root: &Path, path: &Path, author: &str) {
    use std::io::Write;
    use std::sync::{Mutex, OnceLock};
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    if author == "baseline" { return; }
    let Ok(rel) = path.strip_prefix(root) else { return; };
    let rel = rel.to_string_lossy().replace('\\', "/");
    if !rel.starts_with("wiki/") || !rel.ends_with(".md") || ["wiki/index.md", "wiki/overview.md", "wiki/log.md"].contains(&rel.as_str()) { return; }
    let Ok(_guard) = LOCK.get_or_init(|| Mutex::new(())).lock() else { return; };
    let state_path = root.join(".llm-wiki/source-reconciliation.json");
    let Ok(raw) = fs::read_to_string(&state_path) else { return; };
    let Ok(mut state) = serde_json::from_str::<Value>(&raw) else { return; };
    if state["enabled"] != true || state["blocked"] == true { return; }
    let deps: Vec<String> = state["sources"].as_object().map(|m| m.keys().cloned().collect()).unwrap_or_default();
    let entry = serde_json::json!({"path": rel, "sources": deps, "generation": state["generation"], "author": author});
    let journal = root.join(".llm-wiki/source-page-dependencies.jsonl");
    let result = fs::OpenOptions::new().create(true).append(true).open(journal).and_then(|mut f| writeln!(f, "{entry}"));
    if result.is_err() {
        state["blocked"] = Value::Bool(true);
        let _ = fs::write(state_path, state.to_string());
    }
}
