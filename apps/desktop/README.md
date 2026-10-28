# Keundal Desktop

`@keundal/chat-app` Nuxt 레이어를 사용하는 Tauri 2 데스크톱 앱입니다. `apps/desktop/nuxt.config.ts`에서 공용 레이어를 상속하고 정적 SPA를 생성해 앱에 포함합니다. 배포된 웹사이트나 별도 Node.js 서버 없이 실행합니다.

## 준비

루트 `package.json`에 지정한 Node.js·pnpm과 Rust stable이 필요합니다. 운영체제별 도구는 [Tauri 사전 요구 사항](https://v2.tauri.app/start/prerequisites/)을 따릅니다.

- macOS: Xcode Command Line Tools
- Windows: Microsoft C++ Build Tools와 WebView2
- Linux: C/C++ 빌드 도구, WebKitGTK 4.1, GTK 3, AppIndicator, librsvg, D-Bus 개발 라이브러리, patchelf. 실행 시에는 D-Bus 사용자 세션과 Secret Service 구현(예: GNOME Keyring)이 필요합니다.

Debian/Ubuntu에서는 다음 패키지를 설치합니다.

```sh
sudo apt-get install build-essential libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev libdbus-1-dev patchelf gnome-keyring
```

## 개발

저장소 루트에서 실행합니다.

```sh
pnpm install
pnpm build
pnpm --filter @keundal/desktop dev
```

Tauri가 `apps/desktop`의 개발 서버(포트 1420)를 시작하고 네이티브 창을 엽니다. 기존 웹 개발 서버의 기본 포트와 구분하며, `apps/desktop/.nuxt`에 개발 산출물을 저장합니다. `dev:ui`는 Tauri용 UI 서버이며 보안 저장소 IPC가 필요하므로 일반 브라우저만으로 실행할 수 없습니다. 브라우저 UI 확인에는 `pnpm --filter @keundal/web dev`를 사용합니다.

## 빌드

```sh
# 공유 패키지와 정적 UI 빌드: Rust 없이도 실행 가능
pnpm build

# 현재 OS용 네이티브 앱과 배포 파일 빌드
pnpm --filter @keundal/desktop bundle

# 웹 Workers와 현재 OS용 데스크톱 배포 파일 빌드
pnpm build:preview

# 설치 파일 없이 네이티브 실행 파일만 빌드
pnpm --filter @keundal/desktop tauri build --no-bundle
```

정적 UI는 `apps/desktop/dist`, 네이티브 실행 파일은 `apps/desktop/src-tauri/target/release`, 설치 파일은 그 아래 `bundle`에 생성됩니다. macOS·Windows·Linux 패키지는 해당 OS의 도구로 빌드해야 합니다. 코드 서명·공증·업데이트 배포는 포함하지 않습니다.

`pnpm build`는 정적 UI까지만 빌드하므로 Rust나 OS 라이브러리가 필요하지 않습니다. `@keundal/chat-app`과 `@keundal/agent-host` 워크스페이스 의존성으로 공유 패키지 빌드 순서를 보장합니다. 다른 앱에는 의존하지 않습니다.

`pnpm build:preview`는 Turbo에서 웹 Workers와 데스크톱 배포 파일을 함께 빌드합니다. 웹과 데스크톱은 Nuxt 출력 경로를 분리하여 병렬로 빌드합니다. 배포 파일 형식은 운영체제별 Tauri 설정을 따릅니다. Windows는 설치 파일을 만들지 않습니다. CI는 `keundal-desktop.exe`, Node.js 런타임인 `keundal-host.exe`, `sidecar` 폴더를 `apps/desktop/src-tauri/target/release/portable`에 모아 배포합니다. 실행할 PC에는 WebView2가 필요합니다.

### PR 프리뷰

소스 변경이 있으면 기존 CI의 `빌드` job이 `pnpm build`로 공통 패키지와 정적 UI를 먼저 빌드합니다. 성공하면 플랫폼 빌드 job이 Linux, Windows, macOS에서 `pnpm build:preview`를 실행합니다. 같은 저장소에서 `main`을 대상으로 연 PR에는 웹 프리뷰 댓글에 다음 다운로드 링크를 함께 표시합니다.

- macOS Apple Silicon: DMG
- Windows x64: 설치 없이 실행하는 EXE와 호스트·리소스
- Linux x64: DEB와 AppImage

다운로드에는 GitHub 로그인이 필요하며, 배포 파일은 업로드 후 7일간 보관합니다. Windows는 다운로드한 압축 파일을 모두 푼 뒤 `keundal-desktop.exe`를 실행합니다. `keundal-host.exe`와 `sidecar` 폴더도 함께 유지해야 합니다. 설정과 대화 데이터는 OS 사용자 프로필에 저장합니다. 코드 서명 인증서와 공증은 사용하지 않습니다. macOS 빌드에는 임시 서명(ad-hoc)을 적용하며, OS 보안 경고가 표시될 수 있습니다.

Windows 포터블 배포는 이 프로젝트에서 구성한 방식이며, Tauri가 공식 지원하는 포터블 모드는 아닙니다.

웹과 데스크톱 빌드가 모두 성공하면 웹 프리뷰를 배포하고 댓글에 데스크톱 다운로드 링크를 표시합니다. 빌드가 실패하면 CI 실행 로그에서 원인을 확인합니다.

## 동작과 데이터

- 채팅, 모델 선택, LLM settings와 IndexedDB 저장소는 [공용 채팅 레이어](../../packages/chat-app/README.md)의 구현을 공유합니다. API 키는 앱 안의 **LLM settings**에서 입력합니다.
- 데스크톱은 SSR을 끄고 정적 SPA로 실행합니다. 대화·실행 기록은 앱 데이터 디렉터리의 SQLite에 저장합니다. 공급자 설정이 없어도 로컬 호스트를 시작하며, 호스트 시작 실패는 오류로 알립니다.
- 웹 브라우저 및 개발 모드와 배포 앱은 origin이 달라 대화를 자동 공유하거나 이전하지 않습니다.
- API 키·URL·헤더를 포함한 LLM 설정은 `keyring`으로 macOS Keychain·Windows Credential Manager·Linux Secret Service에 저장합니다. **Save in OS secret store**로 저장하며 마지막 공급자 설정까지 지우면 보안 저장소 항목도 삭제합니다. 보안 저장소의 서비스명은 `com.keundal.desktop`, 계정명은 `llm-settings`입니다. 개발·배포 앱은 같은 OS 사용자 보안 저장소 항목을 사용합니다.
- 기존 데스크톱 origin의 `keundal:llm-settings` 평문 설정은 첫 실행에서 검증 후 보안 저장소로 이전하고, 저장 성공 후에만 localStorage에서 제거합니다. 보안 저장소에 이미 설정이 있으면 이를 우선하고 남은 평문 복사본을 제거합니다. 웹 브라우저의 설정은 가져오거나 변경하지 않습니다.
- 보안 저장소가 잠겨 있거나 권한·서비스·용량 문제로 실패하면 오류로 알리고 localStorage로 대체하지 않습니다. 시작 시 조회·이전에 실패하면 잠금을 해제하거나 서비스를 복구한 뒤 앱을 재시작해야 합니다. 저장 실패 시에는 적용 중인 설정과 폼을 유지합니다. 설정은 하나의 보안 항목에 저장하므로 OS의 항목 크기 제한을 따릅니다.
- 저장 시 보호와 실행 중 메모리 보호는 다릅니다. 공급자에 요청하려면 설정을 앱 메모리로 읽어야 하며, 앱 내부의 악성 스크립트나 손상된 OS로부터 실행 중인 키까지 보호하지는 않습니다. 계정 동기화는 하지 않습니다. 웹 앱은 기존대로 브라우저 localStorage를 사용합니다.
- 제목과 답변 생성은 로컬 호스트가 공급자에 요청합니다. 모델 목록 조회와 받아쓰기는 WebView에서 요청하므로 해당 API는 앱 origin의 CORS를 허용해야 합니다.
- 웹 UI의 HTML5 파일 드롭을 유지하도록 Tauri의 네이티브 드롭 처리를 끕니다. Windows WebView2에서도 웹의 이미지 첨부 경로를 사용합니다.
- 보안 저장소 IPC는 로컬 `main` 창의 LLM 설정 조회·저장에만 허용하며, 다른 자격 증명 항목이나 원격 콘텐츠에 권한을 부여하지 않습니다. CSP는 기존 웹 앱과 마찬가지로 강제하지 않습니다.
- 받아쓰기는 OS/WebView의 마이크 지원·권한에 따라 달라지며 실제 공급자 API와 플랫폼별 확인이 필요합니다.

## 로컬 호스트

데스크톱은 Tauri 창과 함께 Node.js 호스트를 sidecar 프로세스로 실행합니다. 호스트 진입점인 `sidecar/main.ts`는 `@keundal/agent-runtime-node`을 직접 사용하며 SQLite 파일을 앱 데이터 디렉터리에 저장합니다. 웹 서버를 실행하거나 웹 서버 번들을 복사하지 않습니다.

실행 호스트 전체는 호스트 폴더와 네트워크 어댑터를 공유하지 않는 Linux VM에서 시작합니다. Linux·Windows·macOS 호스트에 QEMU·네이티브 파일 브로커·게스트 이미지를 별도로 설치하고 `KEUNDAL_SANDBOX_VM_CONFIG`를 지정해야 합니다. 자산이나 정책이 없으면 비격리 실행으로 대체하지 않고 시작을 거부합니다. 기존 Cordis 플러그인 형식은 유지하지만 Windows·macOS 전용 실행 파일은 Linux용으로 바꿔야 합니다. 원격 호스트 연결은 유지합니다.

앱을 시작하기 전에 [샌드박스 정책](../../packages/agent-runtime-node/README.md#os-샌드박스)을 만들고 `KEUNDAL_SANDBOX_CONFIG`에 절대 경로를 지정합니다. 정책 파일·앱 설치 디렉터리는 작업공간 밖에 두고, 앱 데이터 디렉터리를 `writablePaths`에 포함해야 기존 SQLite와 관리하는 플러그인을 계속 사용할 수 있습니다. 로컬 경로 플러그인은 원본과 의존성을 `readOnlyPaths`에, 필요한 외부 API는 `allowedHosts`에 허용합니다. 이 허용 범위를 Tool Approval이나 플러그인 활성화가 넓히지는 않습니다. 파일은 시작에 복사하고 정상 종료에 내보내며 실시간 공유하지 않습니다. 충돌이나 비정상 종료 후에는 생성 결과가 남아 있을 수 있으므로 VM 상태 디렉터리를 삭제하지 않습니다.

- 채팅 입력창의 모델 선택기에서 공급자와 모델을 바꿉니다. 저장한 선택이 없으면 OS 보안 저장소에 설정한 첫 공급자를 고르며, 공급자 순서는 OpenAI, Anthropic, Google Gemini입니다. API 키 없이 주소나 헤더만 설정한 공급자도 사용할 수 있습니다.
- 저장한 모델 선택이 없으면 `KEUNDAL_MODEL` 환경 변수를 사용하며, 환경 변수도 없으면 공급자별 기본 모델을 사용합니다. 설정한 공급자가 하나도 없으면 OpenAI를 기본값으로 사용합니다.
- 호스트는 `127.0.0.1`의 임의 포트에 바인딩하고, 실행마다 새 Bearer 토큰을 만듭니다. 토큰은 Tauri IPC로 웹 UI에만 전달합니다.
- 모델 목록은 기존 공급자별 조회·캐시를 사용합니다. 모델을 바꾸거나 LLM 설정을 저장·삭제하면 진행 중인 응답을 중단하고 sidecar만 새 설정으로 다시 시작합니다. 앱 창과 SQLite 대화 기록은 유지되며 앱을 다시 시작할 필요가 없습니다.
- sidecar를 교체하면 UI의 접속 주소·토큰과 모델 캐시를 갱신하고, 다음 응답 전에 미완료 실행을 복구합니다. 새 sidecar가 시작하지 못하면 기존 연결과 모델 선택을 유지하며 오류를 표시합니다.

`pnpm --filter @keundal/desktop dev`와 `bundle`은 `prepare:sidecar` 명령으로 데스크톱의 호스트 진입점을 `dist-sidecar`에 빌드합니다. 이어서 `scripts/prepare-sidecar.mjs`가 현재 Node.js 실행 파일을 `src-tauri/binaries/keundal-host-<triple>`로 복사하고, sidecar 번들을 `src-tauri/sidecar`에 복사합니다. 배포 파일에는 Node.js 런타임과 sidecar 번들이 포함되므로 앱 크기가 커집니다.

## 로컬 스킬

**설정 → 에이전트 플러그인 → 스킬**에서 앱에 저장한 스킬과 로컬 파일을 함께 표시합니다. 앱에 저장한 스킬과 사용 여부는 WebView의 localStorage에 보관합니다. API 키를 저장하는 OS 보안 저장소와는 별개입니다.

앱은 실행 프로세스의 현재 디렉터리와 OS 홈 디렉터리에서 `.agents/skills/<directory>/SKILL.md`를 찾습니다. 실행 디렉터리는 앱을 시작한 방법에 따라 달라집니다. 없는 루트는 건너뛰며 프로젝트 상위 디렉터리를 탐색하지 않습니다.

동명 스킬은 앱에 저장한 사용 중 스킬, 실행 디렉터리 파일, 홈 디렉터리 파일 순으로 선택합니다. 같은 루트 안에 동명 스킬이 둘 이상 있으면 오류를 알립니다. 파일 형식은 [파일시스템 스킬 문서](../../packages/plugin-skill-filesystem/README.md#파일-형식)를 따릅니다.

- **Load .agents/skills**로 로컬 로딩을 끄거나 파일별 스위치로 사용 여부를 바꿉니다.
- **Refresh files**로 목록을 갱신합니다. 응답을 시작할 때도 목록을 다시 읽으며 파일 감시는 하지 않습니다.
- 파일은 읽기 전용으로 표시합니다. 지침은 외부 편집기에서 수정하며 앱은 원본을 변경하거나 삭제하지 않습니다.
- 잘못된 파일은 경로와 오류를 표시합니다. 해당 파일을 수정하거나 사용 중지해야 다음 응답을 시작할 수 있습니다.
- 직접 하위 디렉터리의 `SKILL.md`만 읽습니다. 중첩 경로, 임의 경로, 심볼릭 링크 디렉터리와 파일은 허용하지 않습니다.
- 본문을 불러올 때 파일을 다시 읽습니다. 이름이 바뀌거나 파일이 사라지면 로딩이 실패합니다. 스크립트와 첨부 파일은 자동으로 읽거나 실행하지 않습니다.

GUI 라이브러리 없이 파일 탐색과 경로 제한만 검증하려면 저장소 루트에서 다음 명령을 실행합니다.

```sh
rustc --edition=2021 --test apps/desktop/src-tauri/src/skill_files.rs -o /tmp/keundal-skill-files-tests
/tmp/keundal-skill-files-tests
```

LLM·저장소·에이전트·도구는 앱 데이터 디렉터리의 `keundal.plugins.json`으로 교체합니다. `KEUNDAL_PLUGIN_CONFIG`를 지정하면 해당 파일을 우선합니다. 외부 ESM 파일이나 설치된 패키지를 선택할 수 있으며 앱을 다시 빌드할 필요가 없습니다. 설정 변경 후 앱을 다시 시작하면 sidecar가 새 구성을 읽습니다. 형식과 신뢰 경계는 [플러그인 조립 문서](../../docs/plugin-composition.md#런타임-설정)를 참고합니다.

## 외부 큰달 플러그인

**설정 → 큰달 플러그인 → 외부 플러그인 설치**에서 npm·JSR 패키지, 로컬 ZIP 또는 절대 경로를 등록합니다. 이는 스킬·MCP 묶음인 **에이전트 플러그인**과 다른 기능입니다. 패키지 이름에는 버전을 지정할 수 있습니다. 로컬 폴더와 ZIP에는 `package.json`과 빌드된 JavaScript 진입점이 필요하며, `.mjs`·`.cjs`·`.js` 파일도 직접 등록할 수 있습니다.

신뢰 확인 후 설치하면 목록에 비활성 상태로 추가됩니다. 스위치를 켤 때 플러그인의 `default` 내보내기를 실행합니다. npm을 앱에 포함하므로 시스템 npm은 필요하지 않으며, 설치 스크립트는 실행하지 않습니다. 외부 플러그인은 Linux VM 안에서 다른 플러그인과 권한·공급자 자격 증명을 공유하므로 신뢰할 수 있는 출처만 사용합니다.

활성화·비활성화·삭제는 진행 중인 응답을 중단하고 sidecar를 교체합니다. 실패하면 이전 선택으로 복구합니다. 삭제는 앱이 관리하는 설치 파일만 지우고 원본 파일과 대화 기록은 유지합니다. 패키지 폴더는 복사본을 사용하고, JavaScript 파일 경로는 원본을 참조합니다. 자세한 출처 형식과 제한은 [외부 큰달 플러그인 안내](../../docs/plugin-composition.md#desktop-외부-큰달-플러그인)를 참고합니다.

## MCP

**설정 → 에이전트 플러그인 → MCP 서버**에서 Streamable HTTP 서버와 로컬 stdio 서버를 등록합니다. 인증 헤더와 환경 변수를 포함한 설정은 OS 보안 저장소에 저장합니다. 설정을 저장하면 진행 중인 응답을 중단하고 로컬 호스트를 다시 시작합니다. [공용 MCP 설정 안내](../../packages/chat-app/README.md#mcp-서버)를 참고합니다.

**연결 확인**은 Streamable HTTP 서버만 지원합니다. 확인 요청은 로컬 호스트가 아니라 앱 창(WebView)이 보내므로, 서버가 앱 origin의 CORS를 허용하지 않으면 실제 대화에서는 연결되는 서버도 확인에 실패할 수 있습니다. 확인에 실패해도 저장할 수 있습니다. stdio 명령은 확인하지 않으며 실행하지도 않습니다. 자세한 내용은 [공용 MCP 설정 안내](../../packages/chat-app/README.md#연결-확인)를 참고합니다.
