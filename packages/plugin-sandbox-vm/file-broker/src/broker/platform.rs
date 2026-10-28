#[cfg(windows)]
pub use super::windows::{Dir, DirBuilder, File, Metadata, OpenOptions};
#[cfg(unix)]
pub use cap_std::fs::{Dir, DirBuilder, File, Metadata, OpenOptions};

pub fn private(dir: &Dir) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use cap_std::fs::MetadataExt;
        if dir.dir_metadata()?.mode() & 0o077 != 0 {
            return Err(super::invalid());
        }
        Ok(())
    }
    #[cfg(windows)]
    dir.check_private()
}
