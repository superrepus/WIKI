//! Signed, opt-in GitHub Releases updates. Preparing an update never exits the app.
//! Only a one-use receipt, after the UI has saved its work, can arm the helper.

use base64::Engine;
use futures::StreamExt;
use ring::signature;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::Manager;

const REPO: &str = "superrepus/WIKI";
const MAX_INSTALLER: u64 = 2 * 1024 * 1024 * 1024;
const PUBLIC_KEY: &str = include_str!("../resources/update-public-key.json");
const HELPER: &str = include_str!("../../windows-native/installer/Update.ps1");

#[derive(Default)]
pub struct GithubUpdateState(Mutex<UpdateInner>);
#[derive(Default)]
struct UpdateInner { preparing: bool, ready: Option<PreparedUpdate> }
#[derive(Clone)]
struct PreparedUpdate { receipt: String, version: String, directory: PathBuf, plan: UpdatePlan }

#[derive(Debug, Deserialize)]
struct PublicKey { algorithm: String, #[serde(rename="publicKey")] public_key: String }
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all="camelCase")]
struct Installer { name: String, sha256: String, size: u64 }
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all="camelCase")]
struct UpdateManifest { schema: u32, repo: String, version: String, installer: Installer, executable_sha256: String }
#[derive(Debug, Deserialize)]
struct Release { tag_name: String, #[serde(default)] draft: bool, #[serde(default)] prerelease: bool, assets: Vec<Asset> }
#[derive(Debug, Deserialize)]
struct Asset { name: String, browser_download_url: String, size: u64 }
#[derive(Clone, Serialize)]
#[serde(rename_all="camelCase")]
struct UpdatePlan {
    schema: u32, version: String, parent_pid: u32, install_root: String,
    executable: String, installer: String, installer_sha256: String,
    executable_sha256: String, result_file: String,
}

#[derive(Serialize)]
pub struct UpdateReady { status: &'static str, version: String, receipt: String }

fn semver(value: &str) -> Result<[u64; 3], String> {
    let value=value.strip_prefix('v').unwrap_or(value);
    let parts=value.split('.').collect::<Vec<_>>();
    if parts.len()!=3 || parts.iter().any(|part| part.is_empty() || !part.bytes().all(|c|c.is_ascii_digit()) || part.len()>1 && part.starts_with('0')) {
        return Err("更新版本号无效。".into());
    }
    Ok([parts[0].parse().map_err(|_|"更新版本号无效。")?,parts[1].parse().map_err(|_|"更新版本号无效。")?,parts[2].parse().map_err(|_|"更新版本号无效。")?])
}
fn clean_version(value: &str) -> Result<String, String> {
    let parts=semver(value)?;
    Ok(format!("{}.{}.{}",parts[0],parts[1],parts[2]))
}
fn check_newer(remote: &str, local: &str) -> Result<(), String> {
    if semver(remote)? <= semver(local)? { return Err("只允许安装比当前版本更新的正式版本。".into()); }
    Ok(())
}
fn is_sha256(value: &str) -> bool { value.len()==64 && value.bytes().all(|c|c.is_ascii_hexdigit()) }
fn installer_name(version: &str) -> String { format!("FoxEss-WIKI-{version}-x64-Setup.exe") }
fn display_path(path: &Path) -> String {
    let value=path.to_string_lossy();
    if let Some(unc)=value.strip_prefix(r"\\?\UNC\") {format!(r"\\{unc}")}
    else {value.strip_prefix(r"\\?\").unwrap_or(&value).to_string()}
}
fn asset_url(value: &str, tag: &str, name: &str) -> Result<reqwest::Url, String> {
    let url=reqwest::Url::parse(value).map_err(|_|"更新下载地址无效。")?;
    if url.scheme()!="https" || url.host_str()!=Some("github.com") || !url.username().is_empty() || url.password().is_some() || url.port().is_some() || url.query().is_some() || url.fragment().is_some() || url.path()!=format!("/{REPO}/releases/download/{tag}/{name}") {
        return Err("更新资产必须来自 FoxEss WIKI 官方仓库。".into());
    }
    Ok(url)
}
fn redirect_allowed(url: &reqwest::Url) -> bool {
    url.scheme()=="https" && url.port().is_none() && url.username().is_empty() && url.password().is_none() && matches!(url.host_str(),Some("github.com"|"release-assets.githubusercontent.com"|"objects.githubusercontent.com"|"github-releases.githubusercontent.com"))
}
fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder().user_agent(format!("FoxEss-WIKI/{}",env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(20)).timeout(Duration::from_secs(30*60))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len()>=5 || !redirect_allowed(attempt.url()) { attempt.error("Untrusted update redirect") } else { attempt.follow() }
        })).build().map_err(|_|"无法创建安全更新连接。".into())
}
async fn small_download(client: &reqwest::Client, url: &str, limit: usize) -> Result<Vec<u8>,String> {
    let response=client.get(url).timeout(Duration::from_secs(30)).header("Accept","application/vnd.github+json").send().await.map_err(|_|"无法连接 GitHub 更新服务。")?.error_for_status().map_err(|_|"GitHub 更新服务返回错误，请稍后重试。")?;
    let mut stream=response.bytes_stream(); let mut bytes=Vec::new();
    while let Some(chunk)=stream.next().await { let chunk=chunk.map_err(|_|"更新信息下载中断。")?; if bytes.len().saturating_add(chunk.len())>limit { return Err("更新信息超出安全大小限制。".into()); } bytes.extend_from_slice(&chunk); }
    Ok(bytes)
}
fn verify_manifest(bytes: &[u8], encoded_signature: &[u8], key: &str, version: &str) -> Result<UpdateManifest,String> {
    let key: PublicKey=serde_json::from_str(key).map_err(|_|"更新公钥配置无效。")?;
    if key.algorithm!="ed25519" {return Err("更新签名算法无效。".into());}
    let public=base64::engine::general_purpose::STANDARD.decode(key.public_key.trim()).map_err(|_|"更新公钥无效。")?;
    let sig=base64::engine::general_purpose::STANDARD.decode(std::str::from_utf8(encoded_signature).map_err(|_|"更新签名无效。")?.trim()).map_err(|_|"更新签名无效。")?;
    if public.len()!=32 || sig.len()!=64 {return Err("更新签名无效。".into());}
    signature::UnparsedPublicKey::new(&signature::ED25519,public).verify(bytes,&sig).map_err(|_|"更新签名校验失败，已停止安装。")?;
    let manifest: UpdateManifest=serde_json::from_slice(bytes).map_err(|_|"更新清单无效。")?;
    if manifest.schema!=1 || manifest.repo!=REPO || manifest.version!=version || manifest.installer.name!=installer_name(version) || manifest.installer.size==0 || manifest.installer.size>MAX_INSTALLER || !is_sha256(&manifest.installer.sha256) || !is_sha256(&manifest.executable_sha256) {
        return Err("更新清单与目标版本不一致，已停止安装。".into());
    }
    Ok(manifest)
}
fn release_asset<'a>(release: &'a Release, tag: &str, name: &str) -> Result<&'a Asset,String> {
    let assets=release.assets.iter().filter(|asset|asset.name==name).collect::<Vec<_>>();
    if assets.len()!=1 {return Err(format!("此版本缺少唯一的安全更新文件：{name}"));}
    asset_url(&assets[0].browser_download_url,tag,name)?;
    Ok(assets[0])
}
fn install_root(executable: &Path) -> Result<PathBuf,String> {
    let executable=executable.canonicalize().map_err(|_|"无法确定当前程序位置。")?;
    let app=executable.parent().ok_or("当前程序位置无效。")?;
    if !executable.file_name().and_then(|p|p.to_str()).is_some_and(|p|p.eq_ignore_ascii_case("llm-wiki.exe")) || !app.file_name().and_then(|p|p.to_str()).is_some_and(|p|p.eq_ignore_ascii_case("app")) {return Err("请先使用 FoxEss WIKI v1 安装包安装，再使用一键更新。".into());}
    let root=app.parent().ok_or("当前安装位置无效。")?;
    let value: serde_json::Value=serde_json::from_slice(&fs::read(root.join("install-manifest.json")).map_err(|_|"当前为手工部署，请先安装 v1 安装包以启用一键更新。")?).map_err(|_|"安装清单损坏，请使用安装包修复。")?;
    if value["product"]!="FoxEss WIKI" || !value["files"].as_array().is_some_and(|rows|rows.iter().any(|row|row["path"]=="app/llm-wiki.exe")) {return Err("无法验证当前安装目录，已停止更新。".into());}
    Ok(root.to_path_buf())
}
fn write_json(path: &Path, value: &impl Serialize) -> Result<(),String> {
    fs::write(path,serde_json::to_vec_pretty(value).map_err(|_|"更新配置序列化失败。")?).map_err(|_|"无法写入本机更新缓存。".into())
}

#[tauri::command]
pub async fn install_github_update(app: tauri::AppHandle, version: String) -> Result<UpdateReady,String> {
    if !cfg!(target_os="windows") {return Err("当前一键更新仅支持 Windows。".into());}
    let version=clean_version(&version)?;
    check_newer(&version,env!("CARGO_PKG_VERSION"))?;
    {
        let state=app.state::<GithubUpdateState>(); let mut inner=state.0.lock().map_err(|_|"更新状态不可用。")?;
        if inner.preparing {return Err("另一个更新正在下载。".into());}
        inner.preparing=true;
    }
    let result=prepare(&app,&version).await;
    let state=app.state::<GithubUpdateState>(); let mut inner=state.0.lock().map_err(|_|"更新状态不可用。")?;
    inner.preparing=false;
    match result {
        Ok(ready)=>{let response=UpdateReady{status:"ready",version:ready.version.clone(),receipt:ready.receipt.clone()};inner.ready=Some(ready);Ok(response)},
        Err(error)=>Err(error),
    }
}
async fn prepare(app:&tauri::AppHandle,version:&str)->Result<PreparedUpdate,String>{
    let executable=std::env::current_exe().map_err(|_|"无法确定当前程序位置。")?.canonicalize().map_err(|_|"无法读取当前程序位置。")?;
    let root=install_root(&executable)?;
    let root_text=display_path(&root);
    if root_text.starts_with(r"\\") {return Err("请将应用安装在本机磁盘后再使用一键更新。".into());}
    let client=client()?; let tag=format!("v{version}");
    let release:Release=serde_json::from_slice(&small_download(&client,&format!("https://api.github.com/repos/{REPO}/releases/tags/{tag}"),1024*1024).await?).map_err(|_|"GitHub 版本信息无效。")?;
    if release.tag_name!=tag || release.draft || release.prerelease {return Err("只允许安装仓库中已正式发布的稳定版本。".into());}
    let manifest_name=format!("FoxEss-WIKI-{version}-update.json");let signature_name=format!("{manifest_name}.sig");
    let manifest_asset=release_asset(&release,&tag,&manifest_name)?; let signature_asset=release_asset(&release,&tag,&signature_name)?;
    let bytes=small_download(&client,&manifest_asset.browser_download_url,1024*1024).await?;
    let signature=small_download(&client,&signature_asset.browser_download_url,4096).await?;
    let manifest=verify_manifest(&bytes,&signature,PUBLIC_KEY,version)?;
    let installer=release_asset(&release,&tag,&manifest.installer.name)?;
    if installer.size!=manifest.installer.size {return Err("GitHub 安装包大小与签名清单不一致。".into());}
    let cache=app.path().app_cache_dir().map_err(|_|"无法确定更新缓存目录。")?.join("github-updates");
    let receipt=uuid::Uuid::new_v4().to_string();let directory=cache.join(&receipt);
    fs::create_dir_all(&directory).map_err(|_|"无法建立更新缓存目录。")?;
    let target=directory.join(&manifest.installer.name);let partial=directory.join("installer.part");
    let response=client.get(&installer.browser_download_url).send().await.map_err(|_|"安装包下载失败，请稍后重试。")?.error_for_status().map_err(|_|"安装包下载失败，请稍后重试。")?;
    let mut stream=response.bytes_stream(); let mut file=fs::File::create(&partial).map_err(|_|"无法保存下载的安装包。")?;let mut hasher=Sha256::new();let mut count=0u64;
    while let Some(chunk)=stream.next().await{let chunk=chunk.map_err(|_|"安装包下载中断，请重试。")?;count=count.saturating_add(chunk.len() as u64);if count>manifest.installer.size{return Err("下载的安装包超过签名大小，已停止更新。".into());}hasher.update(&chunk);file.write_all(&chunk).map_err(|_|"无法写入安装包，请检查磁盘空间。")?;}
    file.sync_all().map_err(|_|"无法保存完整安装包。")?;drop(file);
    if count!=manifest.installer.size || format!("{:x}",hasher.finalize())!=manifest.installer.sha256.to_lowercase(){return Err("安装包完整性校验失败，已停止更新。".into());}
    fs::rename(&partial,&target).map_err(|_|"无法完成安装包缓存。")?;
    let plan=UpdatePlan{schema:1,version:version.into(),parent_pid:std::process::id(),install_root:root_text,executable:display_path(&executable),installer:display_path(&target),installer_sha256:manifest.installer.sha256,executable_sha256:manifest.executable_sha256,result_file:display_path(&cache.join("last-update-result.json"))};
    let mut helper=vec![0xef,0xbb,0xbf];helper.extend_from_slice(HELPER.as_bytes());
    fs::write(directory.join("Update.ps1"),helper).map_err(|_|"无法准备安全更新程序。")?;
    write_json(&directory.join("plan.json"),&plan)?;
    Ok(PreparedUpdate{receipt,version:version.into(),directory,plan})
}

#[tauri::command]
pub async fn quit_for_update(app:tauri::AppHandle,receipt:String)->Result<(),String>{
    #[cfg(not(target_os="windows"))]
    {let _=(app,receipt);Err("当前一键更新仅支持 Windows。".into())}
    #[cfg(target_os="windows")]
    {
        use std::os::windows::process::CommandExt;
        let ready={let state=app.state::<GithubUpdateState>();let mut inner=state.0.lock().map_err(|_|"更新状态不可用。")?;if inner.preparing || !inner.ready.as_ref().is_some_and(|ready|ready.receipt==receipt){return Err("更新凭据无效，请重新检查并下载。".into());}inner.ready.take().unwrap()};
        let registry=app.state::<crate::agent::cancel::AgentCancellationRegistry>();
        if let Err(error)=registry.begin_update(){app.state::<GithubUpdateState>().0.lock().map_err(|_|"更新状态不可用。")?.ready=Some(ready);return Err(error);}
        let result=async{
            // Recheck the prepared install location before arming a new process.
            if !display_path(&install_root(Path::new(&ready.plan.executable))?).eq_ignore_ascii_case(&ready.plan.install_root){return Err("当前安装位置发生变化，请重新下载更新。".into());}
            let system=std::env::var_os("SystemRoot").ok_or("无法确定 Windows 系统目录。")?;
            let powershell=PathBuf::from(system).join("System32/WindowsPowerShell/v1.0/powershell.exe");
            let mut child=std::process::Command::new(powershell).args(["-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-WindowStyle","Hidden","-File"]).arg(ready.directory.join("Update.ps1")).arg("-Plan").arg(ready.directory.join("plan.json")).creation_flags(0x08000000).spawn().map_err(|_|"无法启动更新程序，应用将继续运行。")?;
            for _ in 0..200 {
                if ready.directory.join("helper.ready").is_file(){fs::write(ready.directory.join("commit.update"),b"committed").map_err(|_|"无法确认更新，应用将继续运行。")?;return Ok(());}
                if child.try_wait().map_err(|_|"无法检查更新程序。")?.is_some(){return Err("更新程序未能准备完成，应用将继续运行。".into());}
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            Err("更新准备超时，应用将继续运行，请稍后重试。".into())
        }.await;
        if let Err(error)=result{
            let _=fs::write(ready.directory.join("cancel.update"),b"cancelled");
            registry.cancel_update();return Err(error);
        }
        app.exit(0);Ok(())
    }
}

#[tauri::command]
pub fn get_github_update_status(app:tauri::AppHandle)->Result<Option<serde_json::Value>,String>{
    let path=app.path().app_cache_dir().map_err(|_|"无法读取更新状态。")?.join("github-updates/last-update-result.json");
    if !path.exists(){return Ok(None);}
    if fs::metadata(&path).map_err(|_|"无法读取更新状态。")?.len()>64*1024{return Err("更新状态文件无效。".into());}
    serde_json::from_slice(&fs::read(path).map_err(|_|"无法读取更新状态。")?).map(Some).map_err(|_|"更新状态文件无效。".into())
}

#[cfg(test)]
mod tests{
    use super::*;
    use ring::signature::KeyPair;
    fn signed_manifest(version:&str)->(Vec<u8>,Vec<u8>,String){
        let key=signature::Ed25519KeyPair::from_seed_unchecked(&[7;32]).unwrap();
        let value=serde_json::json!({"schema":1,"repo":REPO,"version":version,"installer":{"name":installer_name(version),"size":123,"sha256":"a".repeat(64)},"executableSha256":"b".repeat(64)});
        let bytes=serde_json::to_vec(&value).unwrap();let signature=base64::engine::general_purpose::STANDARD.encode(key.sign(&bytes).as_ref()).into_bytes();
        let public=serde_json::json!({"algorithm":"ed25519","publicKey":base64::engine::general_purpose::STANDARD.encode(key.public_key().as_ref())}).to_string();(bytes,signature,public)
    }
    #[test]fn strict_versions_reject_downgrade_prerelease_and_injection(){assert!(check_newer("v1.1.0","1.0.0").is_ok());for remote in ["1.0.0","0.9.9","1.1.0-beta","v1.2.0;calc","01.0.0","1.2","v999999999999999999999.0.0"]{assert!(check_newer(remote,"1.0.0").is_err(),"{remote}");}}
    #[test]fn downloaded_manifest_needs_signature_version_and_canonical_installer(){let(b,s,p)=signed_manifest("1.1.0");assert!(verify_manifest(&b,&s,&p,"1.1.0").is_ok());let mut changed=b.clone();changed.push(b' ');assert!(verify_manifest(&changed,&s,&p,"1.1.0").is_err());assert!(verify_manifest(&b,&s,&p,"1.2.0").is_err());assert!(verify_manifest(&b,b"invalid",&p,"1.1.0").is_err());}
    #[test]fn fixed_repository_asset_urls_reject_other_hosts_paths_and_queries(){let name=installer_name("1.1.0");assert!(asset_url(&format!("https://github.com/{REPO}/releases/download/v1.1.0/{name}"),"v1.1.0",&name).is_ok());for url in [format!("http://github.com/{REPO}/releases/download/v1.1.0/{name}"),format!("https://github.com/attacker/WIKI/releases/download/v1.1.0/{name}"),format!("https://github.com.evil.test/{REPO}/releases/download/v1.1.0/{name}"),format!("https://github.com/{REPO}/releases/download/v1.1.0/{name}?x=1")]{assert!(asset_url(&url,"v1.1.0",&name).is_err());}}
    #[test]fn only_official_https_redirect_hosts_are_followed(){for url in ["https://release-assets.githubusercontent.com/x","https://objects.githubusercontent.com/x"]{assert!(redirect_allowed(&reqwest::Url::parse(url).unwrap()));}for url in ["http://release-assets.githubusercontent.com/x","https://example.com/x","https://github.com@evil.test/x","https://github.com:444/x"]{assert!(!redirect_allowed(&reqwest::Url::parse(url).unwrap()));}}
    #[test]fn manifest_signature_does_not_authorize_unrelated_repository_or_asset(){let key=signature::Ed25519KeyPair::from_seed_unchecked(&[7;32]).unwrap();let(b,_,p)=signed_manifest("1.1.0");let mut value:serde_json::Value=serde_json::from_slice(&b).unwrap();for field in ["repo","installer"]{let original=value[field].clone();value[field]=if field=="repo"{serde_json::json!("other/repo")}else{serde_json::json!({"name":"../evil.exe","sha256":"a".repeat(64),"size":123})};let bytes=serde_json::to_vec(&value).unwrap();let sig=base64::engine::general_purpose::STANDARD.encode(key.sign(&bytes).as_ref());assert!(verify_manifest(&bytes,sig.as_bytes(),&p,"1.1.0").is_err());value[field]=original;}}
}
