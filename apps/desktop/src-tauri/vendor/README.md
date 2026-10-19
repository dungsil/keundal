# glib 0.18.5 보안 수정

Tauri 2의 GTK 3 의존성은 `glib 0.18`을 요구합니다. 이 버전 계열에는
RUSTSEC-2024-0429를 수정한 공식 릴리스가 없으므로 `glib 0.18.5`를 저장소에 포함합니다.
상위 GTK 의존성이 수정된 `glib`을 지원하면 이 사본과 `[patch.crates-io]` 설정을 제거합니다.

## 출처

- 원본: <https://static.crates.io/crates/glib/glib-0.18.5.crate>
- SHA-256: `233daaf6e83ae6a12a52055f568f9d7cf4671dabb78ff9560ab6da230ce00ee5`
- 원본 커밋: `42b9caf98e03ded086362d9653ca58fe94dc8658`
- 공식 수정: <https://github.com/gtk-rs/gtk-rs-core/pull/1343>
- 보안 권고: <https://rustsec.org/advisories/RUSTSEC-2024-0429.html>

원본의 `LICENSE`와 `COPYRIGHT`를 유지합니다. 패키지 버전도 `0.18.5`로 유지하며,
Cargo는 crates.io 사본 대신 이 로컬 사본을 사용합니다.

## 변경

`src/variant_iter.rs`의 `VariantStrIter::impl_get`에서 `p`를 가변 변수로 선언하고
`g_variant_get_child`에 `&mut p`를 전달합니다. 공식 수정의 두 줄을 그대로 적용하여
C 함수가 불변 참조를 통해 포인터를 변경하지 않도록 합니다.

같은 파일에 빈 문자열과 유니코드를 양방향으로 순회하는 회귀 테스트를 추가합니다.
그 밖의 원본 파일은 변경하지 않습니다.

## 검증

Linux에서 GLib 개발 라이브러리와 `pkg-config`를 설치한 뒤 저장소 루트에서 실행합니다.
최적화 빌드로 문자열 반복자의 기존 테스트를 실행합니다.

```sh
cargo test --release --manifest-path apps/desktop/src-tauri/vendor/glib-0.18.5/Cargo.toml --lib variant_iter::tests
cargo tree --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --target x86_64-unknown-linux-gnu -i glib
```

로컬 사본의 단독 검증이 생성한 `Cargo.lock`과 `target/`은 커밋하지 않습니다.
데스크톱 CI도 Linux에서 같은 반복자 테스트를 실행합니다.
