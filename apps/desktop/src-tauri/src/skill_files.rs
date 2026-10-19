// Pure filesystem operations: this module can also be tested with rustc --test,
// without Tauri, a window, or a running application.
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};

pub struct SkillFile {
    pub root: PathBuf,
    pub path: PathBuf,
    pub markdown: String,
}

fn file_error(path: &Path, error: impl std::fmt::Display) -> String {
    format!("Skill file access failed at '{}': {error}", path.display())
}

pub fn path_string(path: &Path) -> Result<String, String> {
    path.to_str()
        .map(str::to_owned)
        .ok_or_else(|| file_error(path, "path is not valid UTF-8"))
}

pub fn resolve_roots(candidates: &[PathBuf]) -> Result<Vec<PathBuf>, String> {
    let mut roots = Vec::new();
    for candidate in candidates {
        let root = match fs::canonicalize(candidate) {
            Ok(root) => root,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(file_error(candidate, error)),
        };
        if !fs::metadata(&root)
            .map_err(|error| file_error(&root, error))?
            .is_dir()
        {
            return Err(file_error(&root, "skill root is not a directory"));
        }
        if !roots.contains(&root) {
            roots.push(root);
        }
    }
    Ok(roots)
}

pub fn list(roots: &[PathBuf]) -> Result<Vec<SkillFile>, String> {
    let mut files = Vec::new();
    for root in roots {
        let mut entries = fs::read_dir(root)
            .map_err(|error| file_error(root, error))?
            .map(|entry| entry.map_err(|error| file_error(root, error)))
            .collect::<Result<Vec<_>, _>>()?;
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let directory = entry.path();
            // file_type does not follow symlinks.
            if !entry
                .file_type()
                .map_err(|error| file_error(&directory, error))?
                .is_dir()
            {
                continue;
            }
            let path = directory.join("SKILL.md");
            let metadata = match fs::symlink_metadata(&path) {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
                Err(error) => return Err(file_error(&path, error)),
            };
            if !metadata.file_type().is_file() {
                continue;
            }
            let markdown = read(roots, &path)?;
            files.push(SkillFile {
                root: root.clone(),
                path,
                markdown,
            });
        }
    }
    Ok(files)
}

pub fn read(roots: &[PathBuf], path: &Path) -> Result<String, String> {
    let rejected = || {
        file_error(
            path,
            "expected an immediate <root>/<directory>/SKILL.md without symlinks",
        )
    };
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir | Component::CurDir))
    {
        return Err(rejected());
    }
    let root = roots
        .iter()
        .find(|root| {
            let Ok(relative) = path.strip_prefix(root) else {
                return false;
            };
            let parts: Vec<_> = relative.components().collect();
            matches!(parts.as_slice(), [Component::Normal(_), Component::Normal(name)] if *name == "SKILL.md")
        })
        .ok_or_else(rejected)?;
    let directory = path.parent().ok_or_else(rejected)?;
    for (target, is_directory) in [(directory, true), (path, false)] {
        let metadata = fs::symlink_metadata(target).map_err(|error| file_error(target, error))?;
        let kind = metadata.file_type();
        if kind.is_symlink()
            || (is_directory && !kind.is_dir())
            || (!is_directory && !kind.is_file())
        {
            return Err(rejected());
        }
    }
    let canonical = fs::canonicalize(path).map_err(|error| file_error(path, error))?;
    if canonical != path || !canonical.starts_with(root) {
        return Err(rejected());
    }
    fs::read_to_string(path).map_err(|error| file_error(path, error))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT: AtomicU64 = AtomicU64::new(0);

    struct Temp(PathBuf);

    impl Temp {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "keundal-skills-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(fs::canonicalize(path).unwrap())
        }

        fn write(&self, path: &str, content: &[u8]) -> PathBuf {
            let path = self.0.join(path);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, content).unwrap();
            path
        }
    }

    impl Drop for Temp {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[test]
    fn 없는_루트는_건너뛰고_정규화한_루트는_순서대로_중복을_제거한다() {
        let temp = Temp::new();
        let project = temp.0.join("project");
        let home = temp.0.join("home");
        fs::create_dir(&project).unwrap();
        fs::create_dir(&home).unwrap();
        let roots = resolve_roots(&[
            temp.0.join("missing"),
            project.clone(),
            project.join("."),
            home.clone(),
        ])
        .unwrap();
        assert_eq!(roots, vec![project, home]);
        assert!(resolve_roots(&[temp.0.join("missing")]).unwrap().is_empty());
        assert!(list(&[]).unwrap().is_empty());
    }

    #[test]
    fn 직접_하위의_skill만_루트_순서와_이름_순서로_읽고_원문을_보존한다() {
        let temp = Temp::new();
        let z = temp.write("project/z/SKILL.md", b"---\nname: z\n---\n# Z\n");
        let a = temp.write("project/a/SKILL.md", b"# A");
        temp.write("project/SKILL.md", b"ignored");
        temp.write("project/a/nested/SKILL.md", b"ignored");
        temp.write("project/other/README.md", b"ignored");
        let home = temp.write("home/b/SKILL.md", b"# Home");
        let roots = resolve_roots(&[temp.0.join("project"), temp.0.join("home")]).unwrap();
        let files = list(&roots).unwrap();
        assert_eq!(
            files.iter().map(|file| &file.path).collect::<Vec<_>>(),
            vec![&a, &z, &home]
        );
        assert_eq!(files[0].root, roots[0]);
        assert_eq!(files[2].root, roots[1]);
        assert_eq!(files[1].markdown, "---\nname: z\n---\n# Z\n");
        assert_eq!(read(&roots, &a).unwrap(), "# A");
    }

    #[test]
    fn 루트_밖과_중첩_경로와_다른_파일과_상대_경로를_거부한다() {
        let temp = Temp::new();
        temp.write("root/a/SKILL.md", b"valid");
        let roots = resolve_roots(&[temp.0.join("root")]).unwrap();
        for name in [
            "outside/a/SKILL.md",
            "root/SKILL.md",
            "root/a/nested/SKILL.md",
            "root/a/README.md",
            "root/a/../a/SKILL.md",
        ] {
            let path = temp.write(name, b"not allowed");
            assert!(read(&roots, &path)
                .unwrap_err()
                .contains(&path.display().to_string()));
        }
        assert!(read(&roots, Path::new("a/SKILL.md")).is_err());
        assert!(read(&roots, &temp.0.join("root/missing/SKILL.md")).is_err());
    }

    #[test]
    fn 파일_읽기_오류와_잘못된_루트는_경로와_함께_반환한다() {
        let temp = Temp::new();
        let invalid = temp.write("root/a/SKILL.md", &[0xff]);
        let roots = resolve_roots(&[temp.0.join("root")]).unwrap();
        assert!(read(&roots, &invalid)
            .unwrap_err()
            .contains(&invalid.display().to_string()));
        assert!(list(&roots)
            .err()
            .unwrap()
            .contains(&invalid.display().to_string()));
        let file = temp.write("not-a-directory", b"");
        assert!(resolve_roots(&[file.clone()])
            .unwrap_err()
            .contains(&file.display().to_string()));
    }

    #[cfg(unix)]
    #[test]
    fn 심볼릭_링크_디렉터리와_파일을_건너뛰고_읽기도_거부한다() {
        use std::os::unix::fs::symlink;
        let temp = Temp::new();
        let outside = temp.write("outside/SKILL.md", b"secret");
        let valid = temp.write("root/valid/SKILL.md", b"valid");
        fs::create_dir(temp.0.join("root/linked-file")).unwrap();
        symlink(temp.0.join("outside"), temp.0.join("root/linked-directory")).unwrap();
        symlink(&outside, temp.0.join("root/linked-file/SKILL.md")).unwrap();
        symlink(&valid, temp.0.join("root/valid-link")).unwrap();
        symlink(temp.0.join("root"), temp.0.join("root-alias")).unwrap();
        let roots = resolve_roots(&[temp.0.join("root"), temp.0.join("root-alias")]).unwrap();
        assert_eq!(roots.len(), 1);
        assert_eq!(list(&roots).unwrap().len(), 1);
        for name in [
            "root/linked-directory/SKILL.md",
            "root/linked-file/SKILL.md",
            "root/valid-link",
            "root-alias/valid/SKILL.md",
        ] {
            assert!(read(&roots, &temp.0.join(name)).is_err());
        }
    }
}
