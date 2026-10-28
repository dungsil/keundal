# @keundal/plugin-sandbox-linux

`new LinuxSandboxProvider({ executable?: '/absolute/operator/bwrap' })` implements
`SandboxProvider`. The default executable is `/usr/bin/bwrap`; it is never found
through PATH. Missing bubblewrap, unsupported isolation flags, denied namespaces,
and mount errors fail closed. Listen for the returned child's `error` and nonzero
exit status. There is no fallback to ordinary execution.

The mount namespace starts empty. Existing `/usr`, `/bin`, `/lib`, and `/lib64`
directories are **authorized read-only runtime access**, including everything
installed beneath them. Do not store secrets in these runtime directories.
The resolved application executable is additionally bound read-only (not its
parent directory), allowing pnpm-managed Node binaries outside system paths.
`/proc` is a fresh PID-namespace procfs, `/dev` is bubblewrap's minimal device
filesystem, and `/tmp` and `/run` are private tmpfs mounts.

Workspace must be a canonical absolute directory. Additional grants resolve
symlinks and mount only the canonical target at that same absolute path: a grant
for a symlink to a file never grants its containing directory. Aliases outside
the workspace are not recreated. Pass canonical paths for application dependency
trees explicitly. Root-wide grants and mounts over isolation/runtime roots are
rejected, even through symlinks. Nested explicit writable grants can override
read-only grants; these permissions are operator policy, never tool approval.
Optional bridge mounts have canonical sources and distinct fixed targets:
`/run/keundal/worker.mjs` (regular file), `/run/keundal/api.sock`, and
`/run/keundal/network.sock` (Unix sockets). All are mandatory read-only mounts;
writable bridges, directories, duplicate targets, and other target names fail.
The child connects to parent-owned sockets; no writable host bridge directory
is exposed. A compromised child cannot replace the mounted socket entries.
Mount sources are pinned to verified descriptors before spawn, preventing
symlink replacement between validation and bubblewrap's mount setup. Bubblewrap
consumes and closes those descriptors; they are not application capabilities.
Grants still expose live files, not a transactional filesystem snapshot.

Before launch, grants are traversed without following child symlinks: special
files (including pathname Unix sockets) and multiply linked regular files are
rejected, including in read-only grants. This conservatively rejects internal
hardlinks too, including pnpm-linked dependency trees; deploy independent files.
Fixed runtime trees and the application executable are trusted read-only code
and may retain system/package-manager hardlinks. Runtime trees are also checked
for accessible special files. Inaccessible system directories not owned by the
host user remain inaccessible after dropping capabilities.

**Deployment boundary:** preflight is not race-safe against a host-side writer
introducing new inode/service authority during execution. The trusted operator
must prevent such publication for the lifetime of these live mounts; use a
dedicated copy/filesystem when the original workspace is shared with independent
host publishers. This provider does not isolate against malicious same-user or
privileged host processes. Do not deploy it as if it created a sanitized snapshot.
Writable grants cannot overlap `request.protectedPaths`, the provider module,
Node executable, or bubblewrap executable. The caller supplies its trusted parent
installation and policy paths and keeps any other parent-loaded code/config
outside writable grants. Never watch/reload trusted parent code from a writable
coding workspace.

Only `request.environment` is passed, plus fixed `HOME=/tmp` and
`PATH=/usr/bin:/bin` and bubblewrap's generated `PWD` (the workspace).
The bubblewrap process itself receives an empty environment.
The request's environment is operator-trusted, including loader-related settings.
The provider does not automatically merge `policy.environment` or implement
`allowedHosts`: network is entirely isolated. A parent-owned bridge must mediate
authorized network and HTTP access. Any socket or service exposed through the
bridge is itself an authority and must enforce the caller's policy.

## Linux CI

Install bubblewrap (`sudo apt-get update && sudo apt-get install -y bubblewrap`)
with support for `--disable-userns`, `--assert-userns-disabled`, `--bind-fd`, and
`--ro-bind-fd` (tested with bubblewrap 0.8.0, including `O_PATH` socket mounts). Enable
unprivileged user namespaces. On Ubuntu, AppArmor's unprivileged-user-namespace
restriction can deny bubblewrap: provision an appropriate bubblewrap AppArmor
profile on the runner (or use an appropriately isolated dedicated runner with
that restriction disabled). Containers additionally need permission to create
user/mount/PID/network/IPC/UTS namespaces. Security tests intentionally fail on
Linux when this provisioning is absent; they do not silently skip.

No seccomp syscall policy, resource quotas, disk quotas, or kernel exploit
protection is provided. Writable workspace/grants retain ordinary host-user
filesystem authority within the granted mounts. The caller must drain output,
handle launch errors, and impose execution/resource limits.
Killing bubblewrap kills the namespace, including detached/setsid descendants.
