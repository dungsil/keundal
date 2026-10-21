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

| 작업              | 수행 내용                                                                                                                                                                                                              |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 변경사항 확인     | PR의 변경 파일을 `dorny/paths-filter`로 조회한다. 아래 프리뷰 제외 경로만 바뀐 PR은 웹·데스크톱 빌드와 타입 검사·테스트를 생략한다. 새 설정 파일과 앱이 사용하는 Markdown을 놓치지 않도록 나머지 모든 경로를 포함한다. |
| 빌드              | `re-actors/alls-green`으로 변경사항 확인·웹 빌드·데스크톱 행렬의 결과를 집계한다. 실패·취소·예상하지 않은 생략을 병합 필수 검사 실패로 반영한다. 배포와 무관한 경로만 바뀐 PR의 빌드 생략을 허용한다.                  |
| 웹 및 패키지 빌드 | 패키지·예제를 빌드하고, 웹은 배포 대상인 Cloudflare Workers로 빌드한다.                                                                                                                                                |
| 빌드 (각 OS)      | 변경사항 확인 직후 병렬로 시작한다. 패키지를 빌드한 뒤 Tauri의 기존 빌드 훅으로 데스크톱 UI와 설치 파일을 생성한다.                                                                                                    |
| 타입 검사         | Turbo가 공개 진입점 검사에 필요한 자체 빌드를 먼저 수행한다. 웹은 패키지 의존성만 빌드하며, Nuxt 타입은 설치 과정의 `nuxt prepare`로 준비한다.                                                                         |
| 테스트            | 기존 `test -> build` 의존성을 유지한다. 웹의 실제 Node 서버 기동 검사와 데스크톱의 `dist-sidecar/main.js` 검사를 실행한다.                                                                                             |
| 린트 및 형식 검사 | 문서만 바뀐 PR도 검사한다. 실패하면 수정 패치를 업로드하며 검사 실패 상태를 유지한다.                                                                                                                                  |
| CodeQL            | 변경 경로와 관계없이 JavaScript·TypeScript와 GitHub Actions를 분석한다.                                                                                                                                                |

데스크톱의 타입 검사와 테스트는 `build:sidecar`에 의존한다. 이 작업은 `@keundal/agent-host`와
그 의존 패키지만 먼저 빌드하고 `dist-sidecar`를 생성한다. 웹 Node 서버와 데스크톱 UI를 검사 준비 때문에
추가로 빌드하지 않으며, 최신 main에 추가된 데스크톱 호스트 테스트도 실행한다.

PR의 모든 검사는 기본 checkout 대상인 병합 커밋을 사용한다. CI에는 저장소 쓰기 권한과 `AUTOFIX_TOKEN`을 전달하지 않는다.
기존 PR 직접 푸시는 제거하고 `lintfix` 패치를 제공한다. main의 실패 패치는 기존 `autofix.yml`이 수정 PR로 만든다.

main push와 수동 실행은 전체 검사를 수행한다. `merge_group` 이벤트도 처리한다.
워크플로 자체에는 경로 필터를 두지 않아 필수 검사가 생성되지 않는 상태를 피한다.

배포 워크플로가 사용하는 `cloudflare-workers`와 `desktop-{linux-x64,windows-x64,macos-arm64}` 아티팩트 이름,
보관 기간, Workers 출력 경로를 유지한다. 운영 배포는 전체 CI 성공 후 수행한다.

PR 프리뷰는 `preview-build.yml`에서 Workers와 의존 패키지만 별도로 빌드한다. 같은 저장소에서 main을
대상으로 연 PR에 실행하며, 네이티브 빌드나 나머지 CI 검사 결과를 기다리지 않는다. 빌드에는 읽기 권한만
부여하고 배포 비밀 정보는 전달하지 않는다. `preview.yml`은 이 웹 빌드가 성공하면 아티팩트를 받아 배포한다.
기존과 동일하게 저장소, 열린 PR, 최신 커밋을 확인하고 PR별 배포·삭제를 직렬화한다.

`.github/`, `ci/`, `docs/`, `examples/`, `tools/store-conformance/`, 루트 Markdown 문서와
앱·패키지·도구의 README만 바뀐 PR은 웹·데스크톱 빌드, 테스트, 타입 검사와 프리뷰 빌드를 실행하지 않는다. 일반 CI 성공으로 실행되는
프리뷰 배포도 PR의 전체 변경 파일을 확인하여 같은 경로만 바뀌었으면 배포와 댓글 생성을 생략한다.
배포 입력이 함께 바뀐 PR은 프리뷰를 생성한다. `tools/tsdown`과 `tools/tsconfig`는 실제 앱 빌드에
사용하므로 README를 제외한 변경은 프리뷰 대상에 포함한다. 앱이 사용하는 Markdown도 포함한다.
제외 경로를 바꿀 때는 `ci.yml`의 `source` 필터, `preview-build.yml`의 `paths-ignore`,
`preview.yml`의 배포 대상 검사를 함께 수정한다. 경로 확인과 빌드 결과 집계, 린트, CodeQL은 계속 실행한다.

전체 CI 성공도 프리뷰 배포를 실행하여 데스크톱 다운로드 링크를 갱신한다. 네이티브 빌드가 실패하거나
생략되어도 별도 웹 빌드가 성공하면 웹 프리뷰는 배포된다. 별도 빌드와 CI의 웹 빌드는 기존 Turbo 캐시를
공유하며, 병합 필수 검사인 `빌드`는 계속 CI의 웹 빌드와 네이티브 빌드 결과를 모두 집계한다.

## 공개 액션 선택과 검토

2026년 10월 21일 기준 최신 릴리스의 태그와 실제 커밋을 확인했다. 태그 객체가 있는 릴리스는 역참조한 커밋 SHA로 고정했다.
저장소 전용 composite 액션을 삭제하고 공개 액션을 직접 호출한다. 아래 검토는 사용하는 코드 경로와 권한·캐시·다운로드 처리를 대상으로 한다.
액션 전체와 번들 의존성에 취약점이 없음을 보증하는 감사는 아니다.

| 액션                                                                                                                       | 선택 및 검토 근거                                                                                                                                                                                                                                 |
| -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [actions/checkout v7.0.1](https://github.com/actions/checkout/tree/3d3c42e5aac5ba805825da76410c181273ba90b1)               | GitHub 공식 액션을 사용하며 `persist-credentials: false`로 후속 명령에 Git 인증 정보를 남기지 않는다.                                                                                                                                             |
| [pnpm/setup v3.1.1](https://github.com/pnpm/setup/tree/a0881977cd8ea73b1ed212236c99ca10dcc80cf4)                           | pnpm 공식 액션이다. `src/install-pnpm/download.ts`에서 고정된 npm 서명 키와 다운로드 체크섬 검증 경로를 확인했다. `devEngines`에서 Node와 pnpm 버전을 읽고 `require-lockfile: true`로 고정 설치를 수행한다.                                       |
| [actions/cache v5](https://github.com/actions/cache/tree/caa296126883cff596d87d8935842f9db880ef25)                         | GitHub 공식 Node 24 액션이다. `action.yml`, `src/restoreImpl.ts`, `src/saveImpl.ts`의 접두사 복원과 성공한 작업의 저장 경로를 확인했다. `.turbo/cache`만 보관하며 추가 인증 정보나 localhost 서버를 사용하지 않는다.                              |
| [dorny/paths-filter v4.0.3](https://github.com/dorny/paths-filter/tree/ceb8a2b8f2d89434be7ff52d3de7ec3738c5cc9d)           | 변경 파일 경로를 패턴과 비교하며 PR 코드를 실행하지 않는다. `src/filter.ts`의 `dot: true`와 `every` 조건을 확인했다. 파일 조회 작업에만 `pull-requests: read`를 부여한다.                                                                         |
| [re-actors/alls-green v1.3.0](https://github.com/re-actors/alls-green/tree/b5b5b37504aa4183270bd3d855c52a67f212be35)       | `action.yml`과 `src/normalize_needed_jobs_status.py`, `src/job_outcome.py`를 검토했다. Python 표준 라이브러리로 전달된 작업 결과만 집계하며 네트워크·추가 설치·checkout·토큰 권한이 필요하지 않다. 실패 허용 목록은 지정하지 않는다.              |
| [dtolnay/rust-toolchain](https://github.com/dtolnay/rust-toolchain/tree/b725eda525362e7cf34af9a7243cac1e3f01a7ec)          | `action.yml`의 rustup 설치·최소 프로필·버전 선택 경로를 확인했다. 액션 코드는 SHA로 고정하고 도구 체인은 기존처럼 stable을 사용한다.                                                                                                              |
| [Swatinem/rust-cache v2.9.3](https://github.com/Swatinem/rust-cache/tree/d1527c8f67ef9af357290475d4af4b0fab8f12e0)         | `src/config.ts`, `restore.ts`, `save.ts`의 Rust 버전·Cargo 입력·작업별 캐시 키와 저장 경로를 확인했다. `cache-bin: false`로 설치된 도구 바이너리를 캐시에서 제외한다.                                                                             |
| [nick-fields/retry v4.0.0](https://github.com/nick-fields/retry/tree/ad984534de44a9489a53aefd81eb77f87c70dc60)             | Node 24 액션이다. `src/index.ts`, `inputs.ts`의 셸 실행·횟수 제한·시간 초과 시 자식 프로세스 종료·최종 실패 반환을 확인했다. 고정 명령을 Bash로 실행하며 외부 입력을 명령에 보간하지 않는다. 추가 권한·인증 정보·런타임 다운로드가 필요하지 않다. |
| [actions/upload-artifact v7.0.2](https://github.com/actions/upload-artifact/tree/cf430e030ddbb5b0abf93d22962f4752f3646cd9) | GitHub 공식 업로드 액션이다. 산출물 경로를 지정하고 파일 누락 시 실패하게 한다. Workers 출력에 필요한 숨김 파일만 해당 업로드에서 포함한다.                                                                                                       |
| [github/codeql-action v4](https://github.com/github/codeql-action/tree/6f2ac81f5cd81fe351a197ba0b00d91d03cd2aee)           | GitHub 공식 분석 액션이다. 기존 SHA와 분석 설정을 유지하며 분석 작업에만 `security-events: write`를 부여한다.                                                                                                                                     |

pnpm/setup의 `src/lockfile-verification-cache/index.ts`는 설치 직후 검증 기록을 저장하고,
이전 기록 변경이나 예상보다 많은 추가 기록이 있으면 저장하지 않는다. 검증 결과는 정확한 잠금 파일 해시로만 복원한다.
저장소 캐시는 OS·아키텍처·런타임·잠금 파일과 실행별 키를 사용하므로 병렬 작업이 같은 저장 키를 선점하지 않는다.
타입 검사와 테스트는 저장소 캐시를 복원만 하고, 빌드·린트와 각 OS 빌드가 필요한 캐시를 저장한다.

## Turbo 캐시 재사용

`actions/cache`가 Turbo의 로컬 캐시 디렉터리인 `.turbo/cache`를 복원하고 작업이 성공하면 저장한다.
저장 키는 `turbo-v4-<OS>-<아키텍처>-<작업>-<실행 ID>-<재실행 번호>`로 구성한다. 병렬 작업과 재실행이
같은 불변 키를 저장하지 않으므로 캐시 예약 충돌과 불필요한 재시도를 피한다.

복원할 때는 같은 작업의 최신 캐시를 먼저 찾고, 없으면 같은 OS·아키텍처의 다른 작업이 저장한 최신 캐시를 찾는다.
서로 다른 캐시 묶음을 합치지는 않는다. 캐시 안의 결과가 현재 입력에 맞는지는 Turbo가 작업 해시로 다시 판단한다.
입력 파일·의존 패키지·환경 변수와 루트 `package.json` 변경은 기존 Turbo 설정에 따라 반영된다.
캐시는 GitHub의 저장소·브랜치 접근 범위를 따르며 OS·아키텍처는 캐시 접두사와 `globalEnv`에서 모두 구분한다.

기존 방식처럼 작업 결과가 나올 때마다 다른 러너에 즉시 공유하지는 않는다. 성공한 작업이 종료된 뒤 저장한
묶음을 이후 작업과 실행에서 재사용한다. 묶음에는 과거 결과도 남을 수 있고 실행마다 새 항목이 저장되므로
전송량과 저장 공간 사용량은 늘어날 수 있다. 기존 `turbo-v3` 원격 캐시와 형식이 달라 첫 실행은 새 캐시를 만든다.

- 패키지 빌드는 테스트·README·테스트 전용 TypeScript 설정 변경으로 무효화하지 않는다. 테스트 자체는 변경 시 다시 실행한다.
- 데스크톱의 `build:ui`는 공용 채팅 레이어로 생성한 UI와 Nuxt 준비 산출물을 캐시한다. 출력은 `apps/desktop`의 `.nuxt`, `.output`, `dist`에 둔다.
- 데스크톱 `build:sidecar`는 호스트 소스와 빌드 설정만 입력으로 삼는다. Rust나 UI만 바뀌면 호스트 번들을 재사용한다.
- `turbo run build:native`는 고정된 `tauri build -- --locked` 명령을 실행한다. 호스트·UI 의존 작업을 먼저 복원하고, 빌드 훅에서도 같은 작업을 재사용한 뒤 sidecar 자원을 준비한다. 각 OS에서 모든 패키지를 미리 빌드하는 별도 단계는 두지 않는다.
- `build:native`는 실행 파일·플랫폼 번들·sidecar 자원까지 캐시한다. OS·아키텍처 외에 러너 이미지, Rust 컴파일러 지문, Linux 시스템 라이브러리 버전, macOS SDK·대상·플래그·서명 설정이 바뀌면 다시 패키징한다.
- Rust 의존성 캐시는 계속 유지한다. 네이티브 작업 캐시가 없을 때 재컴파일 비용을 줄이는 역할을 한다.
- 아티팩트 업로드와 Windows 포터블 실행 검증은 캐시 밖에서 매번 수행한다. 최종 산출물 누락이나 실행 실패를 숨기지 않는다.
- 각 작업은 `.turbo/runs/*.json`을 별도 아티팩트로 보관한다. 작업별 해시·적중 여부·실행 시간을 다음 최적화의 근거로 확인한다.

공식 Tauri 액션의 `tauriScript`에 Turbo를 직접 연결하면, 액션이 덧붙이는 `build -- --locked` 인자가
의존 작업의 해시도 바꿔 일반 패키지 빌드와 공유되지 않았다. 고정된 패키지 스크립트를 실행해
의존 작업과 중첩 빌드 훅이 동일한 해시를 사용하도록 한다.

Dependabot은 추가한 액션을 포함하여 고정 SHA 업데이트를 계속 제안한다.

## 검증 방법

macOS의 DMG 생성은 [실행 39454203709](https://github.com/dungsil/keundal/actions/runs/39454203709)에서
앱 컴파일·서명 이후 `hdiutil: create failed - Resource busy`로 실패했다. 동일 구성의 앞선 실행은 성공했다.
`nick-fields/retry`의 `max_attempts`를 macOS는 3, Linux·Windows는 1로 지정한다.
실패 뒤 10초를 기다리고 최대 세 번 수행하며, 모두 실패하면 작업도 실패한다. 시도당 제한 시간은 30분이고
시간 초과는 재시도하지 않는다. 전체 작업의 45분 제한도 유지한다. 기존 공식 Tauri 액션이 macOS에서
설정하던 `TAURI_BUNDLER_DMG_IGNORE_CI=true`도 명시적으로 유지한다.

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

## Turbo 캐시 변경의 로컬 검증

- 작업 해시 변경 9개 경우를 확인했다. 테스트·Rust·웹 소스·Rust 컴파일러·러너 이미지·아키텍처 변경과 로컬 캐시 서버 주소 변경을 구분했다.
- 로컬 캐시를 끈 별도의 Turbo 프로세스가 공개 액션의 캐시 서버에서 기존 결과를 가져오는지 확인했다. 로컬 검증에서는 GitHub 인증 정보 없이 파일 공급자로 동작하는 같은 배포 번들을 사용했다.
- 코어 `dist`와 웹 `.nuxt-desktop`·`.output-desktop`, 데스크톱 `dist`를 삭제한 뒤 원격 캐시에서 복원했다. 파일 내용이 빌드 직후 결과와 일치했다.
- 타입 검사 50개 작업, 전체 테스트 46개 파일·543개 케이스, 워크플로 구문·보안 검사와 린트를 통과했다. Nuxt 빌드와 타입 검사는 같은 생성 파일을 갱신하므로 동일 작업 디렉터리의 로컬 검증에서는 순서대로 실행했다.
- Workers 빌드 17개 작업과 데스크톱 UI 생성도 통과했다. 공개 재시도 액션의 배포 번들에 성공·반복 실패 명령을 넣어 실행 횟수와 최종 실패 코드 전달을 확인했다.
- 네이티브 작업과 중첩 빌드 훅의 의존 작업 해시 22개가 일치했다. 데스크톱 테스트는 기본 입력에서 Rust와 README만 제외하여 테스트 설정 변경도 다시 검사한다.

## Turbo 캐시 변경의 GitHub 검증

- [첫 실행](https://github.com/dungsil/keundal/actions/runs/39459383372)에서 GitHub 캐시 서비스의 실제 저장·복원과 3개 OS 설치 파일 생성을 확인했다.
- [인자 분리를 제거한 실행](https://github.com/dungsil/keundal/actions/runs/39460442472)에서 패키지·예제 23개 작업이 이전 커밋의 캐시에 모두 적중했다. Linux 빌드 훅의 18개 작업도 전부 적중하여 32ms에 끝났다.
- 검증 중 main의 병합 대상이 바뀌어 웹·네이티브 일부 입력도 변경됐다. 변경 없는 패키지의 재사용과 변경된 입력의 재빌드를 구분했다.
- 같은 입력의 후속 실행에서는 `build:native`의 캐시 적중, 설치 파일 업로드 및 Windows 포터블 실행 검증을 함께 확인한다. 캐시가 있는 실행과 없는 실행의 빌드 단계 시간을 구분해 비교한다.

## Lighthouse 검사

`PR Lighthouse`는 `main`을 대상으로 하는 `pull_request` 이벤트에서 UI 관련 변경이 있는 경우에만 실행한다.
대상은 `apps/web`, `packages/chat-app`, `packages/ui`의 `app/`, `public/`, `shared/` 경로와
각 패키지의 `nuxt.config.ts`, `package.json`이다. PR 전체 변경 파일을 기준으로 판단한다.
문서, 서버, 데스크톱 전용 코드, 검사 설정 또는 루트 잠금 파일만 바뀐 PR에서는 실행하지 않는다.
따라서 UI 변경이 없는 PR에서는 프리뷰 배포 대기와 Lighthouse 결과 댓글 갱신도 생략한다.
기존 프리뷰 배포가 남긴 봇 댓글에서 현재 PR 커밋과 일치하는 배포 URL을 최대 20분간 기다린 뒤,
그 URL의 홈(`/`)과 설정(`/settings`)을 Unlighthouse 0.19.1로 검사한다. 이전 커밋이나 일반 사용자의
댓글에 있는 주소는 사용하지 않는다.

모바일 설정으로 두 화면을 각각 3회 검사하고 항목별 중앙값을 PR의 별도 Lighthouse 댓글과 Actions
작업 요약에 표시한다. 댓글에는 검사한 커밋과 실행 로그 링크를 남기며 재실행 시 같은 댓글을 갱신한다.
HTML·JSON 보고서는 아티팩트로 업로드하지 않는다. 점수 임계값은 설정하지 않고, 검사 실패도 댓글에
표시한다. 이전 커밋과의 점수 차이는 자동으로 계산하지 않는다.

프리뷰 조회와 검사 작업은 읽기 권한만 사용하며 배포 인증 정보를 받지 않는다. 댓글 게시 작업에만
`pull-requests: write` 권한을 부여하고, 해당 작업에서는 저장소 코드를 실행하지 않는다. 게시 직전에
열린 PR과 최신 커밋을 다시 확인한다. 같은 저장소의 PR만 검사하며, 외부 포크에서는 실행하지 않는다.
PR별 프리뷰 URL을 재사용하므로 검사 도중 새 배포가 이루어지면 결과가 섞일 수 있다.

저장된 대화가 필요한 `/chat/:id`는 검사하지 않는다. 대화 화면을 추가할 때는 고정된 테스트 데이터를
먼저 준비한다. 메시지 전송과 스트리밍 반응성은 별도 E2E 테스트 대상이다.

로컬에서는 웹과 의존 패키지를 프로덕션 설정으로 빌드하고 서버를 실행한다.

```sh
pnpm exec turbo run build --filter=@keundal/web
pnpm --filter @keundal/web preview
```

다른 터미널에서 `pnpm lighthouse:local`을 실행하면 Unlighthouse가 로컬 웹을 검사한다.
다른 주소를 검사하려면 다음처럼 실행한다. Chromium을 직접 지정하려면 `CHROME_PATH`를 설정하고
저장소의 설정 파일을 전달한다. 기본 실행의 원본 보고서는 `.unlighthouse/`에 저장한다.

```sh
pnpm dlx --allow-build=esbuild --allow-build=puppeteer --allow-build=vue-demi @unlighthouse/cli@0.19.1 --site https://배포된-프리뷰-주소 --config-file tools/lighthouse/unlighthouse.config.mjs
```

CI는 `LIGHTHOUSE_RUN=1`, `2`, `3`으로 위 명령을 각각 실행하여 원본을 별도 디렉터리에 보존한다.
세 실행의 점수 요약은 다음 명령으로 생성한다. `LIGHTHOUSE_BASE_URL`은 검사한 주소와 같아야 한다.

```sh
LIGHTHOUSE_BASE_URL=https://배포된-프리뷰-주소 LIGHTHOUSE_REPORT_DIR=.unlighthouse node tools/lighthouse/summary.mjs
```

## 린터의 실행 환경

Oxlint의 Node 환경은 `packages/agent-host/src/**`에도 적용한다. Node가 제공하는 `AbortController`를
미정의 변수로 처리하지 않으며, 다른 패키지에 Node 전역을 일괄 허용하지 않는다.

`packages/ui/nuxt.config.ts`에는 `defineNuxtConfig`를, UI 앱 파일에는 사용하는 Nuxt·Vue 자동 import를
읽기 전용 전역으로 등록한다. 브라우저 환경은 UI 앱 파일에만 적용하고 `defineProps`, `defineEmits`는
Vue 파일에만 허용한다. UI 파일을 린트 대상에서 제외하거나 미정의 변수 검사를 끄지는 않는다.
