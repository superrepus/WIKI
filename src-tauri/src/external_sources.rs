//! Registered original documents are read through stable project-local identities.
//! The registry never grants write access to the original path.
use std::{collections::BTreeMap, fs, path::{Path, PathBuf}};
use serde::Deserialize;
use crate::types::wiki::FileNode;

#[derive(Clone, Deserialize)]
pub struct ExternalSource { pub path: String }
#[derive(Default, Deserialize)]
struct Registry { version: u32, #[serde(default)] sources: BTreeMap<String, ExternalSource> }
fn normalized(path: &Path) -> String {
 let raw=path.to_string_lossy();
 let value=if let Some(rest)=raw.strip_prefix("\\\\?\\UNC\\"){format!("//{rest}")}else{raw.strip_prefix("\\\\?\\").unwrap_or(&raw).to_string()};
 value.replace('\\',"/").trim_end_matches('/').to_string()
}
fn equal(a: &str,b: &str)->bool { if cfg!(windows) { a.eq_ignore_ascii_case(b) } else { a==b } }
fn inside(path:&str,root:&str)->bool { equal(path,root) || path.get(..root.len()).map(|p|equal(p,root)).unwrap_or(false) && path.as_bytes().get(root.len())==Some(&b'/') }
fn valid_key(key:&str)->bool { key.starts_with("raw/sources/") && !key.contains('\\') && key.split('/').all(|p|!p.is_empty() && p!="." && p!="..") && !key.contains(':') }
fn absolute(path:&str)->bool { let n=path.replace('\\',"/");!n.contains('\0') && !n.starts_with("//?/") && !n.starts_with("//./") && !n.split('/').any(|p|p=="."||p=="..") && (Path::new(path).is_absolute() || n.starts_with("//") || n.as_bytes().get(1)==Some(&b':') && n.as_bytes().get(2)==Some(&b'/')) }
pub fn entries(project:&Path)->Result<BTreeMap<String,ExternalSource>,String>{
    let file=project.join(".llm-wiki/external-sources.json");
    let raw=match fs::read_to_string(file){Ok(v)=>v,Err(e) if e.kind()==std::io::ErrorKind::NotFound=>return Ok(BTreeMap::new()),Err(e)=>return Err(format!("Cannot read external source registry: {e}"))};
    let registry:Registry=serde_json::from_str(&raw).map_err(|e|format!("Invalid external source registry: {e}"))?;
    if registry.version!=1{return Err("Unsupported external source registry version".into());}
    for (key,value) in &registry.sources { if !valid_key(key)||!absolute(&value.path){return Err("Invalid registered external source path".into());} }
    Ok(registry.sources)
}
fn project_for(path:&Path)->Option<PathBuf>{
    if path.join(".llm-wiki/external-sources.json").is_file(){return Some(path.to_path_buf());}
    // Never walk a remote source directory searching for application state.
    // Virtual paths always have a local project/raw/sources prefix.
    let text=normalized(path);let lower=text.to_ascii_lowercase();
    if let Some(index)=lower.rfind("/raw/sources"){return Some(PathBuf::from(&text[..index]));}
    for ancestor in path.ancestors().take(4){if ancestor.join(".llm-wiki/external-sources.json").is_file(){return Some(ancestor.to_path_buf());}}
    None
}
pub fn project_for_logical(path:&Path)->Option<PathBuf>{project_for(path)}
fn registered_path(path:&Path)->Result<Option<PathBuf>,String>{
    let Some(project)=project_for(path) else{return Ok(None);};
    let root=normalized(&project);let full=normalized(path);
    if !inside(&full,&root){return Ok(None);}
    let Some(rel)=full.get(root.len()+1..) else{return Ok(None);};
    for (key,entry) in entries(&project)? {if equal(&key,rel){return Ok(Some(PathBuf::from(entry.path)));}}
    Ok(None)
}
pub fn resolve_read(path:&Path)->Result<PathBuf,String>{Ok(registered_path(path)?.unwrap_or_else(||path.to_path_buf()))}
pub fn is_registered(path:&Path)->Result<bool,String>{Ok(registered_path(path)?.is_some())}
pub fn ensure_writable(path:&Path)->Result<(),String>{if is_registered(path)?{Err("Registered source originals are read-only; detach the source instead".into())}else{Ok(())}}
/// A missing share/drive is unavailable, not evidence that every file was deleted.
pub fn probe_path(path:&Path)->&'static str{
 match fs::metadata(path){Ok(_)=>"present",Err(e) if e.kind()==std::io::ErrorKind::NotFound=>{
  let text=normalized(path);
  let root=if text.starts_with("//"){let parts:Vec<_>=text.trim_start_matches('/').split('/').collect();if parts.len()<2{return "unavailable";}PathBuf::from(format!("//{}/{}",parts[0],parts[1]))}
   else if text.as_bytes().get(1)==Some(&b':'){PathBuf::from(format!("{}/",&text[..2]))}
   else{PathBuf::from("/")};
  if fs::metadata(root).map(|m|m.is_dir()).unwrap_or(false){"missing"}else{"unavailable"}
 },Err(_)=>"unavailable"}
}
pub fn virtual_directory(path:&Path)->Result<bool,String>{
    let Some(project)=project_for(path) else{return Ok(false);};let full=normalized(path);
    Ok(entries(&project)?.keys().any(|key|{let file=normalized(&project.join(key));inside(&file,&full)&&!equal(&file,&full)}))
}
pub fn merge_tree(path:&Path,mut nodes:Vec<FileNode>,max_depth:usize,include_hidden:bool)->Result<Vec<FileNode>,String>{
    let Some(project)=project_for(path) else{return Ok(nodes);};let root=normalized(path);
    for (key,_) in entries(&project)?{let full=normalized(&project.join(&key));if !inside(&full,&root)||equal(&full,&root){continue;}let relative=&full[root.len()+1..];let parts:Vec<_>=relative.split('/').collect();if !include_hidden&&parts.iter().any(|p|p.starts_with('.')){continue;} insert(&mut nodes,&root,&parts,max_depth);}
    sort(&mut nodes);Ok(nodes)
}
fn insert(nodes:&mut Vec<FileNode>,root:&str,parts:&[&str],depth:usize){if depth==0||parts.is_empty(){return;}let dir=parts.len()>1;let name=parts[0];let index=if let Some(i)=nodes.iter().position(|n|equal(&n.name,name)){i}else{nodes.push(FileNode{name:name.into(),path:format!("{root}/{name}"),is_dir:dir,children:None});nodes.len()-1};if dir{nodes[index].is_dir=true;let path=nodes[index].path.clone();let children=nodes[index].children.get_or_insert_with(Vec::new);insert(children,&path,&parts[1..],depth-1);}}
fn sort(nodes:&mut Vec<FileNode>){nodes.sort_by(|a,b|b.is_dir.cmp(&a.is_dir).then_with(||a.name.cmp(&b.name)));for n in nodes{if let Some(children)=&mut n.children{sort(children)}}}

#[cfg(test)]mod tests{
 use super::*;
 #[test]fn registered_sources_are_virtual_read_only_and_scoped(){let dir=std::env::temp_dir().join(format!("wiki-external-{}",uuid::Uuid::new_v4()));let project=dir.join("project");fs::create_dir_all(project.join(".llm-wiki")).unwrap();let original=dir.join("original.txt");fs::write(&original,"source text").unwrap();fs::write(project.join(".llm-wiki/external-sources.json"),serde_json::json!({"version":1,"sources":{"raw/sources/external/original.txt":{"path":original}}}).to_string()).unwrap();let logical=project.join("raw/sources/external/original.txt");assert_eq!(resolve_read(&logical).unwrap(),original);assert!(ensure_writable(&logical).is_err());assert!(!logical.exists());assert!(virtual_directory(&project.join("raw/sources")).unwrap());let tree=merge_tree(&project,vec![],30,false).unwrap();assert_eq!(tree[0].children.as_ref().unwrap()[0].name,"sources");assert_eq!(resolve_read(&project.join("raw/sources/unknown.txt")).unwrap(),project.join("raw/sources/unknown.txt"));fs::remove_dir_all(dir).unwrap();}
 #[test]fn registry_rejects_traversal_and_relative_originals(){assert!(!valid_key("raw/sources/../../secret.txt"));assert!(!valid_key("raw/sources/C:/secret"));assert!(valid_key("raw/sources/.notes/note.txt"));assert!(!absolute("../secret"));}
}

#[cfg(test)]mod command_tests{
 use super::*;
 #[tokio::test]async fn external_sources_read_hash_list_and_protect_originals(){
  let dir=std::env::temp_dir().join(format!("wiki-external-io-{}",uuid::Uuid::new_v4()));let project=dir.join("project");fs::create_dir_all(project.join(".llm-wiki")).unwrap();let original=dir.join("original.txt");fs::write(&original,"external source text").unwrap();let logical=project.join("raw/sources/folder/original.txt");
  fs::write(project.join(".llm-wiki/external-sources.json"),serde_json::json!({"version":1,"sources":{"raw/sources/folder/original.txt":{"path":original}}}).to_string()).unwrap();
  let name=logical.to_string_lossy().to_string();
  assert_eq!(crate::commands::fs::read_file(name.clone(),None).await.unwrap(),"external source text");
  assert!(crate::commands::fs::file_exists(name.clone()).await.unwrap());
  assert_eq!(crate::commands::fs::get_file_size(name.clone()).await.unwrap(),20);
  assert_eq!(crate::commands::fs::get_file_md5(name.clone()).await.unwrap().len(),32);
  assert!(crate::commands::fs::write_file(name.clone(),"must not write".into()).await.is_err());
  assert!(crate::commands::fs::delete_file(name.clone()).await.is_err());
  assert_eq!(fs::read_to_string(&original).unwrap(),"external source text");
  let nodes=crate::commands::fs::list_directory(project.join("raw/sources").to_string_lossy().to_string(),None,None).await.unwrap();assert_eq!(nodes[0].name,"folder");
  assert!(!logical.exists());assert!(matches!(probe_path(&original),"present"));fs::remove_file(&original).unwrap();assert_eq!(probe_path(&original),"missing");
  let org=dir.join("notes.org");fs::write(&org,"* External heading\nSource body").unwrap();
  fs::write(project.join(".llm-wiki/external-sources.json"),serde_json::json!({"version":1,"sources":{"raw/sources/folder/notes.org":{"path":org}}}).to_string()).unwrap();
  let org_logical=project.join("raw/sources/folder/notes.org");
  let text=crate::commands::fs::preprocess_file(org_logical.to_string_lossy().to_string()).await.unwrap();assert!(text.contains("External heading"));
  assert!(project.join("raw/sources/folder/.cache/notes.org.txt").exists());assert!(!dir.join(".cache").exists());assert!(!org_logical.exists());
  fs::remove_dir_all(dir).unwrap();
 }
 #[tokio::test]async fn external_sources_archive_only_local_mirror(){
  let dir=std::env::temp_dir().join(format!("wiki-external-archive-{}",uuid::Uuid::new_v4()));let project=dir.join("project");fs::create_dir_all(project.join("raw/sources")).unwrap();let original=dir.join("original.txt");fs::write(&original,"original").unwrap();let local=project.join("raw/sources/original.txt");fs::write(&local,"old local mirror").unwrap();
  assert!(crate::commands::fs::archive_legacy_source(project.to_string_lossy().to_string(),original.to_string_lossy().to_string()).await.is_err());
  assert!(crate::commands::fs::archive_legacy_source(project.to_string_lossy().to_string(),local.to_string_lossy().to_string()).await.unwrap());
  assert!(!local.exists());assert_eq!(fs::read_to_string(original).unwrap(),"original");assert!(project.join(".llm-wiki/legacy-sources").exists());fs::remove_dir_all(dir).unwrap();
 }
}
