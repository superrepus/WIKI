//! History pruning uses positive filesystem evidence; offline/denied paths are retained.
use serde::Serialize;
use std::{fs, io::ErrorKind, path::Path, time::Duration};

#[derive(Serialize)]
pub struct ProjectHistoryProbe { path: String, status: &'static str }

fn confirmed_missing(path: &Path) -> &'static str {
    // Existing reparse points (e.g. an offline mounted share) are not deleted projects.
    if fs::symlink_metadata(path).is_ok() { return "unavailable"; }
    let remote = path.to_string_lossy().starts_with("\\\\") || path.to_string_lossy().starts_with("//");
    let mut child = path;
    while let Some(parent) = child.parent() {
        match fs::read_dir(parent) {
            Ok(entries) => {
                for entry in entries {
                    let Ok(entry) = entry else { return "unavailable"; };
                    if entry.file_name().to_string_lossy().eq_ignore_ascii_case(&child.file_name().unwrap_or_default().to_string_lossy()) {
                        return "unavailable";
                    }
                }
                return "missing";
            }
            Err(error) if error.kind() == ErrorKind::NotFound && !remote => { child = parent; }
            Err(_) => return "unavailable",
        }
    }
    "unavailable"
}
fn status(path: &Path) -> &'static str {
    if !path.is_absolute() { return "unavailable"; }
    match fs::metadata(path) {
        Ok(root) if root.is_dir() => {
            let wiki = path.join("wiki");
            match fs::metadata(&wiki) {
                Ok(meta) => if meta.is_dir() { "available" } else { "missing" },
                Err(error) if error.kind() == ErrorKind::NotFound => confirmed_missing(&wiki),
                Err(_) => "unavailable",
            }
        }
        Ok(_) => "missing",
        Err(error) if error.kind() == ErrorKind::NotFound => confirmed_missing(path),
        Err(_) => "unavailable",
    }
}

#[tauri::command]
pub async fn probe_project_history_paths(paths: Vec<String>) -> Vec<ProjectHistoryProbe> {
    // Probe concurrently: an unavailable share cannot hold up every local project.
    futures::future::join_all(paths.into_iter().take(64).map(|path| async move {
        let target = path.clone();
        let result = tokio::time::timeout(Duration::from_millis(1500), tokio::task::spawn_blocking(move || status(Path::new(&target)))).await;
        let status = match result { Ok(Ok(value)) => value, _ => "unavailable" };
        ProjectHistoryProbe { path, status }
    })).await
}

#[cfg(test)] mod tests {
    use super::*;
    #[test] fn keeps_valid_projects_and_detects_deleted_or_invalid_local_projects() {
        let root = std::env::temp_dir().join(format!("foxess-history-{}", uuid::Uuid::new_v4()));
        let project = root.join("project");
        fs::create_dir_all(project.join("wiki")).unwrap();
        assert_eq!(status(&project), "available");
        fs::remove_dir_all(project.join("wiki")).unwrap();
        assert_eq!(status(&project), "missing");
        fs::remove_dir_all(&project).unwrap();
        assert_eq!(status(&project), "missing");
        assert_eq!(status(&root.join("deleted-parent/project")), "missing");
        fs::remove_dir_all(root).unwrap();
    }
    #[test] fn never_prunes_relative_locations() {
        assert_eq!(status(Path::new("relative/project")), "unavailable");
    }
    #[cfg(unix)] #[test] fn keeps_broken_external_mount_links() {
        let root = std::env::temp_dir().join(format!("foxess-history-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        std::os::unix::fs::symlink(root.join("offline-mount"), root.join("project")).unwrap();
        assert_eq!(status(&root.join("project")), "unavailable");
        fs::remove_dir_all(root).unwrap();
    }
}
