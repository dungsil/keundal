# CI 구성과 검토 근거

## 측정한 병목

2026년 10월 21일에 최근 성공한 CI 세 건의 작업과 단계별 시간을 GitHub API로 조회했다.
아래 시간은 변경 전 기록이며, 대기열과 캐시 상태에 따라 달라진다.

| 실행 기록                                                                  | 전체 소요 시간 | 선행 웹 빌드 작업 | Windows 빌드 단계 | Windows 환경 준비 |
| -------------------------------------------------------------------------- | -------------- | ----------------- | ----------------- | ----------------- |
| [39448225823](https://github.com/dungsil/keundal/actions/runs/39448225823) | 10분 12초      | 2분 40초          | 5분 3초           | 1분 12초          |
| [39446693483](https://github.com/dungsil/keundal/actions/runs/39446693483) | 10분 58초      | 2분 13초          | 5분 15초          | 1분 34초          |
| [39444320253](https://github.com/dungsil/keundal/actions/runs/39444320253) | 10분 59초      | 2분               | 6분 17초          | 1분 29초          |

- 데스크톱 작업은 웹 빌드의 산출물을 받지 않으면서도 `needs: build` 때문에 시작이 늦었다.
- `pnpm build`는 웹 Node 서버와 데스크톱 UI를 모두 빌드했다. 타입 검사에서도 같은 전체 빌드를 반복했다.
- 데스크톱의 `pnpm build:preview`는 웹의 Workers 빌드까지 실행했다. Tauri는 별도로 `beforeBuildCommand`를 통해 데스크톱 UI를 생성했다.
- Windows 로그에는 pnpm 저장소 캐시가 적중해도 공급망 정책 검증을 위해 레지스트리를 다시 조회하는 요청이 남았다.
- 공통 설치 액션이 캐시 저장 여부를 작업 이름으로 판단했다. pnpm·Node·캐시 준비를 각각 호출했고, pnpm 검증 캐시를 직접 관리하지 못했다.

새 구성은 위 중복과 직렬 의존을 제거한다. 실제 단축 시간은 변경 후 GitHub 실행에서 다시 측정해야 한다.
Windows 네이티브 컴파일과 패키징은 여전히 수행하므로, 이 단계의 시간이 모두 사라지는 것은 아니다.

## 실행 계약

`CI`라는 워크플로 이름과 Ruleset이 요구하는 `빌드`, `타입 검사`, `테스트`, `린트 및 형식 검사` 이름을 유지한다.
CodeQL의 언어와 category도 유지하여 기존 main 분석 및 주간 감사와 연결한다.

| 작업              | 수행 내용                                                                                                                                                                                                                                 |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 변경사항 확인     | PR의 변경 파일을 `dorny/paths-filter`로 조회한다. 루트 안내 문서·패키지 README·`docs/`의 Markdown만 바뀐 PR은 무거운 빌드·타입 검사·테스트를 생략한다. 새 설정 파일과 앱이 사용하는 Markdown을 놓치지 않도록 나머지 모든 경로를 포함한다. |
| 빌드              | `re-actors/alls-green`으로 변경사항 확인·웹 빌드·데스크톱 행렬의 결과를 집계한다. 실패·취소·예상하지 않은 생략을 병합 필수 검사 실패로 반영한다. 문서만 바뀐 PR의 빌드 생략만 허용한다.                                                   |
| 웹 및 패키지 빌드 | 패키지·예제를 빌드하고, 웹은 배포 대상인 Cloudflare Workers로 빌드한다.                                                                                                                                                                   |
| 빌드 (각 OS)      | 변경사항 확인 직후 병렬로 시작한다. 패키지를 빌드한 뒤 Tauri의 기존 빌드 훅으로 데스크톱 UI와 설치 파일을 생성한다.                                                                                                                       |
| 타입 검사         | Turbo가 공개 진입점 검사에 필요한 자체 빌드를 먼저 수행한다. 웹은 패키지 의존성만 빌드하며, Nuxt 타입은 설치 과정의 `nuxt prepare`로 준비한다.                                                                                            |
| 테스트            | 기존 `test -> build` 의존성을 유지한다. 웹의 실제 Node 서버 기동 검사와 데스크톱의 `dist-sidecar/main.js` 검사를 실행한다.                                                                                                                |
| 린트 및 형식 검사 | 문서만 바뀐 PR도 검사한다. 실패하면 수정 패치를 업로드하며 검사 실패 상태를 유지한다.                                                                                                                                                     |
| CodeQL            | 변경 경로와 관계없이 JavaScript·TypeScript와 GitHub Actions를 분석한다.                                                                                                                                                                   |

데스크톱의 타입 검사와 테스트는 `build:sidecar`에 의존한다. 이 작업은 `@keundal/agent-host`와
그 의존 패키지만 먼저 빌드하고 `dist-sidecar`를 생성한다. 웹 Node 서버와 데스크톱 UI를 검사 준비 때문에
추가로 빌드하지 않으며, 최신 main에 추가된 데스크톱 호스트 테스트도 실행한다.

PR의 모든 검사는 기본 checkout 대상인 병합 커밋을 사용한다. CI에는 저장소 쓰기 권한과 `AUTOFIX_TOKEN`을 전달하지 않는다.
기존 PR 직접 푸시는 제거하고 `lintfix` 패치를 제공한다. main의 실패 패치는 기존 `autofix.yml`이 수정 PR로 만든다.

main push와 수동 실행은 전체 검사를 수행한다. `merge_group` 이벤트도 처리한다.
워크플로 자체에는 경로 필터를 두지 않아 필수 검사가 생성되지 않는 상태를 피한다.

배포 워크플로가 사용하는 `cloudflare-workers`와 `desktop-{linux-x64,windows-x64,macos-arm64}` 아티팩트 이름,
보관 기간, Workers 출력 경로를 유지한다. 프리뷰·운영 배포는 기존처럼 전체 CI 성공 후 수행한다.

## 공개 액션 선택과 검토

2026년 10월 21일 기준 최신 릴리스의 태그와 실제 커밋을 확인했다. 태그 객체가 있는 릴리스는 역참조한 커밋 SHA로 고정했다.
저장소 전용 composite 액션을 삭제하고 공개 액션을 직접 호출한다. 아래 검토는 사용하는 코드 경로와 권한·캐시·다운로드 처리를 대상으로 한다.
액션 전체와 번들 의존성에 취약점이 없음을 보증하는 감사는 아니다.

| 액션                                                                                                                              | 선택 및 검토 근거                                                                                                                                                                                                                    |
| --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [actions/checkout v7.0.1](https://github.com/actions/checkout/tree/3d3c42e5aac5ba805825da76410c181273ba90b1)                      | GitHub 공식 액션을 사용하며 `persist-credentials: false`로 후속 명령에 Git 인증 정보를 남기지 않는다.                                                                                                                                |
| [pnpm/setup v3.1.1](https://github.com/pnpm/setup/tree/a0881977cd8ea73b1ed212236c99ca10dcc80cf4)                                  | pnpm 공식 액션이다. `src/install-pnpm/download.ts`에서 고정된 npm 서명 키와 다운로드 체크섬 검증 경로를 확인했다. `devEngines`에서 Node와 pnpm 버전을 읽고 `require-lockfile: true`로 고정 설치를 수행한다.                          |
| [actions/cache v6.1.0](https://github.com/actions/cache/tree/55cc8345863c7cc4c66a329aec7e433d2d1c52a9)                            | GitHub 공식 캐시 액션이다. Turbo 작업 캐시만 저장하며 OS·아키텍처·작업·잠금 파일·설정으로 복원 범위를 나눈다.                                                                                                                        |
| [dorny/paths-filter v4.0.3](https://github.com/dorny/paths-filter/tree/ceb8a2b8f2d89434be7ff52d3de7ec3738c5cc9d)                  | 변경 파일 경로를 패턴과 비교하며 PR 코드를 실행하지 않는다. `src/filter.ts`의 `dot: true`와 `every` 조건을 확인했다. 파일 조회 작업에만 `pull-requests: read`를 부여한다.                                                            |
| [re-actors/alls-green v1.3.0](https://github.com/re-actors/alls-green/tree/b5b5b37504aa4183270bd3d855c52a67f212be35)              | `action.yml`과 `src/normalize_needed_jobs_status.py`, `src/job_outcome.py`를 검토했다. Python 표준 라이브러리로 전달된 작업 결과만 집계하며 네트워크·추가 설치·checkout·토큰 권한이 필요하지 않다. 실패 허용 목록은 지정하지 않는다. |
| [dtolnay/rust-toolchain](https://github.com/dtolnay/rust-toolchain/tree/b725eda525362e7cf34af9a7243cac1e3f01a7ec)                 | `action.yml`의 rustup 설치·최소 프로필·버전 선택 경로를 확인했다. 액션 코드는 SHA로 고정하고 도구 체인은 기존처럼 stable을 사용한다.                                                                                                 |
| [Swatinem/rust-cache v2.9.3](https://github.com/Swatinem/rust-cache/tree/d1527c8f67ef9af357290475d4af4b0fab8f12e0)                | `src/config.ts`, `restore.ts`, `save.ts`의 Rust 버전·Cargo 입력·작업별 캐시 키와 저장 경로를 확인했다. `cache-bin: false`로 설치된 도구 바이너리를 캐시에서 제외한다.                                                                |
| [tauri-apps/tauri-action action-v1.0.0](https://github.com/tauri-apps/tauri-action/tree/1deb371b0cd8bd54025b384f1cd735e725c4060f) | Tauri 공식 액션이다. `src/runner.ts`, `build.ts`, `index.ts`에서 빌드와 릴리스 업로드 경로를 확인했다. `tauriScript: pnpm tauri`로 잠금 파일의 CLI를 사용하고 Cargo에 `--locked`를 전달한다. 릴리스 입력과 토큰을 전달하지 않는다.   |
| [actions/upload-artifact v7.0.2](https://github.com/actions/upload-artifact/tree/cf430e030ddbb5b0abf93d22962f4752f3646cd9)        | GitHub 공식 업로드 액션이다. 산출물 경로를 지정하고 파일 누락 시 실패하게 한다. Workers 출력에 필요한 숨김 파일만 해당 업로드에서 포함한다.                                                                                          |
| [github/codeql-action v4](https://github.com/github/codeql-action/tree/6f2ac81f5cd81fe351a197ba0b00d91d03cd2aee)                  | GitHub 공식 분석 액션이다. 기존 SHA와 분석 설정을 유지하며 분석 작업에만 `security-events: write`를 부여한다.                                                                                                                        |

pnpm/setup의 `src/lockfile-verification-cache/index.ts`는 설치 직후 검증 기록을 저장하고,
이전 기록 변경이나 예상보다 많은 추가 기록이 있으면 저장하지 않는다. 검증 결과는 정확한 잠금 파일 해시로만 복원한다.
저장소 캐시는 OS·아키텍처·런타임·잠금 파일과 실행별 키를 사용하므로 병렬 작업이 같은 저장 키를 선점하지 않는다.
타입 검사와 테스트는 저장소 캐시를 복원만 하고, 빌드·린트와 각 OS 빌드가 필요한 캐시를 저장한다.

Turbo 캐시에는 데스크톱 설치 파일을 넣지 않는다. 네이티브 의존성은 Rust 전용 캐시가 관리하고 설치 파일은 아티팩트로만 전달한다.
캐시 적중 여부로 검사를 성공 처리하지 않으며, Turbo가 실제 입력 해시와 성공 기록을 기준으로 재사용 여부를 판단한다.
Dependabot은 워크플로에 고정한 액션 SHA의 업데이트를 계속 제안한다.

## 검증 방법

macOS의 DMG 생성은 [실행 39454203709](https://github.com/dungsil/keundal/actions/runs/39454203709)에서
앱 컴파일·서명 이후 `hdiutil: create failed - Resource busy`로 실패했다. 동일 구성의 앞선 실행은 성공했다.
Tauri 공식 액션의 `retryAttempts`를 macOS에서만 2로 지정한다. 액션이 각 실패 뒤 1~10초를 기다리고
빌드를 최대 세 번 수행하며, 모두 실패하면 작업도 실패한다. Linux와 Windows는 추가 재시도를 하지 않는다.
`src/runner.ts`와 `src/utils.ts`의 재시도 호출·횟수·최종 예외 전달을 확인했다.

- `actionlint`로 변경한 CI와 주간 감사의 구문, 표현식, 작업 의존성을 검사한다.
- `zizmor --offline`으로 권한, 고정 SHA, 비밀 정보 전달, PR 실행 경계를 검사한다.
- Turbo의 `--dry=json`으로 타입 검사·테스트에 데스크톱 UI 빌드가 없는지, Workers 빌드와 데스크톱 패키지 빌드의 의존성이 올바른지 확인한다.
- `pnpm typecheck`, `pnpm test`, `pnpm lint`와 각 빌드 명령을 실행한다. Node 서버 테스트와 Workers 빌드는 같은 `.output`을 사용하므로 순서대로 검증한다.
- GitHub에서 Linux·Windows·macOS 설치 파일 생성과 후속 프리뷰를 확인하고, 위 세 건과 같은 단계 기준으로 시간을 비교한다.

## 이번 변경의 검증 결과

- 변경한 두 워크플로의 `actionlint` 검사와 `zizmor --offline` 검사를 통과했다. 기본 보안 검사에서 보고된 지적은 없으며, 세부 감사의 Rust 도구 체인 액션 중복 사용 안내만 기본 설정에 따라 숨겨진다.
- 빌드 집계의 성공·실패·취소·생략과 문서 변경 여부를 조합한 128개 경우, 경로 필터의 문서·소스·설정 파일 9개 경우를 확인했다.
- 최신 main 반영 전에 타입 검사 48개 작업과 패키지·서버·예제 빌드 23개 작업을 통과했다. 앞선 실행에서 생성한 정상 캐시를 재사용했다.
- 최신 main 반영 전에 전체 테스트 42개 파일, 524개 케이스를 통과했다. 웹 Node 서버의 실제 기동 검사도 포함한다.
- Cloudflare Workers 빌드와 데스크톱 UI 생성을 통과하고, 배포 설정 및 데스크톱 정적 산출물을 확인했다.
- 최신 main의 호스트 통합 변경을 반영한 뒤 타입 검사와 전체 테스트 45개 파일, 536개 케이스 및 린트를 다시 통과했다. 데스크톱 호스트 테스트 3개를 포함하며, 검사 준비에서 UI 빌드가 제외되는 실행 계획을 확인했다.
- 로컬 빌드 검증은 클라우드 실행 환경의 프록시 설정을 전달하기 위해 `NODE_USE_ENV_PROXY=1`과 Turbo의 `--env-mode=loose`를 사용했다. 저장소의 CI는 기본 환경 격리를 유지한다.
- GitHub 호스팅 러너의 3개 OS 설치 파일 생성, CodeQL 업로드, 후속 배포와 변경 후 소요 시간은 이 로컬 검증에 포함하지 않았다.
