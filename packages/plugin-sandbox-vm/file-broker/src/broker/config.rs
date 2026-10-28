use super::filesystem::{absolute_dir, open_file, valid_hash, validate_path, Node};
use super::platform::{self, Dir, OpenOptions};
use super::{invalid, Key, MAX_ENTRIES};
#[cfg(unix)]
use cap_std::fs::OpenOptionsExt;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::ffi::OsStr;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Input {
    roots: Vec<RootInput>,
    baseline: PathBuf,
    next_baseline: PathBuf,
    staging: PathBuf,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RootInput {
    id: u32,
    path: PathBuf,
    writable: bool,
    #[serde(default, rename = "target")]
    _target: Option<String>, // VM destination is supervisor metadata, never a host path.
}

pub struct Root {
    pub id: u32,
    pub dir: Dir,
    pub writable: bool,
}
pub struct Config {
    pub roots: Vec<Root>,
    pub staging: PathBuf,
    baseline: (Dir, String),
    next: (Dir, String),
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Baseline {
    pub version: u32,
    pub entries: Vec<Record>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Record {
    pub root: u32,
    pub path: String,
    pub kind: String,
    pub hash: Option<String>,
}
impl Record {
    pub fn new((root, path): Key, node: &Node) -> Self {
        Self {
            root,
            path,
            kind: node.kind.clone(),
            hash: node.hash.clone(),
        }
    }
}

// Missing output files are permitted; their parents must already exist and be private.
fn operator_file(path: &Path) -> io::Result<(PathBuf, Dir, String)> {
    if !path.is_absolute() {
        return Err(invalid());
    }
    let name = path
        .file_name()
        .and_then(OsStr::to_str)
        .ok_or_else(invalid)?
        .to_owned();
    validate_path(&name)?;
    let parent = path.parent().ok_or_else(invalid)?.canonicalize()?;
    let dir = absolute_dir(&parent)?;
    platform::private(&dir)?;
    match dir.symlink_metadata(&name) {
        Ok(metadata) => super::filesystem::regular(&metadata)?,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    Ok((parent.join(&name), dir, name))
}

fn bounded_json<T: serde::de::DeserializeOwned>(file: impl Read, limit: u64) -> io::Result<T> {
    let mut bytes = Vec::new();
    file.take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(invalid());
    }
    serde_json::from_slice(&bytes).map_err(|_| invalid())
}

impl Config {
    pub fn load(path: &OsStr) -> io::Result<Self> {
        let (config_path, config_dir, config_name) = operator_file(Path::new(path))?;
        let input: Input = bounded_json(open_file(&config_dir, &config_name)?, 1024 * 1024)?;
        if input.roots.is_empty() || input.roots.len() > 128 {
            return Err(invalid());
        }
        let (base_path, base_dir, base_name) = operator_file(&input.baseline)?;
        let (next_path, next_dir, next_name) = operator_file(&input.next_baseline)?;
        let staging = input.staging.canonicalize()?;
        if !input.staging.is_absolute() || staging != input.staging {
            return Err(invalid());
        }
        let staging_dir = absolute_dir(&staging)?;
        platform::private(&staging_dir)?;
        let private = [&config_path, &base_path, &next_path, &staging];
        if private
            .iter()
            .enumerate()
            .any(|(i, a)| private.iter().skip(i + 1).any(|b| a == b))
        {
            return Err(invalid());
        }
        let mut roots = Vec::new();
        let mut paths = Vec::new();
        let mut ids = HashSet::new();
        for root in input.roots {
            let canonical = root.path.canonicalize()?;
            if !root.path.is_absolute()
                || canonical != root.path
                || !ids.insert(root.id)
                || private.iter().any(|p| p.starts_with(&canonical))
                || paths
                    .iter()
                    .any(|p: &PathBuf| p.starts_with(&canonical) || canonical.starts_with(p))
            {
                return Err(invalid());
            }
            let dir = absolute_dir(&canonical)?;
            paths.push(canonical);
            roots.push(Root {
                id: root.id,
                dir,
                writable: root.writable,
            });
        }
        Ok(Self {
            roots,
            staging,
            baseline: (base_dir, base_name),
            next: (next_dir, next_name),
        })
    }

    pub fn root(&self, id: u32) -> io::Result<&Root> {
        self.roots.iter().find(|r| r.id == id).ok_or_else(invalid)
    }

    pub fn baseline(&self) -> io::Result<BTreeMap<Key, Node>> {
        let file = match open_file(&self.baseline.0, &self.baseline.1) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(BTreeMap::new()),
            Err(error) => return Err(error),
        };
        let baseline: Baseline = bounded_json(file, 64 * 1024 * 1024)?;
        if baseline.version != 1 || baseline.entries.len() > MAX_ENTRIES {
            return Err(invalid());
        }
        let mut result = BTreeMap::new();
        for record in baseline.entries {
            self.root(record.root)?;
            validate_path(&record.path)?;
            let hash_ok = match record.kind.as_str() {
                "directory" => record.hash.is_none(),
                "file" | "symlink" => record.hash.as_ref().is_some_and(|h| valid_hash(h)),
                _ => false,
            };
            if !hash_ok {
                return Err(invalid());
            }
            let node = Node {
                kind: record.kind,
                hash: record.hash,
                mode: 0,
                target: None,
                identity: None,
            };
            if result.insert((record.root, record.path), node).is_some() {
                return Err(invalid());
            }
        }
        Ok(result)
    }

    pub fn write_baseline(&self, baseline: Baseline) -> io::Result<()> {
        let (dir, name) = &self.next;
        let temp = format!(".keundal-import-baseline-{}", std::process::id());
        let mut options = OpenOptions::new();
        options.write(true).create_new(true).mode(0o600);
        let mut file = dir.open_with(&temp, &options)?;
        let result = (|| {
            let mut output = io::BufWriter::new(&mut file);
            write!(output, "{{\"version\":{},\"entries\":[", baseline.version)?;
            let mut size = 64usize;
            for (index, record) in baseline.entries.iter().enumerate() {
                // Serialize one bounded record at a time and bound the complete baseline too.
                let bytes = serde_json::to_vec(record)?;
                size += bytes.len() + 1;
                if size > 64 * 1024 * 1024 {
                    return Err(invalid());
                }
                if index != 0 {
                    output.write_all(b",")?;
                }
                output.write_all(&bytes)?;
            }
            output.write_all(b"]}\n")?;
            output.flush()?;
            drop(output);
            file.sync_all()?;
            drop(file); // Windows temp handle deliberately denies FILE_SHARE_DELETE.
            dir.rename(&temp, dir, name)
        })();
        if result.is_err() {
            let _ = dir.remove_file(&temp);
        }
        result
    }
}
