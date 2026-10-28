use super::platform::{Dir, File, Metadata, OpenOptions};
use super::{invalid, CHUNK, MAX_FILE, MAX_TOTAL};
#[cfg(unix)]
use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
#[cfg(unix)]
use cap_std::fs::{MetadataExt, OpenOptionsExt};
use sha2::{Digest, Sha256};
use std::io::{self, Read};
use std::path::{Component, Path};

#[derive(Clone, Debug)]
pub struct Node {
    pub kind: String,
    pub hash: Option<String>,
    pub mode: u32,
    pub target: Option<String>,
    pub identity: Option<(u64, u64)>,
}

pub fn validate_path(path: &str) -> io::Result<()> {
    if path.is_empty()
        || path.len() > 4096
        || path.contains(['\\', '\0', ':'])
        || path.split('/').count() > 64
        || path
            .split('/')
            .any(|c| c.is_empty() || c == "." || c == ".." || c.starts_with(".keundal-import-"))
        || Path::new(path)
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err(invalid());
    }
    #[cfg(windows)]
    for name in path.split('/') {
        super::windows::validate_component(name)?;
    }
    Ok(())
}

#[cfg(unix)]
pub fn absolute_dir(path: &Path) -> io::Result<Dir> {
    if !path.is_absolute() {
        return Err(invalid());
    }
    let mut dir = Dir::open_ambient_dir("/", cap_std::ambient_authority())?;
    for component in path.components() {
        match component {
            Component::RootDir => {}
            Component::Normal(name) => dir = dir.open_dir_nofollow(name)?,
            _ => return Err(invalid()),
        }
    }
    Ok(dir)
}

#[cfg(windows)]
pub fn absolute_dir(path: &Path) -> io::Result<Dir> {
    Dir::absolute(path)
}

pub fn parent(root: &Dir, path: &str) -> io::Result<(Dir, String)> {
    validate_path(path)?;
    let mut parts = path.split('/').peekable();
    let mut dir = root.try_clone()?;
    while let Some(part) = parts.next() {
        if parts.peek().is_none() {
            return Ok((dir, part.to_owned()));
        }
        // One component at a time: NOFOLLOW is never just a final-leaf check.
        dir = dir.open_dir_nofollow(part)?;
    }
    Err(invalid())
}

pub fn regular(metadata: &Metadata) -> io::Result<()> {
    if !metadata.is_file() || metadata.nlink() != 1 || metadata.len() > MAX_FILE {
        return Err(invalid());
    }
    Ok(())
}

pub fn open_file(dir: &Dir, name: &str) -> io::Result<File> {
    // A concurrent FIFO substitution cannot block, nor can a final symlink be followed.
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    options
        .follow(FollowSymlinks::No)
        .custom_flags(libc::O_NONBLOCK | libc::O_NOCTTY);
    let file = dir.open_with(name, &options)?;
    regular(&file.metadata()?)?;
    Ok(file)
}

fn stable(a: &Metadata, b: &Metadata) -> bool {
    a.dev() == b.dev()
        && a.ino() == b.ino()
        && a.len() == b.len()
        && a.mtime() == b.mtime()
        && a.mtime_nsec() == b.mtime_nsec()
        && a.ctime() == b.ctime()
        && a.ctime_nsec() == b.ctime_nsec()
}

pub fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub fn valid_hash(hash: &str) -> bool {
    hash.len() == 64
        && hash
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

pub fn read_file(
    mut file: File,
    total: &mut u64,
    mut consume: impl FnMut(&[u8]) -> io::Result<()>,
) -> io::Result<String> {
    let before = file.metadata()?;
    regular(&before)?;
    let mut count = 0;
    let mut digest = Sha256::new();
    let mut bytes = [0; CHUNK];
    loop {
        let size = file.read(&mut bytes)?;
        if size == 0 {
            break;
        }
        count += size as u64;
        *total += size as u64;
        if count > MAX_FILE || *total > MAX_TOTAL {
            return Err(invalid());
        }
        digest.update(&bytes[..size]);
        consume(&bytes[..size])?;
    }
    let after = file.metadata()?;
    regular(&after)?;
    if !stable(&before, &after) || count != before.len() {
        return Err(invalid());
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn node(dir: &Dir, name: &str) -> io::Result<(Node, Option<File>)> {
    let metadata = dir.symlink_metadata(name)?;
    let mut node = Node {
        kind: String::new(),
        hash: None,
        mode: metadata.mode() & 0o777,
        target: None,
        identity: Some((metadata.dev(), metadata.ino())),
    };
    if metadata.file_type().is_symlink() {
        let target = dir
            .read_link_contents(name)?
            .into_os_string()
            .into_string()
            .map_err(|_| invalid())?;
        if target.len() > 4096 || target.contains('\0') {
            return Err(invalid());
        }
        node.kind = "symlink".into();
        node.hash = Some(hash(format!("symlink:{target}").as_bytes()));
        node.target = Some(target);
        return Ok((node, None));
    }
    if metadata.is_dir() {
        // Pin and check the directory as well; a racing symlink replacement must fail.
        dir.open_dir_nofollow(name)?;
        node.kind = "directory".into();
        return Ok((node, None));
    }
    regular(&metadata)?;
    let file = open_file(dir, name)?;
    if !stable(&metadata, &file.metadata()?) {
        return Err(invalid());
    }
    node.kind = "file".into();
    Ok((node, Some(file)))
}

pub fn at(dir: &Dir, name: &str) -> io::Result<Option<Node>> {
    let (mut node, file) = match node(dir, name) {
        Ok(value) => value,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    if let Some(file) = file {
        node.hash = Some(read_file(file, &mut 0, |_| Ok(()))?);
    }
    Ok(Some(node))
}

pub fn current(root: &Dir, path: &str) -> io::Result<Option<Node>> {
    match parent(root, path) {
        Ok((dir, name)) => at(&dir, &name),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

pub fn scan(
    dir: &Dir,
    prefix: &str,
    consume: &mut impl FnMut(&str, Node, Option<File>) -> io::Result<()>,
) -> io::Result<()> {
    // Do not collect unbounded directory listings into memory.
    for entry in dir.entries()? {
        let name = entry?.file_name().into_string().map_err(|_| invalid())?;
        let path = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}/{name}")
        };
        validate_path(&path)?;
        let (node, file) = node(dir, &name)?;
        let is_dir = node.kind == "directory";
        // Keep the exact child handle for recursion: never reopen by an accumulated path.
        let child = if is_dir {
            Some(dir.open_dir_nofollow(&name)?)
        } else {
            None
        };
        consume(&path, node, file)?;
        if let Some(child) = child {
            scan(&child, &path, consume)?;
        }
    }
    Ok(())
}
