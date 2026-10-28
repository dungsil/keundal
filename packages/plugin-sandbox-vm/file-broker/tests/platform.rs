#![cfg(not(any(unix, windows)))]

#[test]
fn unsupported_platform_fails_before_config_or_input() {
    // 보안 검증을 마치지 않은 플랫폼은 설정이나 입력을 읽기 전에 거부한다.
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_keundal-file-broker"))
        .args(["apply", "nonexistent-private-config.json"])
        .stdin(std::process::Stdio::null())
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert_eq!(output.stderr, b"file broker failed (Unsupported)\n");
}
