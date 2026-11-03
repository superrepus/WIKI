//! Native-only credential injection for a deliberately public client-side marker.
use std::sync::OnceLock;
use http::{HeaderMap,header,HeaderValue};
struct Managed {marker:String,base:url::Url,key:String}
static MANAGED:OnceLock<Managed>=OnceLock::new();
pub fn set(marker:String,base:String,key:String){if let Ok(base)=url::Url::parse(&base){let _=MANAGED.set(Managed{marker,base,key});}}
pub(crate) fn apply(url:&url::Url,headers:&mut HeaderMap)->crate::Result<bool>{
    let Some(m)=MANAGED.get() else{return Ok(false);};
    if headers.get(header::AUTHORIZATION).and_then(|v|v.to_str().ok())!=Some(format!("Bearer {}",m.marker).as_str()){return Ok(false);}
    let suffix=url.path().strip_prefix(m.base.path().trim_end_matches('/'));
    if url.origin()!=m.base.origin() || !url.username().is_empty() || url.password().is_some() || !matches!(suffix,Some("/chat/completions"|"/models"|"/responses")){
        return Err(crate::Error::ManagedCredentialScope);
    }
    let mut value=HeaderValue::from_str(&format!("Bearer {}",m.key))?;value.set_sensitive(true);
    headers.insert(header::AUTHORIZATION,value);Ok(true)
}
