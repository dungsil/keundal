use super::config::Config;
use super::filesystem::{hash, valid_hash, validate_path, Node};
use super::platform::{Dir, OpenOptions};
use super::{invalid, Key, CHUNK, MAX_ENTRIES, MAX_FILE, MAX_TOTAL};
use base64::{engine::general_purpose::STANDARD, Engine};
#[cfg(unix)]
use cap_std::fs::OpenOptionsExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::io::{self, BufRead, Read, Write};

#[derive(Serialize, Deserialize)]
#[serde(tag = "type", deny_unknown_fields)]
pub enum Frame {
    #[serde(rename = "entry")]
    Entry {
        root: u32,
        path: String,
        kind: String,
        mode: u32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        target: Option<String>,
        #[serde(default, rename = "baseHash")]
        base_hash: Option<serde_json::Value>,
    },
    #[serde(rename = "chunk")]
    Chunk { data: String },
    #[serde(rename = "file-end")]
    FileEnd { hash: String },
    #[serde(rename = "delete")]
    Delete {
        root: u32,
        path: String,
        #[serde(default, rename = "baseHash")]
        base_hash: Option<serde_json::Value>,
    },
    #[serde(rename = "snapshot-end")]
    SnapshotEnd,
}

pub struct Guest {
    pub node: Option<Node>,
    pub staged: Option<String>,
}

pub fn emit(output: &mut impl Write, frame: &Frame) -> io::Result<()> {
    serde_json::to_writer(&mut *output, frame)?;
    output.write_all(b"\n")
}

fn next(input: &mut impl BufRead, frames: &mut usize) -> io::Result<Option<Frame>> {
    let mut line = Vec::new();
    // read_until alone would allocate arbitrary guest-controlled amounts of memory.
    let size = input.take(96 * 1024 + 1).read_until(b'\n', &mut line)?;
    if size == 0 {
        return Ok(None);
    }
    *frames += 1;
    if *frames > 1_000_000 || size > 96 * 1024 || line.last() != Some(&b'\n') {
        return Err(invalid());
    }
    serde_json::from_slice(&line)
        .map(Some)
        .map_err(|_| invalid())
}

pub fn receive(config: &Config, staging: &Dir) -> io::Result<BTreeMap<Key, Guest>> {
    let mut input = io::stdin().lock();
    let mut result: BTreeMap<Key, Guest> = BTreeMap::new();
    let mut total = 0u64;
    let mut frames = 0;
    loop {
        let frame = next(&mut input, &mut frames)?.ok_or_else(invalid)?;
        let (root, path, kind, mode, target) = match frame {
            Frame::SnapshotEnd => {
                if next(&mut input, &mut frames)?.is_some() {
                    return Err(invalid());
                }
                return Ok(result);
            }
            Frame::Entry {
                root,
                path,
                kind,
                mode,
                target,
                ..
            } => (root, path, Some(kind), mode, target),
            Frame::Delete { root, path, .. } => (root, path, None, 0, None),
            _ => return Err(invalid()),
        };
        if !config.root(root)?.writable || mode > 0o777 || result.len() >= MAX_ENTRIES {
            return Err(invalid());
        }
        validate_path(&path)?;
        let key = (root, path);
        if result.contains_key(&key) {
            return Err(invalid());
        }
        let mut value = Guest {
            node: None,
            staged: None,
        };
        if let Some(kind) = kind {
            let mut node = Node {
                kind,
                hash: None,
                mode,
                target,
                identity: None,
            };
            match node.kind.as_str() {
                "directory" if node.target.is_none() => {}
                "symlink" => {
                    let target = node.target.as_ref().ok_or_else(invalid)?;
                    if target.is_empty() || target.len() > 4096 || target.contains('\0') {
                        return Err(invalid());
                    }
                    node.hash = Some(hash(format!("symlink:{target}").as_bytes()));
                }
                "file" if node.target.is_none() => {
                    let name = result.len().to_string();
                    let mut opts = OpenOptions::new();
                    opts.write(true).create_new(true).mode(0o600);
                    let mut file = staging.open_with(&name, &opts)?;
                    let mut digest = Sha256::new();
                    let mut size = 0u64;
                    loop {
                        match next(&mut input, &mut frames)?.ok_or_else(invalid)? {
                            Frame::Chunk { data } => {
                                if data.len() > CHUNK.div_ceil(3) * 4 {
                                    return Err(invalid());
                                }
                                let bytes = STANDARD.decode(data).map_err(|_| invalid())?;
                                if bytes.is_empty() || bytes.len() > CHUNK {
                                    return Err(invalid());
                                }
                                size += bytes.len() as u64;
                                total += bytes.len() as u64;
                                if size > MAX_FILE || total > MAX_TOTAL {
                                    return Err(invalid());
                                }
                                digest.update(&bytes);
                                file.write_all(&bytes)?;
                            }
                            Frame::FileEnd { hash } => {
                                let actual = format!("{:x}", digest.finalize());
                                if !valid_hash(&hash) || hash != actual {
                                    return Err(invalid());
                                }
                                node.hash = Some(hash);
                                break;
                            }
                            _ => return Err(invalid()),
                        }
                    }
                    value.staged = Some(name);
                }
                _ => return Err(invalid()),
            }
            value.node = Some(node);
        }
        result.insert(key, value);
    }
}
