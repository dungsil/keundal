# Linux guest assets

Build on Linux x86_64 with the repository's pinned Node **24.22.1**, a matching
Debian cloud kernel/module installation, `busybox-static`, `e2fsprogs`, `cpio`,
`gzip`, `file`, `ldd`, and Bash. QEMU is needed for execution, not image creation.
The image has no host filesystem shares, guest NIC, host configuration files,
credentials, or package manager. The builder does not install dependencies or
download executables.

```sh
pnpm --filter @keundal/plugin-sandbox-vm build
node packages/plugin-sandbox-vm/scripts/build-image.mjs \
  --output /operator/keundal-linux-assets \
  --guest packages/plugin-sandbox-vm/dist/guest/guest.js \
  --kernel /boot/vmlinuz-6.1.0-54-cloud-amd64
```

The optional `--kernel` defaults to the newest installed `/boot/vmlinuz-*amd64`.
Its filename must identify the matching `/lib/modules/VERSION` directory.
Build as an ordinary user with read access to the installed kernel. If the
distribution protects `/boot`, have the operator copy the kernel to a readable
path retaining its `vmlinuz-VERSION` filename; do not run an untrusted build with
elevated privileges.

The output directory is operator-supplied. Existing `kernel`,
`initramfs.cpio.gz`, or `manifest.json` files are never overwritten. The manifest
records the Node/kernel versions, dependency-ordered module list, and SHA-256
digests of the installed kernel, initramfs, Node executable, and guest bundle.
Only Node, static BusyBox, filesystem tools, their `ldd` dependencies, required
virtio/ext4 kernel dependencies, and the guest's fixed boot files are copied.
Built-in kernel drivers are not duplicated. Compressed external kernel modules
are rejected; the tested Debian cloud installation uses uncompressed `.ko` files.

## Boot and persistence

The initramfs is the root filesystem. `/init` mounts proc/sysfs/devtmpfs and
private temporary filesystems, loads the minimal drivers, enables only
loopback, and discovers the virtio port by its **name**, not a device index.
The provider must expose `keundal.control`, a virtio block device at `/dev/vda`,
and use `console=null panic=1`; the normal console never carries the protocol.

Only an entirely zero-filled disk of at least 32 MiB is formatted. All other
non-ext4 disks fail closed. Existing ext4 disks run `e2fsck -p` before mounting;
an unrepaired error powers off without formatting. Initial zero verification
reads the complete virtual disk, so first boot is slower for larger disks.
An 8 GiB disk took approximately 74 seconds through the complete first-boot
lifecycle under x86_64 TCG in the development orb; allow at least 180 seconds
for cold-start validation on slower hosts. Verification/formatting diagnostics
are framed `stderr` messages and can precede the `boot` frame.
The root supervisor and raw control/disk devices are inaccessible to uid 1000.

PID 1 stages snapshots in a root-private directory on `/state`, checks content
hashes and three-way merge conflicts before application, then publishes files
by same-filesystem rename. A complete snapshot is not a multi-file filesystem
transaction: a VM crash during application can publish a subset of host changes.
The next import reconciles already-published content using the same hashes.
Unfinished private staging is discarded on the next configuration; persistent
guest roots are never cleared or recursively overwritten.

The worker runs `/usr/bin/node` with uid/gid 1000, no supplementary privilege,
and `no_new_privs`. Its private `/home/keundal` is backed by the state disk and
persists plugin state and Git worktrees without sharing the host home. Roots
must be disjoint absolute directories, must not cover
guest runtime/control paths, and may live below `/tmp` (but cannot replace
`/tmp` itself). Read-only roots receive read-only bind mounts before startup.
There is no guest package installation; only bundled Node, Git and BusyBox are
available, and imported executable bits never include setuid or setgid.

Shutdown terminates every uid-1000 process, including detached sessions, gives
TERM five seconds, then uses KILL before exporting writable roots. Symlinks are
inert strings; sockets are skipped; hardlinked files and non-file devices are
rejected. The complete export ends with `snapshot-end`; after unexpected worker
exit, `worker-exit` follows. PID 1 waits for `exported`, syncs/unmounts state,
then powers off. A control EOF terminates workloads and powers off without
waiting for an export acknowledgement. Host crashes must retain the private
qcow2 disk and baseline for the next import; never replace them to resolve a
merge conflict.

This small userspace includes BusyBox commands and Git's local built-in workspace
operations, but not Git transport helpers, CA certificates, DNS configuration,
native Node addons, or a general Linux toolchain. All host networking must pass through
the dedicated Unix-socket bridge; no virtual NIC or host share is needed.
