//! Windows capability backend. Only volume-root acquisition is ambient. Every
//! subsequent name is one validated component relative to a pinned NT handle.
//! Never use cap-primitives' Windows ambient rename/enumerate/create fallbacks.
use super::invalid;
use std::ffi::OsString;
use std::fs;
use std::io::{self, Read, Write};
use std::mem::{size_of, zeroed};
use std::os::windows::ffi::OsStringExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::{Component, Path, PathBuf, Prefix};
use std::ptr::{null, null_mut};
use windows_sys::Wdk::Foundation::OBJECT_ATTRIBUTES;
use windows_sys::Wdk::Storage::FileSystem::{
    FileDispositionInformation, FileNamesInformation, FileRenameInformation, NtCreateFile,
    NtQueryDirectoryFile, NtSetInformationFile, FILE_CREATE, FILE_DIRECTORY_FILE,
    FILE_DISPOSITION_INFORMATION, FILE_NON_DIRECTORY_FILE, FILE_OPEN, FILE_OPEN_REPARSE_POINT,
    FILE_RENAME_INFORMATION, FILE_SYNCHRONOUS_IO_NONALERT,
};
use windows_sys::Win32::Foundation::{
    GetLastError, LocalFree, RtlNtStatusToDosError, ERROR_NOT_ALL_ASSIGNED, INVALID_HANDLE_VALUE,
    OBJ_CASE_INSENSITIVE, STATUS_NO_MORE_FILES, UNICODE_STRING,
};
use windows_sys::Win32::Security::Authorization::{GetSecurityInfo, SE_FILE_OBJECT};
use windows_sys::Win32::Security::*;
use windows_sys::Win32::Storage::FileSystem::*;
use windows_sys::Win32::System::Ioctl::{FSCTL_GET_REPARSE_POINT, FSCTL_SET_REPARSE_POINT};
use windows_sys::Win32::System::SystemServices::IO_REPARSE_TAG_SYMLINK;
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
use windows_sys::Win32::System::IO::{DeviceIoControl, IO_STATUS_BLOCK};

fn checked(status: i32) -> io::Result<()> {
    if status != 0 {
        Err(io::Error::from_raw_os_error(unsafe {
            RtlNtStatusToDosError(status) as i32
        }))
    } else {
        Ok(())
    }
}

fn boolean(value: i32) -> io::Result<()> {
    if value == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn component(name: &str) -> io::Result<Vec<u16>> {
    // NT names bypass Win32 normalization. Refuse ambiguous Win32 spellings too,
    // so a guest cannot introduce ADS, DOS device names, or trailing-dot aliases.
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.contains(['/', '\\', ':', '\0', '*', '?', '"', '<', '>', '|'])
        || name.chars().any(|c| c < ' ')
        || name.ends_with(['.', ' '])
    {
        return Err(invalid());
    }
    let stem = name
        .split('.')
        .next()
        .unwrap()
        .trim_end_matches(' ')
        .to_ascii_uppercase();
    if matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) || ["COM", "LPT"].iter().any(|prefix| {
        stem.strip_prefix(prefix).is_some_and(|suffix| {
            matches!(
                suffix,
                "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            )
        })
    }) {
        return Err(invalid());
    }
    let name: Vec<_> = name.encode_utf16().collect();
    if name.len() > 255 {
        return Err(invalid());
    }
    Ok(name)
}

pub fn validate_component(name: &str) -> io::Result<()> {
    component(name).map(|_| ())
}

fn open(
    parent: &fs::File,
    name: &str,
    access: u32,
    disposition: u32,
    options: u32,
) -> io::Result<fs::File> {
    let mut name = component(name)?;
    let mut text = UNICODE_STRING {
        Length: (name.len() * 2) as u16,
        MaximumLength: (name.len() * 2) as u16,
        Buffer: name.as_mut_ptr(),
    };
    let mut attrs: OBJECT_ATTRIBUTES = unsafe { zeroed() };
    attrs.Length = size_of::<OBJECT_ATTRIBUTES>() as u32;
    attrs.RootDirectory = parent.as_raw_handle();
    attrs.ObjectName = &mut text;
    attrs.Attributes = OBJ_CASE_INSENSITIVE;
    let mut handle = null_mut();
    let mut iosb = unsafe { zeroed() };
    // No FILE_SHARE_DELETE: directories cannot be renamed/replaced while held.
    // FILE_OPEN_REPARSE_POINT applies to the sole component, not just the last
    // element of a multi-component string. No callbacks/async I/O are used.
    checked(unsafe {
        NtCreateFile(
            &mut handle,
            access | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
            &attrs,
            &mut iosb,
            null(),
            FILE_ATTRIBUTE_NORMAL,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            disposition,
            options | FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT,
            null(),
            0,
        )
    })?;
    Ok(unsafe { fs::File::from_raw_handle(handle) })
}

#[derive(Clone)]
pub struct Metadata {
    info: BY_HANDLE_FILE_INFORMATION,
    basic: FILE_BASIC_INFO,
    tag: u32,
}
impl Metadata {
    fn of(file: &fs::File) -> io::Result<Self> {
        if unsafe { GetFileType(file.as_raw_handle()) } != FILE_TYPE_DISK {
            return Err(invalid());
        }
        let mut info = unsafe { zeroed() };
        let mut basic: FILE_BASIC_INFO = unsafe { zeroed() };
        let mut tag: FILE_ATTRIBUTE_TAG_INFO = unsafe { zeroed() };
        boolean(unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) })?;
        boolean(unsafe {
            GetFileInformationByHandleEx(
                file.as_raw_handle(),
                FileBasicInfo,
                (&mut basic as *mut FILE_BASIC_INFO).cast(),
                size_of::<FILE_BASIC_INFO>() as u32,
            )
        })?;
        boolean(unsafe {
            GetFileInformationByHandleEx(
                file.as_raw_handle(),
                FileAttributeTagInfo,
                (&mut tag as *mut FILE_ATTRIBUTE_TAG_INFO).cast(),
                size_of::<FILE_ATTRIBUTE_TAG_INFO>() as u32,
            )
        })?;
        // Junctions, cloud placeholders, mount points, and unknown tags are not
        // inert symlink strings. They are rejected, never used as parents.
        if info.dwFileAttributes & (FILE_ATTRIBUTE_DEVICE | FILE_ATTRIBUTE_OFFLINE) != 0
            || (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
                && tag.ReparseTag != IO_REPARSE_TAG_SYMLINK)
        {
            return Err(invalid());
        }
        Ok(Self {
            info,
            basic,
            tag: tag.ReparseTag,
        })
    }
    pub fn file_type(&self) -> &Self {
        self
    }
    pub fn is_symlink(&self) -> bool {
        self.info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
            && self.tag == IO_REPARSE_TAG_SYMLINK
    }
    pub fn is_dir(&self) -> bool {
        !self.is_symlink() && self.info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0
    }
    pub fn is_file(&self) -> bool {
        !self.is_symlink() && !self.is_dir()
    }
    pub fn mode(&self) -> u32 {
        if self.is_dir() {
            0o755
        } else {
            0o644
        }
    }
    pub fn dev(&self) -> u64 {
        u64::from(self.info.dwVolumeSerialNumber)
    }
    pub fn ino(&self) -> u64 {
        (u64::from(self.info.nFileIndexHigh) << 32) | u64::from(self.info.nFileIndexLow)
    }
    pub fn nlink(&self) -> u64 {
        u64::from(self.info.nNumberOfLinks)
    }
    pub fn len(&self) -> u64 {
        (u64::from(self.info.nFileSizeHigh) << 32) | u64::from(self.info.nFileSizeLow)
    }
    pub fn mtime(&self) -> i64 {
        self.basic.LastWriteTime
    }
    pub fn mtime_nsec(&self) -> i64 {
        0
    }
    pub fn ctime(&self) -> i64 {
        self.basic.ChangeTime
    }
    pub fn ctime_nsec(&self) -> i64 {
        0
    }
}

pub struct File(fs::File);
impl File {
    pub fn metadata(&self) -> io::Result<Metadata> {
        Metadata::of(&self.0)
    }
    pub fn sync_all(&self) -> io::Result<()> {
        self.0.sync_all()
    }
}
impl Read for File {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        self.0.read(bytes)
    }
}
impl Write for File {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0.write(bytes)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.0.flush()
    }
}
#[derive(Default)]
pub struct OpenOptions {
    read: bool,
    write: bool,
    create: bool,
}
impl OpenOptions {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn read(&mut self, value: bool) -> &mut Self {
        self.read = value;
        self
    }
    pub fn write(&mut self, value: bool) -> &mut Self {
        self.write = value;
        self
    }
    pub fn create_new(&mut self, value: bool) -> &mut Self {
        self.create = value;
        self
    }
    pub fn mode(&mut self, _mode: u32) -> &mut Self {
        self
    }
}
pub struct DirBuilder;
impl DirBuilder {
    pub fn new() -> Self {
        Self
    }
    pub fn mode(&mut self, _mode: u32) -> &mut Self {
        self
    }
}

pub struct Dir(fs::File);
impl Dir {
    pub fn absolute(path: &Path) -> io::Result<Self> {
        let mut parts = path.components();
        let prefix = match parts.next() {
            Some(Component::Prefix(prefix)) => match prefix.kind() {
                Prefix::Disk(letter) | Prefix::VerbatimDisk(letter) => letter,
                _ => return Err(invalid()), // Local drive roots only; no UNC/device namespace.
            },
            _ => return Err(invalid()),
        };
        if parts.next() != Some(Component::RootDir) {
            return Err(invalid());
        }
        let volume: Vec<_> = format!("\\\\?\\{}:\\", char::from(prefix))
            .encode_utf16()
            .chain(Some(0))
            .collect();
        let handle = unsafe {
            CreateFileW(
                volume.as_ptr(),
                FILE_LIST_DIRECTORY
                    | FILE_TRAVERSE
                    | FILE_READ_ATTRIBUTES
                    | READ_CONTROL
                    | SYNCHRONIZE,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                null(),
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                null_mut(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }
        let mut dir = Self(unsafe { fs::File::from_raw_handle(handle) });
        dir.ensure_directory()?;
        for part in parts {
            let Component::Normal(name) = part else {
                return Err(invalid());
            };
            dir = dir.open_dir_nofollow(name.to_str().ok_or_else(invalid)?)?;
        }
        Ok(dir)
    }
    pub fn open_ambient_dir(
        path: impl AsRef<Path>,
        _authority: cap_std::AmbientAuthority,
    ) -> io::Result<Self> {
        Self::absolute(path.as_ref())
    }
    fn ensure_directory(&self) -> io::Result<()> {
        if !Metadata::of(&self.0)?.is_dir() {
            return Err(invalid());
        }
        Ok(())
    }
    pub fn try_clone(&self) -> io::Result<Self> {
        Ok(Self(self.0.try_clone()?))
    }
    pub fn open_dir_nofollow(&self, name: &str) -> io::Result<Self> {
        let dir = Self(open(
            &self.0,
            name,
            FILE_LIST_DIRECTORY | FILE_TRAVERSE | READ_CONTROL,
            FILE_OPEN,
            0,
        )?);
        dir.ensure_directory()?;
        Ok(dir)
    }
    pub fn open_with(&self, name: &str, options: &OpenOptions) -> io::Result<File> {
        if options.write == options.read || (options.write && !options.create) {
            return Err(invalid());
        }
        let access = if options.write {
            FILE_GENERIC_WRITE
        } else {
            FILE_READ_DATA
        };
        let file = File(open(
            &self.0,
            name,
            access,
            if options.create {
                FILE_CREATE
            } else {
                FILE_OPEN
            },
            FILE_NON_DIRECTORY_FILE,
        )?);
        super::filesystem::regular(&file.metadata()?)?;
        Ok(file)
    }
    pub fn symlink_metadata(&self, name: &str) -> io::Result<Metadata> {
        Metadata::of(&open(&self.0, name, FILE_READ_ATTRIBUTES, FILE_OPEN, 0)?)
    }
    pub fn create_dir_with(&self, name: &str, _builder: &DirBuilder) -> io::Result<()> {
        let dir = Self(open(
            &self.0,
            name,
            FILE_LIST_DIRECTORY,
            FILE_CREATE,
            FILE_DIRECTORY_FILE,
        )?);
        dir.ensure_directory()
    }
    pub fn rename(&self, source: &str, dest: &Dir, name: &str) -> io::Result<()> {
        let file = open(&self.0, source, DELETE, FILE_OPEN, 0)?;
        let metadata = Metadata::of(&file)?;
        if metadata.is_file() {
            super::filesystem::regular(&metadata)?;
        }
        if metadata.is_dir() {
            return Err(invalid());
        }
        let name = component(name)?;
        // Vec<u64> provides alignment for the SDK's variable-sized structure.
        let length = size_of::<FILE_RENAME_INFORMATION>() + name.len() * 2;
        let mut bytes = vec![0u64; length.div_ceil(8)];
        let info = bytes.as_mut_ptr().cast::<FILE_RENAME_INFORMATION>();
        unsafe {
            (*info).Anonymous.ReplaceIfExists = true;
            (*info).RootDirectory = dest.0.as_raw_handle();
            (*info).FileNameLength = (name.len() * 2) as u32;
            std::ptr::copy_nonoverlapping(
                name.as_ptr(),
                std::ptr::addr_of_mut!((*info).FileName).cast::<u16>(),
                name.len(),
            );
        }
        let mut iosb = unsafe { zeroed() };
        checked(unsafe {
            NtSetInformationFile(
                file.as_raw_handle(),
                &mut iosb,
                info.cast(),
                length as u32,
                FileRenameInformation,
            )
        })
    }
    fn remove(&self, name: &str, directory: bool) -> io::Result<()> {
        let file = open(&self.0, name, DELETE, FILE_OPEN, 0)?;
        let metadata = Metadata::of(&file)?;
        if metadata.is_dir() != directory {
            return Err(invalid());
        }
        if metadata.is_file() {
            super::filesystem::regular(&metadata)?;
        }
        let info = FILE_DISPOSITION_INFORMATION { DeleteFile: true };
        let mut iosb = unsafe { zeroed() };
        // Deletion applies to this handle, not a reopened ambient pathname.
        // The filesystem rejects a nonempty directory. No recursive deletion.
        checked(unsafe {
            NtSetInformationFile(
                file.as_raw_handle(),
                &mut iosb,
                (&info as *const FILE_DISPOSITION_INFORMATION).cast(),
                size_of::<FILE_DISPOSITION_INFORMATION>() as u32,
                FileDispositionInformation,
            )
        })
    }
    pub fn remove_file(&self, name: &str) -> io::Result<()> {
        self.remove(name, false)
    }
    pub fn remove_dir(&self, name: &str) -> io::Result<()> {
        self.remove(name, true)
    }
    pub fn entries(&self) -> io::Result<Entries<'_>> {
        Ok(Entries {
            dir: self,
            restart: true,
            done: false,
        })
    }
    pub fn read_link_contents(&self, name: &str) -> io::Result<PathBuf> {
        let file = open(&self.0, name, FILE_READ_ATTRIBUTES, FILE_OPEN, 0)?;
        if !Metadata::of(&file)?.is_symlink() {
            return Err(invalid());
        }
        let mut bytes = vec![0u8; 16 * 1024];
        let mut count = 0;
        boolean(unsafe {
            DeviceIoControl(
                file.as_raw_handle(),
                FSCTL_GET_REPARSE_POINT,
                null(),
                0,
                bytes.as_mut_ptr().cast(),
                bytes.len() as u32,
                &mut count,
                null_mut(),
            )
        })?;
        let bytes = &bytes[..count as usize];
        if bytes.len() < 20 {
            return Err(invalid());
        }
        let word = |offset| u16::from_le_bytes([bytes[offset], bytes[offset + 1]]) as usize;
        let tag = u32::from_le_bytes(bytes[..4].try_into().unwrap());
        if tag != IO_REPARSE_TAG_SYMLINK || word(4) + 8 > bytes.len() {
            return Err(invalid());
        }
        // PrintName preserves the exact inert string, unlike NT SubstituteName.
        let (offset, length) = (word(12), word(14));
        if !offset.is_multiple_of(2)
            || !length.is_multiple_of(2)
            || 20 + offset + length > word(4) + 8
        {
            return Err(invalid());
        }
        let target: Vec<_> = bytes[20 + offset..20 + offset + length]
            .as_chunks::<2>()
            .0
            .iter()
            .map(|v| u16::from_le_bytes(*v))
            .collect();
        Ok(PathBuf::from(OsString::from_wide(&target)))
    }
    pub fn symlink_contents(&self, target: &str, name: &str) -> io::Result<()> {
        enable_symlink_privilege()?;
        let target: Vec<_> = target.encode_utf16().collect();
        let length = target.len() * 2;
        if 20 + 2 * length > 16 * 1024 {
            return Err(invalid());
        }
        let mut bytes = Vec::with_capacity(20 + 2 * length);
        bytes.extend_from_slice(&IO_REPARSE_TAG_SYMLINK.to_le_bytes());
        bytes.extend_from_slice(&((12 + 2 * length) as u16).to_le_bytes());
        bytes.extend_from_slice(&0u16.to_le_bytes());
        bytes.extend_from_slice(&0u16.to_le_bytes()); // SubstituteNameOffset
        bytes.extend_from_slice(&(length as u16).to_le_bytes());
        bytes.extend_from_slice(&(length as u16).to_le_bytes()); // PrintNameOffset
        bytes.extend_from_slice(&(length as u16).to_le_bytes());
        bytes.extend_from_slice(&1u32.to_le_bytes()); // SYMLINK_FLAG_RELATIVE
        for _ in 0..2 {
            for unit in &target {
                bytes.extend_from_slice(&unit.to_le_bytes());
            }
        }
        let file = open(
            &self.0,
            name,
            FILE_GENERIC_WRITE | DELETE,
            FILE_CREATE,
            FILE_NON_DIRECTORY_FILE,
        )?;
        let mut returned = 0;
        let result = boolean(unsafe {
            DeviceIoControl(
                file.as_raw_handle(),
                FSCTL_SET_REPARSE_POINT,
                bytes.as_ptr().cast(),
                bytes.len() as u32,
                null_mut(),
                0,
                &mut returned,
                null_mut(),
            )
        });
        if result.is_err() {
            let info = FILE_DISPOSITION_INFORMATION { DeleteFile: true };
            let mut iosb = unsafe { zeroed() };
            unsafe {
                NtSetInformationFile(
                    file.as_raw_handle(),
                    &mut iosb,
                    (&info as *const FILE_DISPOSITION_INFORMATION).cast(),
                    size_of::<FILE_DISPOSITION_INFORMATION>() as u32,
                    FileDispositionInformation,
                );
            }
        }
        result
    }
    pub fn check_private(&self) -> io::Result<()> {
        private(&self.0)
    }
}

pub struct Entry(OsString);
impl Entry {
    pub fn file_name(&self) -> OsString {
        self.0.clone()
    }
}

pub struct Entries<'a> {
    dir: &'a Dir,
    restart: bool,
    done: bool,
}
impl Iterator for Entries<'_> {
    type Item = io::Result<Entry>;
    fn next(&mut self) -> Option<Self::Item> {
        while !self.done {
            // FILE_NAMES_INFORMATION needs at most 12 + 255*2 bytes on NTFS.
            // Use an aligned fixed buffer, not an unbounded directory listing.
            let mut buffer = [0u64; 512];
            let mut iosb: IO_STATUS_BLOCK = unsafe { zeroed() };
            let status = unsafe {
                NtQueryDirectoryFile(
                    self.dir.0.as_raw_handle(),
                    null_mut(),
                    None,
                    null(),
                    &mut iosb,
                    buffer.as_mut_ptr().cast(),
                    (buffer.len() * 8) as u32,
                    FileNamesInformation,
                    true,
                    null(),
                    self.restart,
                )
            };
            self.restart = false;
            if status == STATUS_NO_MORE_FILES {
                self.done = true;
                return None;
            }
            let result = (|| {
                checked(status)?;
                let available = iosb.Information;
                if available < 12 || available > buffer.len() * 8 {
                    return Err(invalid());
                }
                let raw = buffer.as_ptr().cast::<u8>();
                let length = unsafe { std::ptr::read_unaligned(raw.add(8).cast::<u32>()) } as usize;
                if !length.is_multiple_of(2) || length > available - 12 {
                    return Err(invalid());
                }
                let name =
                    unsafe { std::slice::from_raw_parts(raw.add(12).cast::<u16>(), length / 2) };
                Ok(Entry(OsString::from_wide(name)))
            })();
            match result {
                Ok(entry) if entry.0 == "." || entry.0 == ".." => continue,
                Err(_) => self.done = true,
                _ => {}
            }
            return Some(result);
        }
        None
    }
}

fn token(access: u32) -> io::Result<OwnedHandle> {
    let mut handle = null_mut();
    boolean(unsafe { OpenProcessToken(GetCurrentProcess(), access, &mut handle) })?;
    Ok(unsafe { OwnedHandle::from_raw_handle(handle) })
}

fn enable_symlink_privilege() -> io::Result<()> {
    let token = token(TOKEN_QUERY | TOKEN_ADJUST_PRIVILEGES)?;
    let name: Vec<_> = "SeCreateSymbolicLinkPrivilege"
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let mut privileges: TOKEN_PRIVILEGES = unsafe { zeroed() };
    privileges.PrivilegeCount = 1;
    privileges.Privileges[0].Attributes = SE_PRIVILEGE_ENABLED;
    boolean(unsafe {
        LookupPrivilegeValueW(null(), name.as_ptr(), &mut privileges.Privileges[0].Luid)
    })?;
    boolean(unsafe {
        AdjustTokenPrivileges(
            token.as_raw_handle(),
            0,
            &privileges,
            0,
            null_mut(),
            null_mut(),
        )
    })?;
    if unsafe { GetLastError() } == ERROR_NOT_ALL_ASSIGNED {
        return Err(io::Error::from(io::ErrorKind::PermissionDenied));
    }
    Ok(())
}

fn private(file: &fs::File) -> io::Result<()> {
    // Read the DACL, never edit it. Conservative allow-list: this process's user,
    // SYSTEM, local Administrators, and CREATOR OWNER. Unknown/conditional ACEs,
    // absent DACLs, and broader grants fail rather than silently relaxing privacy.
    let token = token(TOKEN_QUERY)?;
    let mut needed = 0;
    unsafe {
        GetTokenInformation(token.as_raw_handle(), TokenUser, null_mut(), 0, &mut needed);
    }
    if needed == 0 || needed > 65536 {
        return Err(invalid());
    }
    let mut user = vec![0u64; (needed as usize).div_ceil(8)];
    boolean(unsafe {
        GetTokenInformation(
            token.as_raw_handle(),
            TokenUser,
            user.as_mut_ptr().cast(),
            needed,
            &mut needed,
        )
    })?;
    let user_sid = unsafe { (*user.as_ptr().cast::<TOKEN_USER>()).User.Sid };
    let mut trusted = Vec::new();
    for kind in [
        WinLocalSystemSid,
        WinBuiltinAdministratorsSid,
        WinCreatorOwnerSid,
    ] {
        let mut sid = vec![0u64; 16];
        let mut size = (sid.len() * 8) as u32;
        boolean(unsafe {
            CreateWellKnownSid(kind, null_mut(), sid.as_mut_ptr().cast(), &mut size)
        })?;
        trusted.push(sid);
    }
    let is_trusted = |sid| unsafe {
        EqualSid(sid, user_sid) != 0
            || trusted
                .iter()
                .any(|s| EqualSid(sid, s.as_ptr().cast_mut().cast()) != 0)
    };
    let mut owner = null_mut();
    let mut dacl: *mut ACL = null_mut();
    let mut descriptor = null_mut();
    let status = unsafe {
        GetSecurityInfo(
            file.as_raw_handle(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            null_mut(),
            &mut dacl,
            null_mut(),
            &mut descriptor,
        )
    };
    if status != 0 {
        return Err(io::Error::from_raw_os_error(status as i32));
    }
    struct Descriptor(*mut std::ffi::c_void);
    impl Drop for Descriptor {
        fn drop(&mut self) {
            unsafe {
                LocalFree(self.0);
            }
        }
    }
    let _descriptor = Descriptor(descriptor);
    if dacl.is_null() || !is_trusted(owner) {
        return Err(invalid());
    }
    for index in 0..unsafe { (*dacl).AceCount } {
        let mut ace = null_mut();
        boolean(unsafe { GetAce(dacl, index as u32, &mut ace) })?;
        let header = unsafe { &*ace.cast::<ACE_HEADER>() };
        match header.AceType as u32 {
            // ACCESS_ALLOWED_ACE_TYPE / ACCESS_DENIED_ACE_TYPE
            0 => {
                if (header.AceSize as usize) < size_of::<ACCESS_ALLOWED_ACE>() {
                    return Err(invalid());
                }
                let allowed = ace.cast::<ACCESS_ALLOWED_ACE>();
                let sid = unsafe { std::ptr::addr_of!((*allowed).SidStart).cast_mut().cast() };
                if unsafe { (*allowed).Mask } != 0 && !is_trusted(sid) {
                    return Err(invalid());
                }
            }
            1 => {}
            _ => return Err(invalid()),
        }
    }
    Ok(())
}
