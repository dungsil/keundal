# Keundal Desktop

`apps/web`의 Nuxt UI를 그대로 사용하는 Tauri 2 데스크톱 앱입니다. UI를 복사하지 않고 웹 앱의 `desktop` 환경 설정으로 정적 SPA를 생성해 앱에 포함합니다. 배포된 웹사이트나 별도 Node.js 서버 없이 실행합니다.

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

Tauri가 `apps/web`의 개발 서버(포트 1420)를 시작하고 네이티브 창을 엽니다. 기존 웹 개발 서버의 기본 포트와 구분하며, `.nuxt-desktop`에 개발 산출물을 저장합니다. `dev:ui`는 Tauri용 UI 서버이며 보안 저장소 IPC가 필요하므로 일반 브라우저만으로 실행할 수 없습니다. 브라우저 UI 확인에는 `pnpm --filter @keundal/web dev`를 사용합니다.

## 빌드

```sh
# 공유 패키지와 정적 UI 빌드: Rust 없이도 실행 가능
pnpm build

# 현재 OS용 네이티브 앱과 설치 파일 빌드
pnpm --filter @keundal/desktop bundle

# 웹 Workers와 현재 OS용 데스크톱 설치 파일 빌드
pnpm build:preview

# 설치 파일 없이 네이티브 실행 파일만 빌드
pnpm --filter @keundal/desktop tauri build --no-bundle
```

정적 UI는 `apps/desktop/dist`, 네이티브 실행 파일은 `apps/desktop/src-tauri/target/release`, 설치 파일은 그 아래 `bundle`에 생성됩니다. macOS·Windows·Linux 패키지는 해당 OS의 도구로 빌드해야 합니다. 코드 서명·공증·업데이트 배포는 포함하지 않습니다.

`pnpm build`는 정적 UI까지만 빌드하므로 Rust나 OS 라이브러리가 필요하지 않습니다. `@keundal/web` 워크스페이스 의존성으로 공유 패키지 빌드 순서를 보장합니다.

`pnpm build:preview`는 Turbo에서 웹 Workers와 데스크톱 설치 파일을 함께 빌드합니다. 웹과 데스크톱은 Nuxt 출력 경로를 분리하여 병렬로 빌드합니다. 설치 파일 형식은 운영체제별 Tauri 설정을 따릅니다.

### PR 프리뷰

소스 변경이 있으면 기존 CI의 빌드 job이 Linux, Windows, macOS에서 `pnpm build:preview`를 실행합니다. 같은 저장소에서 `main`을 대상으로 연 PR에는 웹 프리뷰 댓글에 다음 다운로드 링크를 함께 표시합니다.

- macOS Apple Silicon: DMG
- macOS Intel: DMG
- Windows x64: NSIS 설치 파일
- Linux x64: DEB와 AppImage

다운로드에는 GitHub 로그인이 필요하며, 설치 파일은 업로드 후 7일간 보관합니다. 코드 서명 인증서와 공증은 사용하지 않습니다. macOS 빌드에는 임시 서명(ad-hoc)을 적용하며, OS 보안 경고가 표시될 수 있습니다.

웹과 데스크톱 빌드가 모두 성공하면 웹 프리뷰를 배포하고 댓글에 데스크톱 다운로드 링크를 표시합니다. 빌드가 실패하면 CI 실행 로그에서 원인을 확인합니다.

## 동작과 데이터

- 채팅, 모델 선택, LLM settings와 IndexedDB 저장소는 [웹 앱](../web/README.md)의 구현을 공유합니다. API 키는 앱 안의 **LLM settings**에서 입력합니다.
- 데스크톱은 SSR을 끄고 정적 SPA로 실행합니다. 서버 API는 포함하지 않습니다.
- 대화·첨부 파일은 WebView의 IndexedDB에 저장하며 SQLite로 대체하지 않습니다. 웹 브라우저 및 개발 모드와 배포 앱은 origin이 달라 대화를 자동 공유하거나 이전하지 않습니다.
- API 키·URL·헤더를 포함한 LLM 설정은 `keyring`으로 macOS Keychain·Windows Credential Manager·Linux Secret Service에 저장합니다. **Save in OS secret store**로 저장하며 마지막 공급자 설정까지 지우면 보안 저장소 항목도 삭제합니다. 보안 저장소의 서비스명은 `com.keundal.desktop`, 계정명은 `llm-settings`입니다. 개발·배포 앱은 같은 OS 사용자 보안 저장소 항목을 사용합니다.
- 기존 데스크톱 origin의 `keundal:llm-settings` 평문 설정은 첫 실행에서 검증 후 보안 저장소로 이전하고, 저장 성공 후에만 localStorage에서 제거합니다. 보안 저장소에 이미 설정이 있으면 이를 우선하고 남은 평문 복사본을 제거합니다. 웹 브라우저의 설정은 가져오거나 변경하지 않습니다.
- 보안 저장소가 잠겨 있거나 권한·서비스·용량 문제로 실패하면 오류로 알리고 localStorage로 대체하지 않습니다. 시작 시 조회·이전에 실패하면 잠금을 해제하거나 서비스를 복구한 뒤 앱을 재시작해야 합니다. 저장 실패 시에는 적용 중인 설정과 폼을 유지합니다. 설정은 하나의 보안 항목에 저장하므로 OS의 항목 크기 제한을 따릅니다.
- 저장 시 보호와 실행 중 메모리 보호는 다릅니다. 공급자에 요청하려면 설정을 앱 메모리로 읽어야 하며, 앱 내부의 악성 스크립트나 손상된 OS로부터 실행 중인 키까지 보호하지는 않습니다. 계정 동기화는 하지 않습니다. 웹 앱은 기존대로 브라우저 localStorage를 사용합니다.
- 공급자 요청은 WebView에서 직접 전송합니다. 공급자나 사용자 지정 API는 앱 origin의 CORS를 허용해야 하며 Rust HTTP 프록시로 우회하지 않습니다.
- 웹 UI의 HTML5 파일 드롭을 유지하도록 Tauri의 네이티브 드롭 처리를 끕니다. Windows WebView2에서도 웹의 이미지 첨부 경로를 사용합니다.
- 보안 저장소 IPC는 로컬 `main` 창의 LLM 설정 조회·저장에만 허용하며, 다른 자격 증명 항목이나 원격 콘텐츠에 권한을 부여하지 않습니다. CSP는 기존 웹 앱과 마찬가지로 강제하지 않습니다.
- 받아쓰기는 OS/WebView의 마이크 지원·권한에 따라 달라지며 실제 공급자 API와 플랫폼별 확인이 필요합니다.

## 로컬 스킬

사이드바의 **Skills**는 앱에 저장한 스킬과 로컬 파일을 함께 표시합니다. 앱에 저장한 스킬과 사용 여부는 WebView의 localStorage에 보관합니다. API 키를 저장하는 OS 보안 저장소와는 별개입니다.

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

아이콘은 `apps/web/public/favicon.ico`에서 Tauri CLI의 `icon` 명령으로 생성했습니다.
