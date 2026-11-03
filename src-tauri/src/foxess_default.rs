//! The distributed client contains a native credential. It is not a security boundary
//! against reverse engineering, but no plaintext credential is returned to the WebView.
use serde_json::Value;
include!(concat!(env!("OUT_DIR"), "/foxess_credential.rs"));
pub const MARKER: &str = "__FOXESS_BUILTIN_CREDENTIAL__";
pub fn metadata() -> Value { serde_json::from_str(include_str!("../resources/foxess-default-model.json")).expect("valid public model metadata") }
pub fn credential() -> Option<String> {
    if FOXESS_ENCODED.is_empty() || FOXESS_MASK.is_empty(){return None;}
    String::from_utf8(FOXESS_ENCODED.iter().enumerate().map(|(i,b)|b^FOXESS_MASK[i%FOXESS_MASK.len()]).collect()).ok()
}
pub fn allowed_url(url: &str) -> bool {
    let Some(base)=metadata()["baseUrl"].as_str().and_then(|s|reqwest::Url::parse(s).ok()) else{return false;};
    let Ok(target)=reqwest::Url::parse(url) else{return false;};
    let suffix=target.path().strip_prefix(base.path().trim_end_matches('/'));
    base.origin()==target.origin() && target.username().is_empty() && target.password().is_none()
        && matches!(suffix,Some("/chat/completions"|"/models"|"/responses"))
}
pub fn authorization_key(configured: &str,url: &str)->Result<String,String>{
    if configured!=MARKER{return Ok(configured.to_owned());}
    if !allowed_url(url){return Err("The built-in model credential can only be used with the FoxEss default service".into());}
    credential().ok_or_else(||"The enterprise model credential is missing from this build; select a custom model".into())
}
pub fn register_transport(){
    if let Some(key)=credential(){
        let base=metadata()["baseUrl"].as_str().unwrap_or_default().to_owned();
        tauri_plugin_http::set_managed_authorization(MARKER.to_owned(),base,key);
    }
}
#[cfg(test)] mod tests {
    use super::*;
    #[test] fn managed_secret_is_scoped_and_never_public(){
        let m=metadata();let base=m["baseUrl"].as_str().unwrap();
        assert!(allowed_url(&format!("{base}/chat/completions")));
        assert!(!allowed_url("https://untrusted.invalid/v1/chat/completions"));
        assert!(!allowed_url(&format!("{base}/../collect")));
        assert!(!allowed_url(&format!("{base}/chat/completions/extra")));
        if let Some(key)=credential(){assert!(!m.to_string().contains(&key));}
        assert_eq!(authorization_key("user-key","https://other.invalid").unwrap(),"user-key");
        assert!(authorization_key(MARKER,"https://other.invalid").is_err());
    }
}
