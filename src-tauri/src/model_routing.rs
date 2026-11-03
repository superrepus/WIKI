//! Same preset registry and fallback contract as resolveTaskLlmConfig in the UI.
use serde_json::{json, Value};
use crate::agent::provider::LlmConfig;

pub fn enterprise_profile(state:&Value)->Option<LlmConfig>{
    let m=crate::foxess_default::metadata();
    let ov=&state["providerConfigs"]["foxess-default"];
    let mut p=state.get("llmConfig").cloned().unwrap_or(json!({}));
    for (key,value) in [("provider",json!("custom")),("apiKey",json!(crate::foxess_default::MARKER)),("model",m["defaultModel"].clone()),("customEndpoint",m["baseUrl"].clone()),("apiMode",json!("chat_completions")),("customHeaders",json!({})),("reasoning",json!({"mode":"off"}))]{p[key]=value;}
    p["maxContextSize"]=ov.get("maxContextSize").cloned().unwrap_or(m["suggestedContextSize"].clone());
    p["streamingEnabled"]=ov.get("streamingEnabled").cloned().unwrap_or(json!(false));
    p["ollamaUrl"]=json!("http://localhost:11434");
    p["requestTimeoutMinutes"]=ov.get("requestTimeoutMinutes").cloned().unwrap_or(m["requestTimeoutMinutes"].clone());
    p["reasoning"]=ov.get("reasoning").cloned().unwrap_or(json!({"mode":"off"}));
    if let Some(value)=ov.get("extraRequestBody"){p["extraRequestBody"]=value.clone();}else{p.as_object_mut()?.remove("extraRequestBody");}
    serde_json::from_value(p).ok()
}

pub fn task_profile(state: &Value, task: &str) -> Option<LlmConfig> {
    let fallback = state.get("llmConfig")?.clone();
    let key = if task == "ingest" { "ingestPresetId" } else { "chatPresetId" };
    let Some(id) = state.get("taskModelRouting").and_then(|v| v.get(key)).and_then(Value::as_str).filter(|id| !id.is_empty()) else {
        return serde_json::from_value(fallback).ok();
    };
    if id=="foxess-default"{return enterprise_profile(state);}
    let builtins: Vec<Value> = serde_json::from_str(include_str!("../resources/llm-presets.json")).ok()?;
    let preset = builtins.into_iter().find(|v| v["id"] == id).or_else(|| {
        state.get("customLlmPresets").and_then(Value::as_array)?.iter().find(|v| v["id"] == id)
            .map(|_| json!({"id":id,"provider":"custom","apiMode":"chat_completions"}))
    });
    let Some(preset) = preset else { return serde_json::from_value(fallback).ok(); };
    let ov = state.get("providerConfigs").and_then(|v| v.get(id)).cloned().unwrap_or(json!({}));
    let provider = preset["provider"].as_str()?;
    let mut profile = fallback.clone();
    let p = profile.as_object_mut()?;
    p.insert("provider".into(), json!(provider));
    p.insert("apiKey".into(), ov.get("apiKey").cloned().unwrap_or(json!("")));
    p.insert("model".into(), ov.get("model").or_else(|| preset.get("defaultModel")).cloned().unwrap_or(json!("")));
    if let Some(v) = ov.get("maxContextSize").or_else(|| preset.get("suggestedContextSize")) { p.insert("maxContextSize".into(), v.clone()); }
    p.insert("reasoning".into(), ov.get("reasoning").cloned().unwrap_or(json!({"mode":"auto"})));
    for key in ["streamingEnabled", "customHeaders", "extraRequestBody", "maxTokens"] {
        p.remove(key);
        if let Some(v) = ov.get(key) { p.insert(key.into(), v.clone()); }
    }
    if provider == "custom" || provider == "azure" || provider == "ollama" {
        let endpoint = ov.get("baseUrl").or_else(|| preset.get("baseUrl")).cloned()
            .unwrap_or_else(|| json!(if provider == "ollama" { "http://localhost:11434" } else { "" }));
        p.insert(if provider == "ollama" { "ollamaUrl" } else { "customEndpoint" }.into(), endpoint);
    }
    if provider == "ollama" { p.insert("apiKey".into(), json!("")); }
    if provider == "custom" {
        p.insert("apiMode".into(), ov.get("apiMode").or_else(|| preset.get("apiMode")).cloned().unwrap_or(json!("chat_completions")));
    } else { p.remove("apiMode"); }
    if provider == "azure" {
        p.insert("azureApiVersion".into(), ov.get("azureApiVersion").or_else(|| preset.get("azureApiVersion")).cloned().unwrap_or(json!("2024-10-21")));
        p.insert("azureModelFamily".into(),ov.get("azureModelFamily").or_else(||preset.get("azureModelFamily")).cloned().unwrap_or(json!("auto")));
    }
    serde_json::from_value(profile).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn managed_task_route_uses_public_marker_and_pinned_service(){
        let state=json!({"llmConfig":{"provider":"custom","model":"user-model","apiKey":"USER_KEY","customEndpoint":"https://user.invalid","ollamaUrl":""},"taskModelRouting":{"chatPresetId":"foxess-default"},"providerConfigs":{"foxess-default":{"apiKey":"NOT_USED","baseUrl":"https://other.invalid","model":"not-used","maxContextSize":32000}}});
        let c=task_profile(&state,"chat").unwrap();let m=crate::foxess_default::metadata();
        assert_eq!(c.api_key,crate::foxess_default::MARKER);assert_eq!(c.custom_endpoint,m["baseUrl"].as_str().unwrap());assert_eq!(c.model,m["defaultModel"].as_str().unwrap());
        assert_eq!(c.max_context_size,Some(32000));
    }
    #[test]
    fn independent_tasks_credentials_rotation_and_deleted_presets() {
        let mut state = json!({"llmConfig":{"provider":"custom","model":"global","apiKey":"global-key","ollamaUrl":"","customEndpoint":"http://global/v1"},
            "customLlmPresets":[{"id":"custom-chat"},{"id":"custom-ingest"}],
            "taskModelRouting":{"chatPresetId":"custom-chat","ingestPresetId":"custom-ingest"},
            "providerConfigs":{"custom-chat":{"model":"chat-model","apiKey":"chat-key","baseUrl":"http://chat/v1","customHeaders":{"X-Tenant":"A"}},
            "custom-ingest":{"model":"build-model","baseUrl":"http://build/v1"}}});
        let chat = task_profile(&state,"chat").unwrap();
        assert_eq!(chat.model,"chat-model"); assert_eq!(chat.custom_endpoint,"http://chat/v1"); assert_eq!(chat.api_key,"chat-key");
        assert_eq!(task_profile(&state,"ingest").unwrap().model,"build-model");
        assert!(task_profile(&state,"ingest").unwrap().api_key.is_empty());
        assert!(task_profile(&state,"ingest").unwrap().custom_headers.is_empty());
        state["providerConfigs"]["custom-chat"]["apiKey"] = json!("rotated");
        assert_eq!(task_profile(&state,"chat").unwrap().api_key,"rotated");
        state["customLlmPresets"] = json!([]);
        assert_eq!(task_profile(&state,"chat").unwrap().model,"global");
    }
}
