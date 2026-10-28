# File broker

Small synchronous host-side executable. No guest process, shell, network client,
worker thread, live shared folder, or ACL-editing API is used by the broker.

```sh
cargo build --release --locked --manifest-path packages/plugin-sandbox-vm/file-broker/Cargo.toml
packages/plugin-sandbox-vm/file-broker/target/release/keundal-file-broker snapshot /absolute/private/config.json
packages/plugin-sandbox-vm/file-broker/target/release/keundal-file-broker apply /absolute/private/config.json < export.jsonl
cargo test --locked --manifest-path packages/plugin-sandbox-vm/file-broker/Cargo.toml -- --test-threads=1
```

## Platform implementation and validation status

Linux is implemented and tested. macOS uses the same Unix capability implementation.
Windows uses the native handle-relative backend in `src/broker/windows.rs`, not
the ambient-path Windows mutations in cap-primitives. Windows is enabled; there
is no Windows `Unsupported` guard. Other, non-Unix/non-Windows targets fail closed.
The package-local Cargo.lock is included for the host CI's `--locked` builds.

In the Linux development orb, the Windows binary and native CLI tests have been
cross-compiled **and linked** for `x86_64-pc-windows-gnu`; macOS has been
cross-checked. **Neither native Windows nor native macOS execution was available.**
Cross-compilation is not evidence of Windows kernel race behavior. The native
Windows tests must pass in host CI before claiming Windows runtime validation.

The pinned Unix dependencies are `cap-std` / `cap-fs-ext` 4.0.3. Upstream was
inspected at revision [`b7acf8e`](https://github.com/bytecodealliance/cap-std/tree/b7acf8e8807fe3fab991884d2208b7e03d35a409).
On Windows, `FollowSymlinks::No` really does add `FILE_FLAG_OPEN_REPARSE_POINT`,
and opening uses handle-relative `NtCreateFile`; directory handles also deny
delete sharing. However, its post-open check tests the symlink file type, not
every reparse tag. Rename, unlink, directory creation, enumeration and symlink
creation contain ambient-path fallbacks. Public `read_link_contents` is an
exception: it opens a reparse handle and reads that handle. The native backend
avoids these fallbacks entirely rather than assuming that a final symlink check
or upstream sharing modes establish the complete boundary.

## Operator configuration

```json
{
  "roots": [{ "id": 7, "path": "/canonical/host/project", "writable": true }],
  "baseline": "/private/job/baseline.json",
  "nextBaseline": "/private/job/next.json",
  "staging": "/private/job/staging"
}
```

Paths are absolute. Root and staging paths must already equal their canonical
paths. Roots are existing directories, nonoverlapping, with distinct unsigned
32-bit IDs; at most 128 roots are allowed. Do not change IDs between operations.
The configured root directory inode is opened once and retained for the entire
invocation. No writes are permitted for entries in read-only roots; an export
must omit those roots, even if their entries are unchanged. An optional root
`target` string is accepted and ignored; it is VM supervisor metadata.

Config, baseline, nextBaseline and staging must be distinct private operator
paths outside every root. File parents and staging must already exist with no
Unix group/other permission bits (normally mode `0700`). On Windows their owner
and DACL are inspected by handle: only the current user, SYSTEM, local
Administrators and CREATOR OWNER may receive nonzero allow grants. A missing
DACL, unknown/conditional ACE or broader grant is rejected conservatively.
These checks never chmod files or alter ACLs. Existing operator files must be single-link regular files. Missing
baseline means an empty baseline. Missing nextBaseline is normal. Config is
limited to 1 MiB and baseline to 64 MiB. Operator directories and their namespace
ancestors must be trusted and not concurrently replaced. The staging directory
must not be visible to the guest.

For baseline state, successful operations write only `nextBaseline`, using a fresh file (`0600` on Unix),
sync and a capability-relative atomic rename. They never overwrite `baseline`.
The caller promotes nextBaseline only after exit status 0 and the guest import
acknowledgement for snapshots (or successful export application for apply).
An old nextBaseline may still exist following a failed operation;
it must never be promoted on failure. Serialize operations and baseline promotion
for a set of roots. There is no process lock or cross-root transaction.

### Exact baseline JSON format

One JSON object followed by a newline; array order has no semantic meaning:

```json
{
  "version": 1,
  "entries": [
    { "root": 7, "path": "src", "kind": "directory", "hash": null },
    {
      "root": 7,
      "path": "src/a.txt",
      "kind": "file",
      "hash": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    }
  ]
}
```

Each `(root, path)` is unique. `kind` is `directory`, `file`, or `symlink`.
Directories have `hash: null`; files have lowercase hexadecimal SHA256 of their
raw bytes; symlinks have SHA256 of UTF-8 bytes `symlink:` followed by the exact
target string. Root entries themselves are not represented. Absence from the
array means absence from the baseline; it is distinct from a directory's null
hash. Modes, targets and file contents are not stored in the baseline. Unknown
versions, kinds, roots, duplicate keys, invalid hashes and unknown fields fail.

Snapshot records all observed entries. After successful apply, writable-root
baseline records describe the **full guest-exported snapshot**, not necessarily
the resulting host tree. Guest-surviving entries remain in that ancestor even
when the host independently edited or deleted them; guest-deleted paths are
absent. This preserves the common ancestor for the next import: host-only B
retained while guest remains A must yield ancestor A, so the next snapshot
emits B with baseHash A and the guest can accept B instead of rolling it back.
Host-only deletions likewise produce a deletion with the prior guest hash.

Apply observes only known writable paths (the union of the trusted baseline and
explicit guest entries) for conflict and alias checks. It preserves read-only
baseline records without reading their current contents, and never enumerates
host roots to discover new entries. Late untracked host files, hardlinks and
sockets remain untouched and are not added to nextBaseline. Independently
edited known host paths are retained when the guest is unchanged.

## Wire protocol

Snapshot emits UTF-8 JSONL frames sequentially: `entry`, zero or more `chunk`
frames and `file-end` for a regular file, then more entries; deletions for missing
baseline paths; finally `snapshot-end`. No parallel file streams are used.
Symlinks have a `target` string and no content frames. `baseHash` comes only from
the previous baseline; absent entries and directories both emit null. File chunks
use standard padded base64, at most 65,536 decoded bytes each. Empty files use no
chunks and still require `file-end` with SHA256 of empty bytes.

Apply requires the same sequencing, `snapshot-end`, then EOF. Close stdin.
Guest `baseHash` values are accepted but entirely ignored; conflict decisions
load only the operator's baseline. This is a **full writable-root export**, not a
patch: missing tracked paths in writable roots imply deletion. Read-only roots
are never included in that inference. Explicit `delete` frames are also accepted.
All surviving directories must be included. Deleting an untracked path fails,
even if it is currently absent. A deleted directory is removed only by `rmdir`,
never recursive removal, and therefore cannot discard untracked children.

All export bytes are staged in independently created private files before any
host change. Limits: 100,000 entry/delete frames, 1,000,000 total frames, 96 KiB
per JSONL line, 256 MiB per regular file, 1 GiB decoded file bytes, 4,096 UTF-8
bytes per path/target, and 64 path components. Empty chunks, unfinished streams,
extra frames after the terminator, invalid hashes, unknown fields, duplicate
paths, conflicting ancestor entries, and invalid kinds/modes fail. Paths reject
absolute/drive paths, backslash, colon, NUL, empty components, `.` and `..`.
The `.keundal-import-` prefix is reserved for each path component.
Apply also rejects different known paths resolving to the same observed inode,
including case/normalization aliases on case-insensitive macOS filesystems. It
does not implement case-only renames. Newly created alias collisions can be
detected only during the resulting-known-path check and can leave earlier writes.

Conflict comparison includes kind and content hash (not permission mode):

- Host equals guest: skip.
- Guest equals baseline: retain independently changed/deleted host.
- Host equals baseline: install/delete guest value.
- Otherwise: fail nonzero, without printing file contents or parser details.

All initial conflicts are checked before mutation. Destinations are rechecked on
their pinned parent; file destinations are rehashed again after copying the new
temporary file, immediately before rename. Fresh files are created exclusively
in the destination parent, filled through their open handle and synced, then
renamed over the destination. Existing files are **never truncated or opened for
writing**. An existing final symlink is compared as an inert link and can be
replaced; it is never followed. File/symlink type changes are supported;
directory-to-file/symlink or reverse type changes are deliberately rejected.

## Unix capability boundary

Absolute roots are opened by walking from `/` using one-component
`open_dir_nofollow` calls. All descendant parents are likewise walked one
component at a time. Recursion retains child directory handles rather than
reopening accumulated paths. Final file opens use `OpenOptionsFollowExt::follow(No)`
and `O_NONBLOCK | O_NOCTTY`. Both path metadata and opened-handle metadata reject
nonregular files and regular files whose link count is not exactly one. File
identity, length, modification time and change time are checked around reading.
Sockets, FIFOs and devices are not exported or modified. Symlinks are read with
`read_link_contents` and created with `symlink_contents`; absolute and outside
targets remain inert strings, including links to outside sockets.

## Windows capability boundary

Only local absolute drive paths are supported, including their canonical
`\\?\C:\...` spelling. UNC shares and device namespace roots are rejected.
The initial local volume-root handle is acquired with `CreateFileW`; all further
components use synchronous
[`NtCreateFile`](https://learn.microsoft.com/en-us/windows/win32/api/winternl/nf-winternl-ntcreatefile)
with `OBJECT_ATTRIBUTES.RootDirectory`, a single checked component,
`FILE_OPEN_REPARSE_POINT`, and no `FILE_SHARE_DELETE`. An opened directory must
be a real directory with no reparse point before it can become a parent. Handles
are retained for traversal and recursion. Root replacement is expected to be
denied by sharing modes; operations do not reconstruct an ambient path if a
directory moves.

`GetFileInformationByHandle[Ex]` supplies file identity, link count, size,
last-write time and change time. Regular-file links must number exactly one.
Only `FILE_TYPE_DISK` objects are admitted. All reparse tags except
`IO_REPARSE_TAG_SYMLINK` are rejected, including junctions, mount points,
AF_UNIX sockets, WSL links and cloud placeholders. Offline files are rejected.
Directory enumeration uses synchronous `NtQueryDirectoryFile` with a fixed-size
buffer and one entry at a time, not `std::fs::read_dir`.

Fresh files/directories are created with `FILE_CREATE` relative to the pinned
parent. Rename opens the source by handle and passes
[`FILE_RENAME_INFORMATION`](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/ns-ntifs-_file_rename_information)
to `NtSetInformationFile`: its destination `RootDirectory` is the pinned target
directory and `FileName` is only one component. Delete sets
[`FileDispositionInformation`](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntddk/ns-ntddk-_file_disposition_information)
on the opened leaf handle and closes it. No recursive deletion, ambient
rename/delete fallback, ACL mutation, or existing-file truncation is used.
Open/readonly targets and filesystem-specific replacement restrictions can
produce an error; permissions/attributes are not relaxed to force a replacement.

Symlink targets are read with `FSCTL_GET_REPARSE_POINT` from the nofollow handle,
using the exact UTF-16 PrintName and rejecting strings not representable as UTF-8.
New links use an exclusive, handle-relative file creation followed by
`FSCTL_SET_REPARSE_POINT`. They carry the guest target as an **inert string** in
a file-typed relative symlink; native directory-link typing and functional
cross-OS absolute-link resolution are not preserved. The reparse buffer is at
most 16 KiB. Creation enables `SeCreateSymbolicLinkPrivilege` only if the
process token already holds it; otherwise it fails. This does not change an ACL
or grant a privilege absent from the token. Developer Mode alone is not assumed
to authorize this native FSCTL path. Imports without new symlinks do not request
the privilege. Windows CI symlink tests require a suitably privileged token.

Names additionally reject Win32 reserved device names, ADS syntax, trailing dots
or spaces, invalid Win32 characters and components exceeding 255 UTF-16 units.
Known inode aliases, including case and short-name aliases, are rejected during
apply. Case-only renames are not implemented. Windows `mode` is informational
(`0755` for directories, `0644` otherwise); guest modes do not alter Windows
attributes or DACLs. Newly created objects use normal inherited security.

## Shared limitations and tests

No ACLs, ownership, xattrs, or existing file/directory permissions are edited.
On Unix, `mode` carries only the low nine permission bits, supplied at fresh inode
creation and restricted by umask/default inheritance. Mode-only edits are not
merged; existing directory modes are not changed. Replacements create new inodes
with normal parent permission/ACL inheritance, not copies of old ACLs. Symlink
mode is informational. Non-UTF-8 names/targets fail rather than being lossy.

Capability membership is **inode/handle based**, not a promise about current
ambient pathname ancestry: moving a pinned root or child directory does not
redirect operations to a replacement at its former path. It also does not revoke
access to that already authorized directory. The CLI tests verify this explicitly.
No guarantee is made against a malicious same-UID host process, privileged mount
changes, or independently modified operator directories.

This is not filesystem snapshot isolation or an atomic compare-and-swap. A host
writer can still change an entry between the final hash/check and rename/unlink;
portable capability APIs cannot atomically assert its content hash. Quiesce host
writers when that stronger conflict guarantee is required. Initial conflicts
cause no changes, but later I/O errors, late conflicts, nonempty directory
deletions or resulting-known-path read failures can leave earlier changes applied.
Crashes can leave reserved temporary names in host roots; recovery is an operator
task, and these names are rejected by subsequent scans instead of silently
exported. There is no crash-durable multi-file transaction or rollback.

CLI tests cover binary chunks, spaces/Unicode, baseline preservation, three-way
merging, explicit deletion, untracked children, hardlinks, devices/sockets, inert
outside symlinks, actual traversal denial, pinned root replacement, and repeated
concurrent directory/symlink swaps using a separate process (no spawned threads).
On Windows the shared CLI cases also run, alongside native cases for inert links,
junction and hardlink rejection, late untracked hardlinks/read-only baseline
preservation, root sharing-mode pinning, unchanged root DACLs, reserved names,
and concurrent directory/symlink replacement using a separate PowerShell process.
These tests are not replaced with an unsupported-platform assertion.
