mod config;
mod filesystem;
mod platform;
mod protocol;
#[cfg(windows)]
mod windows;

#[cfg(unix)]
use cap_std::fs::{DirBuilderExt, OpenOptionsExt};
use config::{Baseline, Config, Record};
use filesystem::{current, parent, scan, Node};
use platform::{Dir, DirBuilder, OpenOptions};
use protocol::{receive, Frame, Guest};
use std::collections::{BTreeMap, HashSet};
use std::io::{self, Write};

pub(super) fn invalid() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "invalid or unsafe input")
}

pub(super) const MAX_ENTRIES: usize = 100_000;
pub(super) const MAX_FILE: u64 = 256 * 1024 * 1024;
pub(super) const MAX_TOTAL: u64 = 1024 * 1024 * 1024;
pub(super) const CHUNK: usize = 64 * 1024;
type Key = (u32, String);

pub fn run() -> io::Result<()> {
    let args: Vec<_> = std::env::args_os().collect();
    if args.len() != 3 {
        return Err(invalid());
    }
    let config = Config::load(&args[2])?;
    let baseline = config.baseline()?;
    match args[1].to_str() {
        Some("snapshot") => snapshot(&config, &baseline),
        Some("apply") => apply(&config, &baseline),
        _ => Err(invalid()),
    }
}

fn snapshot(config: &Config, baseline: &BTreeMap<Key, Node>) -> io::Result<()> {
    let mut out = io::BufWriter::new(io::stdout().lock());
    let mut records = Vec::new();
    let mut total = 0;
    for root in &config.roots {
        scan(&root.dir, "", &mut |path, node, file| {
            if records.len() >= MAX_ENTRIES {
                return Err(invalid());
            }
            let key = (root.id, path.to_owned());
            let base_hash = baseline.get(&key).and_then(|n| n.hash.clone());
            protocol::emit(
                &mut out,
                &Frame::Entry {
                    root: root.id,
                    path: path.to_owned(),
                    kind: node.kind.clone(),
                    mode: node.mode,
                    target: node.target.clone(),
                    base_hash: Some(serde_json::to_value(base_hash)?),
                },
            )?;
            let mut node = node;
            if let Some(file) = file {
                let hash = filesystem::read_file(file, &mut total, |bytes| {
                    use base64::Engine;
                    protocol::emit(
                        &mut out,
                        &Frame::Chunk {
                            data: base64::engine::general_purpose::STANDARD.encode(bytes),
                        },
                    )
                })?;
                protocol::emit(&mut out, &Frame::FileEnd { hash: hash.clone() })?;
                node.hash = Some(hash);
            }
            records.push(Record::new(key, &node));
            Ok(())
        })?;
    }
    let present: HashSet<_> = records.iter().map(|r| (r.root, r.path.clone())).collect();
    for (key, node) in baseline {
        if !present.contains(key) {
            protocol::emit(
                &mut out,
                &Frame::Delete {
                    root: key.0,
                    path: key.1.clone(),
                    base_hash: Some(serde_json::to_value(&node.hash)?),
                },
            )?;
        }
    }
    config.write_baseline(Baseline {
        version: 1,
        entries: records,
    })?;
    protocol::emit(&mut out, &Frame::SnapshotEnd)?;
    out.flush()
}

fn apply(config: &Config, baseline: &BTreeMap<Key, Node>) -> io::Result<()> {
    // The operator owns this private directory. Guest filenames are never used here.
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;
    #[cfg(unix)]
    let builder = {
        let mut builder = tempfile::Builder::new();
        builder.permissions(std::fs::Permissions::from_mode(0o700));
        builder
    };
    #[cfg(windows)]
    let builder = tempfile::Builder::new();
    let spool = builder.tempdir_in(&config.staging)?;
    let staging = Dir::open_ambient_dir(spool.path(), cap_std::ambient_authority())?;
    let mut guest = receive(config, &staging)?;
    // Export is a complete writable-root tree. Never infer deletion in read-only roots.
    for key in baseline.keys() {
        if config.root(key.0)?.writable {
            guest.entry(key.clone()).or_insert(Guest {
                node: None,
                staged: None,
            });
        }
    }
    for ((root, path), child) in &guest {
        for (position, _) in path.match_indices('/') {
            if let Some(parent) = guest.get(&(*root, path[..position].to_owned())) {
                match &parent.node {
                    Some(node) if node.kind == "directory" => {}
                    None if child.node.is_none() => {}
                    _ => return Err(invalid()),
                }
            }
        }
    }
    let mut changes: Vec<(&Key, &Guest)> = Vec::new();
    let mut identities = HashSet::new();
    // Preflight *all* conflicts before making changes. I/O errors later are not rolled back.
    for (key, value) in &guest {
        let root = config.root(key.0)?;
        let host = current(&root.dir, &key.1)?;
        if let Some(identity) = host.as_ref().and_then(|node| node.identity) {
            // Includes case/normalization aliases on case-insensitive macOS filesystems.
            if !identities.insert((key.0, identity)) {
                return Err(invalid());
            }
        }
        let base = baseline.get(key);
        if value.node.is_none() && base.is_none() {
            return Err(invalid()); // Never delete an untracked path, even if it is absent.
        }
        if equivalent(host.as_ref(), value.node.as_ref()) || equivalent(value.node.as_ref(), base) {
            continue;
        }
        if !equivalent(host.as_ref(), base) {
            return Err(io::Error::new(io::ErrorKind::AlreadyExists, "conflict"));
        }
        if let (Some(host), Some(guest)) = (&host, &value.node) {
            if host.kind != guest.kind && (host.kind == "directory" || guest.kind == "directory") {
                return Err(invalid());
            }
        }
        changes.push((key, value));
    }
    // Parents before children for creation, children before parents for deletion.
    changes.sort_by_key(|(key, value)| {
        let depth = key.1.split('/').count();
        (
            value.node.is_none(),
            if value.node.is_none() {
                65 - depth
            } else {
                depth
            },
        )
    });
    for (index, (key, value)) in changes.iter().enumerate() {
        let root = config.root(key.0)?;
        let (dir, name) = parent(&root.dir, &key.1)?;
        let host = filesystem::at(&dir, &name)?;
        // Recheck on the pinned parent immediately before changing its entry.
        if equivalent(host.as_ref(), value.node.as_ref())
            || equivalent(value.node.as_ref(), baseline.get(*key))
        {
            continue;
        }
        if !equivalent(host.as_ref(), baseline.get(*key)) {
            return Err(io::Error::new(io::ErrorKind::AlreadyExists, "conflict"));
        }
        install(&dir, &name, value, baseline.get(*key), &staging, index)?;
    }
    // Do not enumerate roots here. A late untracked host socket/hardlink is not
    // a new capability and must never be opened just to refresh a baseline.
    let mut result = baseline.clone();
    identities.clear();
    for (key, value) in &guest {
        if let Some(identity) =
            current(&config.root(key.0)?.dir, &key.1)?.and_then(|node| node.identity)
        {
            if !identities.insert((key.0, identity)) {
                return Err(invalid());
            }
        }
        // The next ancestor must describe what the guest actually exported,
        // not host-only changes we retained. Otherwise the next import treats
        // those host changes as already shared and can roll them back later.
        // Read-only records stay untouched in the cloned baseline.
        match &value.node {
            Some(node) => {
                result.insert(key.clone(), node.clone());
            }
            None => {
                result.remove(key);
            }
        }
    }
    if result.len() > MAX_ENTRIES {
        return Err(invalid());
    }
    let records = result
        .iter()
        .map(|(key, node)| Record::new(key.clone(), node))
        .collect();
    config.write_baseline(Baseline {
        version: 1,
        entries: records,
    })
}

fn equivalent(a: Option<&Node>, b: Option<&Node>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(a), Some(b)) => a.kind == b.kind && a.hash == b.hash,
        _ => false,
    }
}

fn install(
    dir: &Dir,
    name: &str,
    guest: &Guest,
    base: Option<&Node>,
    staging: &Dir,
    index: usize,
) -> io::Result<()> {
    let old = match dir.symlink_metadata(name) {
        Ok(metadata) => Some(metadata),
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => return Err(error),
    };
    let Some(node) = &guest.node else {
        return match old {
            Some(m) if m.is_dir() => dir.remove_dir(name), // rmdir only: never recursive.
            Some(_) => dir.remove_file(name),
            None => Ok(()),
        };
    };
    if node.kind == "directory" {
        if old.is_some() {
            return Err(invalid()); // Deliberately refuse implicit type changes involving directories.
        }
        let mut builder = DirBuilder::new();
        builder.mode(node.mode & 0o777);
        return dir.create_dir_with(name, &builder);
    }
    if old.as_ref().is_some_and(|m| m.is_dir()) {
        return Err(invalid());
    }
    // Fresh inode, exclusively created. Never open an existing destination for writing.
    let temp = format!(".keundal-import-{}-{index}", std::process::id());
    if node.kind == "file" {
        let mut input = filesystem::open_file(staging, guest.staged.as_ref().ok_or_else(invalid)?)?;
        let mut opts = OpenOptions::new();
        opts.write(true).create_new(true).mode(node.mode & 0o777);
        let mut output = dir.open_with(&temp, &opts)?;
        let result = io::copy(&mut input, &mut output).and_then(|_| output.sync_all());
        if let Err(error) = result {
            let _ = dir.remove_file(&temp);
            return Err(error);
        }
    } else {
        dir.symlink_contents(node.target.as_ref().ok_or_else(invalid)?, &temp)?;
    }
    let result = (|| {
        // Copying can take time. Re-hash the destination *after* copying, before rename.
        let host = filesystem::at(dir, name)?;
        if equivalent(host.as_ref(), guest.node.as_ref()) {
            return Ok(());
        }
        if !equivalent(host.as_ref(), base) {
            return Err(io::Error::new(io::ErrorKind::AlreadyExists, "conflict"));
        }
        dir.rename(&temp, dir, name)
    })();
    let _ = dir.remove_file(&temp);
    result
}
