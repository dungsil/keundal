# @keundal/plugin-sandbox-vm

Runs the complete Node execution host, its Cordis plugins, native Linux programs,
and Shell descendants inside a private x86_64 Linux QEMU VM. The host OS may be
Linux, Windows, or macOS; this is **not** a Windows/Darwin plugin runtime.

There is no network adapter, host filesystem mount, Docker socket, general host
command endpoint, or ordinary-process fallback. QEMU uses software TCG, so nested
virtualization is not required. Provision QEMU, qemu-img, the native file broker,
and trusted guest assets separately; application startup never installs them.

## Operator installation

Build the Rust broker on each host OS:

```sh
cargo build --release --locked --manifest-path packages/plugin-sandbox-vm/file-broker/Cargo.toml
pnpm exec turbo run build --filter=@keundal/plugin-sandbox-vm
```

Build the Linux image on Debian bookworm x64 with the repository's pinned Node
version, `linux-image-cloud-amd64`, `busybox-static`, `cpio`, `e2fsprogs`, `file`,
and `gzip`. Building inside the corresponding official Node bookworm container
avoids copying a host-specific Node/glibc runtime. CI's
[guest-image workflow](../../.github/workflows/sandbox-guest.yml) does this.

```sh
pnpm --filter @keundal/plugin-sandbox-vm build:image --output /operator/guest-assets --guest dist/guest/guest.js
```

Move `kernel`, `initramfs.cpio.gz`, and `manifest.json` together to the target
machine. Verify the recorded hashes when distributing them. Rebuild the image
after guest-controller or runtime changes. The builder refuses existing output
files. Treat all assets, QEMU, and the broker as trusted installed code, outside
every writable grant and unavailable for modification by plugins.

Create a private JSON file and set `KEUNDAL_SANDBOX_VM_CONFIG` to its absolute
path, in addition to `KEUNDAL_SANDBOX_CONFIG`:

```json
{
  "qemu": "/usr/bin/qemu-system-x86_64",
  "qemuImg": "/usr/bin/qemu-img",
  "kernel": "/operator/guest-assets/kernel",
  "initramfs": "/operator/guest-assets/initramfs.cpio.gz",
  "fileBroker": "/operator/bin/keundal-file-broker",
  "stateDirectory": "/operator/private-vm-state"
}
```

Use native absolute host paths on Windows, including `.exe` for executables.
The state directory must be private to the operator. It contains an 8 GiB sparse
qcow2 disk per canonical grant set and baseline metadata; the VM has 1 GiB RAM.
Never delete the state directory to resolve a failed export: it can contain the
only copy of generated files, sessions, and interrupted responses.

## Files, persistence, and conflicts

Startup imports fresh regular-file bytes using the
[capability-rooted native broker](file-broker/README.md). Hardlinks and special
files are rejected; symlinks are imported as inert symlink text. No host inode or
socket is shared with the guest. New host links/sockets published after import
remain invisible to the running workload and are not touched by export.

Grants must be existing, disjoint directories, not system/control/state paths.
Linux/macOS preserve their absolute grant paths inside the guest; Windows grants
map in policy order to `/workspaces/0`, `/workspaces/1`, etc. The workspace is root 0. The standard SQLite, plugin-config and managed-plugin environment paths are
translated; arbitrary absolute paths embedded in plugin data or commands are
not. Use relative, guest-compatible paths for portable configuration.

The worker runs as uid/gid 1000 with no-new-privileges. Root-owned guest control
files, serial transport, and the state block device are inaccessible to it. Before
export the controller terminates all uid-1000 processes, including detached Shell
descendants. Read-only grants remain read-only inside the VM.

Files are **not live-synchronized**. Host changes become visible at the next
startup; guest changes are exported on graceful disposal. A three-way hash merge
preserves changes made on only one side and rejects competing edits. Unknown
host entries are preserved. Export is not a multi-file transaction: a conflict
can leave earlier changes applied. Mode-only merges and entry-type replacements
are restricted; see the broker contract. Keep human editors quiescent during
import/export: content-hash checks are not an atomic compare-and-swap against
concurrent host writes. The host OS, operator and filesystem ancestors remain
trusted, not adversaries this VM can confine.

After parent termination the independent supervisor shuts down and exports the
VM; a disconnected serial link causes guest shutdown. Abrupt VM termination
retains the disk for filesystem recovery and the next merge. Recovery does not
automatically re-execute plugins' tools or LLM calls. Cold boot/import may take up
to 180 seconds, and safe shutdown/export up to 125 seconds; failures retain state
and never switch to unsandboxed execution.

## Networking and compatibility

Only two fixed serial channels reach parent-owned endpoints: HTTP/SSE and the
exact-host:port HTTP/CONNECT broker. The parent never opens a guest-supplied host
pathname. Host loopback, Unix sockets/named pipes, direct TCP/UDP and unrelated
processes are not exposed. Tool Approval cannot add VM capabilities. Plugins in
one VM still share the explicitly provided environment and provider credentials.

The minimal image includes Node and BusyBox, not git, Python, npm, or arbitrary
shared libraries. Provision additional trusted Linux tools in the guest image as
needed. Existing Cordis registration, service replacement and tool factories are
unchanged, but Windows/macOS binaries, native addons built for another OS/ABI,
GUI automation and host-native integrations do not become Linux-compatible.
The VM is a boundary, not a promise against QEMU/kernel vulnerabilities or an
untrusted host administrator. CPU time, process count, transfer volume and host
disk consumption have no per-job quota yet.

## Verification

The orb setup builds local assets and sets `KEUNDAL_TEST_VM_CONFIG`. Elsewhere:

```sh
node packages/plugin-sandbox-vm/scripts/configure-test.mjs /operator/guest-assets /private/test-vm.json
export KEUNDAL_TEST_VM_CONFIG=/private/test-vm.json
pnpm test
```

The real VM tests fail, rather than skip, when assets are missing. CI builds one
Linux image and runs native file-broker and real VM/plugin checks on Linux,
Windows and macOS. Scheduling a platform job is not evidence it passed; consult
the PR's actual results. The standalone live-bind Linux provider remains
available separately, with its documented host-publication assumptions; the
execution host never chooses it as a VM fallback.
