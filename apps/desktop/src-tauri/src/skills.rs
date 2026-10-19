#[path = "skill_files.rs"]
mod files;

use serde::Serialize;
use std::path::PathBuf;

#[derive(Serialize)]
pub struct SkillFile {
    root: String,
    path: String,
    markdown: String,
}

#[derive(Serialize)]
pub struct SkillFiles {
    roots: Vec<String>,
    files: Vec<SkillFile>,
}

fn skill_roots() -> Result<Vec<PathBuf>, String> {
    let cwd = std::env::current_dir()
        .map_err(|error| format!("Could not resolve process current directory: {error}"))?;
    let home = dirs::home_dir().ok_or("Could not resolve OS home directory")?;
    files::resolve_roots(&[cwd.join(".agents/skills"), home.join(".agents/skills")])
}

#[tauri::command]
pub async fn list_skill_files() -> Result<SkillFiles, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let roots = skill_roots()?;
        let discovered = files::list(&roots)?;
        Ok(SkillFiles {
            roots: roots
                .iter()
                .map(|root| files::path_string(root))
                .collect::<Result<_, _>>()?,
            files: discovered
                .into_iter()
                .map(|file| {
                    Ok(SkillFile {
                        root: files::path_string(&file.root)?,
                        path: files::path_string(&file.path)?,
                        markdown: file.markdown,
                    })
                })
                .collect::<Result<_, String>>()?,
        })
    })
    .await
    .map_err(|error| format!("Could not list skill files: {error}"))?
}

#[tauri::command]
pub async fn read_skill_file(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || files::read(&skill_roots()?, &PathBuf::from(path)))
        .await
        .map_err(|error| format!("Could not read skill file: {error}"))?
}
