#![cfg(any(unix, windows))]

use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Write;
#[cfg(unix)]
use std::os::unix::fs::{symlink, DirBuilderExt, MetadataExt, PermissionsExt};
#[cfg(unix)]
use std::os::unix::net::UnixListener;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

struct Fixture {
    _tmp: tempfile::TempDir,
    private: PathBuf,
    root: PathBuf,
    config: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        #[cfg(unix)]
        let tmp = tempfile::Builder::new()
            .permissions(fs::Permissions::from_mode(0o700))
            .tempdir()
            .unwrap();
        #[cfg(windows)]
        let tmp = tempfile::tempdir().unwrap();
        let private = tmp.path().canonicalize().unwrap();
        let root = private.join("host space 한글");
        fs::create_dir(&root).unwrap();
        let staging = private.join("staging");
        #[cfg(unix)]
        fs::DirBuilder::new().mode(0o700).create(&staging).unwrap();
        #[cfg(windows)]
        fs::create_dir(&staging).unwrap();
        let config = private.join("config.json");
        fs::write(
            &config,
            serde_json::to_vec(&json!({
                "roots": [{"id": 7, "path": root, "target": "/workspace", "writable": true}],
                "baseline": private.join("baseline.json"),
                "nextBaseline": private.join("next.json"), "staging": staging
            }))
            .unwrap(),
        )
        .unwrap();
        Self {
            _tmp: tmp,
            private,
            root,
            config,
        }
    }
    fn command(&self, operation: &str) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_keundal-file-broker"));
        command.arg(operation).arg(&self.config);
        command
    }
    fn run(&self, operation: &str, frames: &[Value]) -> Output {
        let mut child = self
            .command(operation)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        if operation == "apply" {
            let mut stdin = child.stdin.take().unwrap();
            for frame in frames {
                if serde_json::to_writer(&mut stdin, frame).is_err()
                    || stdin.write_all(b"\n").is_err()
                {
                    break;
                }
            }
        } else {
            drop(child.stdin.take());
        }
        child.wait_with_output().unwrap()
    }
    fn snapshot(&self) -> Vec<Value> {
        let output = self.run("snapshot", &[]);
        assert!(output.status.success(), "스냅샷 성공: {:?}", output.stderr);
        output
            .stdout
            .split(|c| *c == b'\n')
            .filter(|l| !l.is_empty())
            .map(|l| serde_json::from_slice(l).unwrap())
            .collect()
    }
    fn promote(&self) {
        fs::rename(
            self.private.join("next.json"),
            self.private.join("baseline.json"),
        )
        .unwrap();
    }
    fn apply(&self, mut frames: Vec<Value>) -> Output {
        frames.push(json!({"type":"snapshot-end"}));
        self.run("apply", &frames)
    }
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn file(path: &str, bytes: &[u8]) -> Vec<Value> {
    let mut frames = vec![
        json!({"type":"entry","root":7,"path":path,"kind":"file","mode":420,"baseHash":"untrusted"}),
    ];
    for chunk in bytes.chunks(65536) {
        frames.push(json!({"type":"chunk","data":STANDARD.encode(chunk)}));
    }
    frames.push(json!({"type":"file-end","hash":digest(bytes)}));
    frames
}
fn delete(path: &str) -> Value {
    json!({"type":"delete","root":7,"path":path,"baseHash":null})
}
fn directory(path: &str) -> Value {
    json!({"type":"entry","root":7,"path":path,"kind":"directory","mode":493})
}
fn link(path: &str, target: &Path) -> Value {
    json!({"type":"entry","root":7,"path":path,"kind":"symlink","mode":511,"target":target})
}

#[test]
fn binary_unicode_roundtrip_and_baseline() {
    // 공백·한글 경로와 바이너리를 청크로 보존하고 기준 파일을 별도로 기록한다.
    let f = Fixture::new();
    fs::create_dir(f.root.join("한글 폴더")).unwrap();
    let bytes: Vec<u8> = (0..200_000).map(|n| (n % 256) as u8).collect();
    fs::write(f.root.join("한글 폴더/원본.bin"), &bytes).unwrap();
    let frames = f.snapshot();
    assert!(frames.iter().any(|v| v["type"] == "entry"
        && v["path"] == "한글 폴더/원본.bin"
        && v["baseHash"].is_null()));
    let decoded: Vec<_> = frames
        .iter()
        .filter(|v| v["type"] == "chunk")
        .flat_map(|v| {
            let part = STANDARD.decode(v["data"].as_str().unwrap()).unwrap();
            assert!(part.len() <= 65536, "청크 크기 제한");
            part
        })
        .collect();
    assert_eq!(decoded, bytes);
    assert!(!f.private.join("baseline.json").exists());
    f.promote();
    let baseline_before = fs::read(f.private.join("baseline.json")).unwrap();
    let edited = [0, 255, 0, 1, 127];
    let mut export = file("한글 폴더/원본.bin", &edited);
    export.push(directory("한글 폴더"));
    assert!(f.apply(export).status.success());
    assert_eq!(fs::read(f.root.join("한글 폴더/원본.bin")).unwrap(), edited);
    assert_eq!(
        fs::read(f.private.join("baseline.json")).unwrap(),
        baseline_before
    );
    let next: Value =
        serde_json::from_slice(&fs::read(f.private.join("next.json")).unwrap()).unwrap();
    assert_eq!(next["version"], 1);
    assert!(next["entries"]
        .as_array()
        .unwrap()
        .iter()
        .any(|v| v["path"] == "한글 폴더/원본.bin" && v["hash"] == digest(&edited)));
}

#[test]
fn conflict_and_three_way_merge() {
    // 양쪽 변경은 충돌하고, 게스트 미변경이면 호스트 변경을 유지한다.
    let f = Fixture::new();
    fs::write(f.root.join("a"), b"base").unwrap();
    f.snapshot();
    f.promote();
    fs::write(f.root.join("a"), b"host").unwrap();
    assert!(!f.apply(file("a", b"guest")).status.success());
    assert_eq!(fs::read(f.root.join("a")).unwrap(), b"host");
    assert!(!f.private.join("next.json").exists());
    assert!(f.apply(file("a", b"base")).status.success());
    assert_eq!(fs::read(f.root.join("a")).unwrap(), b"host");
    assert!(f.apply(file("a", b"host")).status.success());
    assert!(!f.apply(vec![delete("a")]).status.success());
    fs::write(f.root.join("a"), b"base").unwrap();
    assert!(f.apply(vec![delete("a")]).status.success());
    assert!(!f.root.join("a").exists());
}

#[test]
fn host_only_edit_reaches_guest_on_the_next_lifecycle() {
    // 호스트만 바뀌면 게스트의 이전 값을 조상으로 유지하여 다음 가져오기에서 변경을 전달한다.
    let f = Fixture::new();
    fs::write(f.root.join("a"), b"A").unwrap();
    f.snapshot();
    f.promote(); // Guest acknowledged importing A.
    fs::write(f.root.join("a"), b"B").unwrap();
    assert!(f.apply(file("a", b"A")).status.success());
    assert_eq!(fs::read(f.root.join("a")).unwrap(), b"B");
    let next: Value =
        serde_json::from_slice(&fs::read(f.private.join("next.json")).unwrap()).unwrap();
    assert_eq!(
        next["entries"][0]["hash"],
        digest(b"A"),
        "조상은 호스트 B가 아닌 게스트 A"
    );
    f.promote();
    let snapshot = f.snapshot();
    let entry = snapshot
        .iter()
        .find(|frame| frame["type"] == "entry")
        .unwrap();
    assert_eq!(entry["path"], "a");
    assert_eq!(
        entry["baseHash"],
        digest(b"A"),
        "다음 가져오기는 게스트 A와 비교함"
    );
    assert!(snapshot
        .iter()
        .any(|frame| frame["type"] == "file-end" && frame["hash"] == digest(b"B")));
    // The guest's A matches baseHash A, so import replaces it with incoming B.
    // Re-export that exact snapshot after its acknowledgement/baseline promotion.
    f.promote();
    let output = f.run("apply", &snapshot);
    assert!(
        output.status.success(),
        "두 번째 수명 주기 반영: {:?}",
        output.stderr
    );
    assert_eq!(fs::read(f.root.join("a")).unwrap(), b"B");
}

#[test]
fn host_only_deletion_reaches_guest_on_the_next_lifecycle() {
    // 호스트에서만 삭제된 파일과 디렉터리를 게스트 조상에 유지하여 다음 실행에서 부활시키지 않는다.
    let f = Fixture::new();
    fs::create_dir(f.root.join("d")).unwrap();
    fs::write(f.root.join("d/a"), b"A").unwrap();
    f.snapshot();
    f.promote();
    fs::remove_file(f.root.join("d/a")).unwrap();
    fs::remove_dir(f.root.join("d")).unwrap();
    let mut export = file("d/a", b"A");
    export.push(directory("d"));
    assert!(f.apply(export).status.success());
    assert!(!f.root.join("d").exists());
    let next: Value =
        serde_json::from_slice(&fs::read(f.private.join("next.json")).unwrap()).unwrap();
    let entries = next["entries"].as_array().unwrap();
    assert_eq!(
        entries.len(),
        2,
        "호스트 삭제와 무관하게 게스트 스냅샷을 기록함"
    );
    assert!(entries
        .iter()
        .any(|entry| entry["path"] == "d/a" && entry["hash"] == digest(b"A")));
    assert!(entries.iter().any(|entry| entry["path"] == "d"
        && entry["kind"] == "directory"
        && entry["hash"].is_null()));
    f.promote();
    let snapshot = f.snapshot();
    assert!(snapshot.iter().any(|frame| frame["type"] == "delete"
        && frame["path"] == "d/a"
        && frame["baseHash"] == digest(b"A")));
    assert!(snapshot.iter().any(|frame| frame["type"] == "delete"
        && frame["path"] == "d"
        && frame["baseHash"].is_null()));
    // Guest A still matches the ancestor, so the acknowledged import removes it.
    f.promote();
    assert!(f.apply(vec![]).status.success());
    assert!(!f.root.join("d").exists());
    let next: Value =
        serde_json::from_slice(&fs::read(f.private.join("next.json")).unwrap()).unwrap();
    assert!(next["entries"].as_array().unwrap().is_empty());
}

#[test]
fn deletion_only_tracks_baseline_and_empty_directories() {
    // 추적된 파일만 삭제하며, 추적되지 않은 파일이 있는 디렉터리는 보존한다.
    let f = Fixture::new();
    fs::create_dir(f.root.join("d")).unwrap();
    fs::write(f.root.join("d/tracked"), b"old").unwrap();
    f.snapshot();
    f.promote();
    fs::write(f.root.join("d/untracked"), b"safe").unwrap();
    assert!(!f.apply(vec![delete("d/untracked")]).status.success());
    assert!(!f.apply(vec![delete("d")]).status.success());
    assert_eq!(fs::read(f.root.join("d/untracked")).unwrap(), b"safe");
    fs::remove_file(f.root.join("d/untracked")).unwrap();
    assert!(f
        .apply(vec![delete("d"), delete("d/tracked")])
        .status
        .success());
    assert!(!f.root.join("d").exists());
    let frames = f.snapshot();
    assert_eq!(frames.iter().filter(|v| v["type"] == "delete").count(), 2);
    // A missing host parent is already deleted; importing the same deletion is harmless.
    assert!(f.apply(vec![delete("d/tracked")]).status.success());
}

#[test]
#[cfg(unix)]
fn symlinks_are_inert_and_traversal_is_denied() {
    // 외부 소켓 링크를 문자열로 보존하고, 중간 링크를 통과하는 읽기·쓰기를 거부한다.
    let f = Fixture::new();
    let outside = f.private.join("outside");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("secret"), b"OUTSIDE SECRET").unwrap();
    let _socket = UnixListener::bind(outside.join("socket")).unwrap();
    symlink(&outside, f.root.join("escape")).unwrap();
    symlink(outside.join("socket"), f.root.join("socket-link")).unwrap();
    let frames = f.snapshot();
    assert_eq!(frames.iter().filter(|v| v["kind"] == "symlink").count(), 2);
    assert!(!frames.iter().any(|v| v["type"] == "chunk"));
    assert!(!f.apply(file("escape/secret", b"BAD")).status.success());
    assert_eq!(fs::read(outside.join("secret")).unwrap(), b"OUTSIDE SECRET");
    f.promote();
    assert!(f
        .apply(vec![
            link("new-link", &outside.join("secret")),
            link("escape", &outside),
            link("socket-link", &outside.join("socket"))
        ])
        .status
        .success());
    assert_eq!(
        fs::read_link(f.root.join("new-link")).unwrap(),
        outside.join("secret")
    );
    // A final symlink is replaced, never opened for writing.
    let mut export = file("escape", b"ordinary file");
    export.push(link("socket-link", &outside.join("socket")));
    export.push(link("new-link", &outside.join("secret")));
    assert!(f.apply(export).status.success());
    assert_eq!(fs::read(outside.join("secret")).unwrap(), b"OUTSIDE SECRET");
}

#[test]
#[cfg(unix)]
fn hardlinks_sockets_and_devices_fail_closed() {
    // 하드링크·소켓·장치 파일을 거부하고 외부 inode의 내용은 바꾸지 않는다.
    let f = Fixture::new();
    let outside = f.private.join("external");
    fs::write(&outside, b"safe").unwrap();
    let ino = fs::metadata(&outside).unwrap().ino();
    fs::hard_link(&outside, f.root.join("hard")).unwrap();
    assert!(!f.run("snapshot", &[]).status.success());
    assert!(!f.apply(file("hard", b"bad")).status.success());
    assert_eq!(fs::metadata(&outside).unwrap().ino(), ino);
    assert_eq!(fs::read(&outside).unwrap(), b"safe");
    fs::remove_file(f.root.join("hard")).unwrap();
    let socket = UnixListener::bind(f.root.join("socket")).unwrap();
    assert!(!f.run("snapshot", &[]).status.success());
    assert!(!f.apply(file("socket", b"bad")).status.success());
    drop(socket);
    fs::remove_file(f.root.join("socket")).unwrap();
    // /dev/null is accessed only as a configured test root, never copied into the fixture.
    let mut config: Value = serde_json::from_slice(&fs::read(&f.config).unwrap()).unwrap();
    config["roots"][0]["path"] = json!("/dev");
    fs::write(&f.config, serde_json::to_vec(&config).unwrap()).unwrap();
    assert!(!f.run("snapshot", &[]).status.success());
    assert!(!f.apply(file("null", b"bad")).status.success());
}

#[test]
fn validates_all_frames_before_mutating_host() {
    // 잘못된 경로·중복·해시·읽기 전용 루트는 호스트를 변경하기 전에 거부한다.
    let f = Fixture::new();
    for path in [
        "../escape",
        "/absolute",
        "a/../escape",
        "a\\b",
        "a//b",
        "./a",
        "C:/escape",
        "",
        "a/",
    ] {
        assert!(
            !f.apply(file(path, b"bad")).status.success(),
            "거부할 경로: {path}"
        );
    }
    let mut frames = file("a", b"good");
    frames.extend(file("a", b"duplicate"));
    assert!(!f.apply(frames).status.success());
    let mut frames = file("a", b"good");
    frames[2]["hash"] = json!("0".repeat(64));
    assert!(!f.apply(frames).status.success());
    let mut frames = file("a", b"good");
    frames.extend(file("b", &vec![1; 65537]));
    frames[4]["data"] = json!(STANDARD.encode(vec![1; 65537]));
    assert!(!f.apply(frames).status.success());
    assert!(!f.root.join("a").exists());
    assert!(fs::read_dir(f.private.join("staging"))
        .unwrap()
        .next()
        .is_none());
    let mut config: Value = serde_json::from_slice(&fs::read(&f.config).unwrap()).unwrap();
    config["roots"][0]["writable"] = json!(false);
    fs::write(&f.config, serde_json::to_vec(&config).unwrap()).unwrap();
    assert!(!f.apply(file("a", b"bad")).status.success());
    assert!(f.run("snapshot", &[]).status.success());
}

#[test]
fn creates_parents_and_rejects_operator_paths_inside_root() {
    // 부모 디렉터리를 먼저 만들며 기준 파일을 호스트 루트 안에 두지 않는다.
    let f = Fixture::new();
    let mut frames = file("a/b", b"new");
    frames.push(directory("a"));
    assert!(f.apply(frames).status.success());
    assert_eq!(fs::read(f.root.join("a/b")).unwrap(), b"new");
    let mut config: Value = serde_json::from_slice(&fs::read(&f.config).unwrap()).unwrap();
    config["nextBaseline"] = json!(f.root.join("private.json"));
    fs::write(&f.config, serde_json::to_vec(&config).unwrap()).unwrap();
    assert!(!f.run("snapshot", &[]).status.success());
}

#[test]
#[cfg(unix)]
fn late_host_capabilities_stay_unobserved_and_readonly_baseline_is_preserved() {
    // 스냅샷 이후 생긴 하드링크·소켓은 읽지 않으며 읽기 전용 기준을 유지한다.
    let f = Fixture::new();
    let readonly = f.private.join("readonly");
    fs::create_dir(&readonly).unwrap();
    fs::write(readonly.join("reference"), b"reference baseline").unwrap();
    fs::write(f.root.join("a"), b"base").unwrap();
    let mut config: Value = serde_json::from_slice(&fs::read(&f.config).unwrap()).unwrap();
    config["roots"]
        .as_array_mut()
        .unwrap()
        .push(json!({"id":9,"path":readonly,"target":"/reference","writable":false}));
    fs::write(&f.config, serde_json::to_vec(&config).unwrap()).unwrap();
    f.snapshot();
    f.promote();
    let external = f.private.join("outside-secret");
    fs::write(&external, b"do not expose").unwrap();
    let inode = fs::metadata(&external).unwrap().ino();
    fs::hard_link(&external, f.root.join("late-link")).unwrap();
    let socket = UnixListener::bind(f.root.join("late.sock")).unwrap();
    fs::write(f.root.join("late-plain"), b"not guest-visible").unwrap();
    fs::remove_file(readonly.join("reference")).unwrap();
    fs::hard_link(&external, readonly.join("reference")).unwrap();
    let mut export = file("a", b"guest output");
    export.extend(file("new output", b"new"));
    let result = f.apply(export);
    assert!(
        result.status.success(),
        "알려진 파일만 반영: {:?}",
        result.stderr
    );
    let next: Value =
        serde_json::from_slice(&fs::read(f.private.join("next.json")).unwrap()).unwrap();
    let entries = next["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 3);
    assert!(entries
        .iter()
        .any(|v| v["root"] == 9 && v["hash"] == digest(b"reference baseline")));
    assert!(!entries.iter().any(|v| v["path"] == "late-link"
        || v["path"] == "late.sock"
        || v["path"] == "late-plain"));
    assert_eq!(fs::metadata(f.root.join("late-link")).unwrap().ino(), inode);
    assert_eq!(fs::read(&external).unwrap(), b"do not expose");
    let mut export = file("a", b"guest output");
    export.extend(file("late-link", b"bad"));
    assert!(!f.apply(export).status.success());
    assert_eq!(fs::read(&external).unwrap(), b"do not expose");
    drop(socket);
}

#[test]
fn full_export_omissions_delete_only_writable_tracked_paths() {
    // 전체 내보내기에서 빠진 쓰기 가능한 추적 경로만 삭제한다.
    let f = Fixture::new();
    fs::write(f.root.join("removed"), b"old").unwrap();
    f.snapshot();
    f.promote();
    fs::write(f.root.join("untracked"), b"keep").unwrap();
    assert!(f.apply(vec![]).status.success());
    assert!(!f.root.join("removed").exists());
    assert_eq!(fs::read(f.root.join("untracked")).unwrap(), b"keep");
    let next: Value =
        serde_json::from_slice(&fs::read(f.private.join("next.json")).unwrap()).unwrap();
    assert!(next["entries"].as_array().unwrap().is_empty());
}

#[test]
fn case_aliases_fail_closed_without_deleting_the_tracked_file() {
    // 대소문자 별칭은 기존 파일을 삭제하기 전에 거부하며 별개 inode는 허용한다.
    let f = Fixture::new();
    fs::write(f.root.join("name"), b"base").unwrap();
    let aliases = f.root.join("NAME").exists();
    f.snapshot();
    f.promote();
    if aliases {
        assert!(!f.apply(file("NAME", b"base")).status.success());
        assert_eq!(fs::read(f.root.join("name")).unwrap(), b"base");
    } else {
        let mut export = file("name", b"base");
        export.extend(file("NAME", b"distinct"));
        assert!(f.apply(export).status.success());
        assert_eq!(fs::read(f.root.join("name")).unwrap(), b"base");
        assert_eq!(fs::read(f.root.join("NAME")).unwrap(), b"distinct");
    }
}

#[test]
#[cfg(unix)]
fn pinned_root_survives_path_replacement() {
    // 루트 경로가 링크로 바뀌어도 이미 연 핸들을 유지하고 대체 경로로 쓰지 않는다.
    let f = Fixture::new();
    let outside = f.private.join("outside");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("a"), b"safe").unwrap();
    let mut child = f
        .command("apply")
        .stdin(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        // Spooling starts only after configuration and all root handles have been opened.
        let pinned = fs::read_dir(f.private.join("staging"))
            .unwrap()
            .next()
            .is_some();
        if pinned {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "루트 핸들 열기 시간 제한"
        );
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
    let pinned = f.private.join("renamed-root");
    fs::rename(&f.root, &pinned).unwrap();
    symlink(&outside, &f.root).unwrap();
    let mut frames = file("a", b"new");
    frames.push(json!({"type":"snapshot-end"}));
    let mut stdin = child.stdin.take().unwrap();
    for frame in frames {
        writeln!(stdin, "{frame}").unwrap();
    }
    drop(stdin);
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "고정된 루트에서 완료: {:?}",
        output.stderr
    );
    assert_eq!(fs::read(pinned.join("a")).unwrap(), b"new");
    assert_eq!(fs::read(outside.join("a")).unwrap(), b"safe");
}

#[test]
#[cfg(unix)]
fn concurrent_directory_symlink_replacement_never_follows_outside() {
    // 별도 프로세스가 중간 디렉터리를 링크로 교체해도 외부 파일을 읽거나 바꾸지 않는다.
    let f = Fixture::new();
    let outside = f.private.join("outside");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("payload"), b"OUTSIDE-DO-NOT-READ").unwrap();
    fs::create_dir(f.root.join("a")).unwrap();
    let stop = f.private.join("stop");
    let mut racer = Command::new("sh")
        .arg("-c")
        .arg(
            r#"
        while [ ! -e "$3" ]; do
            mv "$1/a" "$1/holding" || exit 1
            ln -s "$2" "$1/a" || exit 1
            rm "$1/a" || exit 1
            mv "$1/holding" "$1/a" || exit 1
        done
    "#,
        )
        .arg("race")
        .arg(&f.root)
        .arg(&outside)
        .arg(&stop)
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    for _ in 0..30 {
        let snapshot = f.run("snapshot", &[]);
        let encoded = STANDARD.encode(b"OUTSIDE-DO-NOT-READ");
        assert!(!String::from_utf8_lossy(&snapshot.stdout).contains(&encoded));
        f.apply(file("a/payload", b"inside")); // Races may safely fail nonzero.
        assert_eq!(
            fs::read(outside.join("payload")).unwrap(),
            b"OUTSIDE-DO-NOT-READ"
        );
    }
    fs::write(&stop, []).unwrap();
    assert!(racer.wait().unwrap().success());
    assert_eq!(
        fs::read(outside.join("payload")).unwrap(),
        b"OUTSIDE-DO-NOT-READ"
    );
}

#[test]
#[cfg(windows)]
fn windows_symlinks_junctions_and_hardlinks_never_expose_outside() {
    // 심볼릭 링크는 문자열로만 내보내며 junction·하드링크와 중간 링크 쓰기를 거부한다.
    use std::os::windows::fs::{symlink_dir, symlink_file};
    let f = Fixture::new();
    let outside = f.private.join("outside");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("secret"), b"OUTSIDE SECRET").unwrap();
    symlink_dir(&outside, f.root.join("escape")).expect("Windows CI requires symlink privilege");
    symlink_file(outside.join("secret"), f.root.join("leaf")).unwrap();
    let frames = f.snapshot();
    assert_eq!(frames.iter().filter(|v| v["kind"] == "symlink").count(), 2);
    assert!(!frames.iter().any(|v| v["type"] == "chunk"));
    f.promote();
    assert!(!f.apply(file("escape/secret", b"BAD")).status.success());
    let mut export = file("leaf", b"ordinary replacement");
    export.push(link("escape", &outside));
    export.push(link("inert", Path::new("../outside/secret")));
    let output = f.apply(export);
    assert!(
        output.status.success(),
        "핸들 상대 symlink 생성: {:?}",
        output.stderr
    );
    assert_eq!(
        fs::read_link(f.root.join("inert")).unwrap(),
        Path::new("../outside/secret")
    );
    assert_eq!(fs::read(outside.join("secret")).unwrap(), b"OUTSIDE SECRET");
    fs::hard_link(outside.join("secret"), f.root.join("hard")).unwrap();
    assert!(!f.run("snapshot", &[]).status.success());
    assert!(!f.apply(file("hard", b"BAD")).status.success());
    fs::remove_file(f.root.join("hard")).unwrap();
    let status = Command::new("cmd.exe")
        .args(["/d", "/c", "mklink", "/J"])
        .arg(f.root.join("junction"))
        .arg(&outside)
        .output()
        .unwrap();
    assert!(status.status.success(), "junction 생성");
    assert!(!f.run("snapshot", &[]).status.success());
    assert!(!f.apply(file("junction/secret", b"BAD")).status.success());
    fs::remove_dir(f.root.join("junction")).unwrap();
    assert_eq!(fs::read(outside.join("secret")).unwrap(), b"OUTSIDE SECRET");
}

#[test]
#[cfg(windows)]
fn windows_late_untracked_hardlinks_and_readonly_entries_are_not_read() {
    // 늦게 생긴 하드링크는 일반 내보내기를 막지 않으며 읽기 전용 기준도 다시 읽지 않는다.
    let f = Fixture::new();
    let readonly = f.private.join("readonly");
    fs::create_dir(&readonly).unwrap();
    fs::write(readonly.join("reference"), b"reference baseline").unwrap();
    fs::write(f.root.join("a"), b"base").unwrap();
    let mut config: Value = serde_json::from_slice(&fs::read(&f.config).unwrap()).unwrap();
    config["roots"]
        .as_array_mut()
        .unwrap()
        .push(json!({"id":9,"path":readonly,"writable":false}));
    fs::write(&f.config, serde_json::to_vec(&config).unwrap()).unwrap();
    f.snapshot();
    f.promote();
    let external = f.private.join("outside-secret");
    fs::write(&external, b"do not expose").unwrap();
    fs::hard_link(&external, f.root.join("late-link")).unwrap();
    fs::remove_file(readonly.join("reference")).unwrap();
    fs::hard_link(&external, readonly.join("reference")).unwrap();
    let output = f.apply(file("a", b"guest output"));
    assert!(
        output.status.success(),
        "알려진 경로만 반영: {:?}",
        output.stderr
    );
    let next: Value =
        serde_json::from_slice(&fs::read(f.private.join("next.json")).unwrap()).unwrap();
    let entries = next["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 2);
    assert!(entries
        .iter()
        .any(|v| v["root"] == 9 && v["hash"] == digest(b"reference baseline")));
    assert!(!entries.iter().any(|v| v["path"] == "late-link"));
    let mut export = file("a", b"guest output");
    export.extend(file("late-link", b"BAD"));
    assert!(!f.apply(export).status.success());
    assert_eq!(fs::read(&external).unwrap(), b"do not expose");
    assert!(f.root.join("late-link").exists());
}

#[test]
#[cfg(windows)]
fn windows_pinned_root_denies_replacement_and_preserves_acl() {
    // 열린 루트의 이름 교체를 차단하고 ACL을 수정하지 않은 채 새 파일을 반영한다.
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Security::{GetFileSecurityW, DACL_SECURITY_INFORMATION};
    let acl = |path: &Path| {
        let path: Vec<_> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        let mut size = 0;
        unsafe {
            GetFileSecurityW(
                path.as_ptr(),
                DACL_SECURITY_INFORMATION,
                std::ptr::null_mut(),
                0,
                &mut size,
            );
        }
        assert!(size > 0);
        let mut bytes = vec![0u8; size as usize];
        assert_ne!(
            unsafe {
                GetFileSecurityW(
                    path.as_ptr(),
                    DACL_SECURITY_INFORMATION,
                    bytes.as_mut_ptr().cast(),
                    size,
                    &mut size,
                )
            },
            0
        );
        bytes
    };
    let f = Fixture::new();
    let before = acl(&f.root);
    let mut child = f
        .command("apply")
        .stdin(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while fs::read_dir(f.private.join("staging"))
        .unwrap()
        .next()
        .is_none()
    {
        assert!(
            std::time::Instant::now() < deadline,
            "루트 핸들 대기 시간 제한"
        );
        assert!(
            child.try_wait().unwrap().is_none(),
            "루트를 열기 전에 종료하지 않음"
        );
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
    assert!(
        fs::rename(&f.root, f.private.join("moved")).is_err(),
        "공유 삭제 권한 없는 루트 핸들"
    );
    let mut stdin = child.stdin.take().unwrap();
    for frame in file("a", b"new")
        .into_iter()
        .chain([json!({"type":"snapshot-end"})])
    {
        writeln!(stdin, "{frame}").unwrap();
    }
    drop(stdin);
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "고정된 루트 반영: {:?}",
        output.stderr
    );
    assert_eq!(fs::read(f.root.join("a")).unwrap(), b"new");
    assert_eq!(acl(&f.root), before);
}

#[test]
#[cfg(windows)]
fn windows_ambiguous_names_are_rejected_before_writes() {
    // ADS·장치 이름·마지막 점과 공백은 NT 경로 변형을 만들기 전에 거부한다.
    let f = Fixture::new();
    for path in [
        "a:stream",
        "NUL",
        "CON.txt",
        "COM1",
        "LPT².log",
        "name.",
        "name ",
        "dir./child",
    ] {
        assert!(
            !f.apply(file(path, b"BAD")).status.success(),
            "거부할 경로: {path}"
        );
    }
    assert!(fs::read_dir(&f.root).unwrap().next().is_none());
}

#[test]
#[cfg(windows)]
fn windows_concurrent_directory_symlink_swap_never_reads_or_writes_outside() {
    // 별도 프로세스의 디렉터리·링크 교체와 경합해도 외부 내용을 읽거나 바꾸지 않는다.
    let f = Fixture::new();
    let outside = f.private.join("outside");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("payload"), b"OUTSIDE-DO-NOT-READ").unwrap();
    fs::create_dir(f.root.join("a")).unwrap();
    let stop = f.private.join("stop");
    let ready = f.private.join("racer-ready");
    // Windows PowerShell's filesystem provider does not consistently accept
    // extended-length prefixes. The broker config still uses canonical paths.
    let shell_path = |path: &Path| {
        path.to_str()
            .unwrap()
            .trim_start_matches(r"\\?\")
            .to_owned()
    };
    let mut racer = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            r#"
        $ErrorActionPreference = 'Stop'
        $a = Join-Path $env:BROKER_RACE_ROOT 'a'
        $holding = Join-Path $env:BROKER_RACE_ROOT 'holding'
        $deadline = [DateTime]::UtcNow.AddSeconds(60)
        while (!(Test-Path -LiteralPath $env:BROKER_RACE_STOP) -and [DateTime]::UtcNow -lt $deadline) {
            try { [System.IO.Directory]::Move($a, $holding) } catch { continue }
            $linked = $false
            try {
                New-Item -ItemType SymbolicLink -Path $a -Target $env:BROKER_RACE_OUTSIDE | Out-Null
                $linked = $true
                [System.IO.File]::WriteAllText($env:BROKER_RACE_READY, 'ready')
            } finally {
                if ($linked) {
                    while ($true) {
                        try { [System.IO.Directory]::Delete($a); break }
                        catch { if ([DateTime]::UtcNow -ge $deadline) { throw }; Start-Sleep -Milliseconds 1 }
                    }
                }
                while ($true) {
                    try { [System.IO.Directory]::Move($holding, $a); break }
                    catch { if ([DateTime]::UtcNow -ge $deadline) { throw }; Start-Sleep -Milliseconds 1 }
                }
            }
        }
        "#,
        ])
        .env("BROKER_RACE_ROOT", shell_path(&f.root))
        .env("BROKER_RACE_OUTSIDE", shell_path(&outside))
        .env("BROKER_RACE_STOP", shell_path(&stop))
        .env("BROKER_RACE_READY", shell_path(&ready))
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
    while !ready.exists() {
        assert!(
            std::time::Instant::now() < deadline,
            "교체 프로세스 준비 시간 제한"
        );
        assert!(
            racer.try_wait().unwrap().is_none(),
            "교체 프로세스가 실행 중임"
        );
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    for _ in 0..30 {
        let snapshot = f.run("snapshot", &[]);
        assert!(!String::from_utf8_lossy(&snapshot.stdout)
            .contains(&STANDARD.encode(b"OUTSIDE-DO-NOT-READ")));
        f.apply(file("a/payload", b"inside"));
        assert_eq!(
            fs::read(outside.join("payload")).unwrap(),
            b"OUTSIDE-DO-NOT-READ"
        );
    }
    fs::write(&stop, []).unwrap();
    assert!(racer.wait_with_output().unwrap().status.success());
    assert_eq!(
        fs::read(outside.join("payload")).unwrap(),
        b"OUTSIDE-DO-NOT-READ"
    );
}
