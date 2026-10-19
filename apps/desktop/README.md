# Keundal Desktop

`apps/web`의 Nuxt UI를 그대로 사용하는 Tauri 2 데스크톱 앱입니다. UI를 복사하지 않고 웹 앱의 `desktop` 환경 설정으로 정적 SPA를 생성해 앱에 포함합니다. 배포된 웹사이트나 별도 Node.js 서버 없이 실행합니다.

## 준비

루트 `package.json`에 지정한 Node.js·pnpm과 Rust stable이 필요합니다. 운영체제별 도구는 [Tauri 사전 요구 사항](https://v2.tauri.app/start/prerequisites/)을 따릅니다.

- macOS: Xcode Command Line Tools
- Windows: Microsoft C++ Build Tools와 WebView2
- Linux: C/C++ 빌드 도구, WebKitGTK 4.1, GTK 3, AppIndicator, librsvg, patchelf

Debian/Ubuntu에서는 다음 패키지를 설치합니다.

```sh
sudo apt-get install build-essential libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf
```

## 개발

저장소 루트에서 실행합니다.

```sh
pnpm install
pnpm build
pnpm --filter @keundal/desktop dev
```

Tauri가 `apps/web`의 개발 서버(포트 1420)를 시작하고 네이티브 창을 엽니다. 기존 웹 개발 서버의 기본 포트와 구분하며, `.nuxt-desktop`에 개발 산출물을 저장합니다. UI만 브라우저에서 확인하려면 `pnpm --filter @keundal/desktop dev:ui`를 사용합니다.

## 빌드

```sh
# 공유 패키지와 정적 UI 빌드: Rust 없이도 실행 가능
pnpm build

# 현재 OS용 네이티브 앱과 설치 파일 빌드
pnpm --filter @keundal/desktop bundle

# 설치 파일 없이 네이티브 실행 파일만 빌드
pnpm --filter @keundal/desktop tauri build --no-bundle
```

정적 UI는 `apps/desktop/dist`, 네이티브 실행 파일은 `apps/desktop/src-tauri/target/release`, 설치 파일은 그 아래 `bundle`에 생성됩니다. macOS·Windows·Linux 패키지는 해당 OS의 도구로 빌드해야 합니다. 코드 서명·공증·업데이트 배포는 포함하지 않습니다.

루트 Turbo 빌드는 정적 UI까지만 빌드하므로 기존 웹 CI에 Rust나 OS 라이브러리를 요구하지 않습니다. `@keundal/web` 워크스페이스 의존성으로 공유 패키지 빌드 순서를 보장합니다.

## 동작과 데이터

- 채팅, 모델 선택, LLM settings와 IndexedDB 저장소는 [웹 앱](../web/README.md)의 구현을 공유합니다. API 키는 앱 안의 **LLM settings**에서 입력합니다.
- 데스크톱은 SSR과 자동 로그인 세션 조회를 끕니다. OAuth와 서버 API는 포함하지 않으며 `NUXT_SESSION_PASSWORD`도 필요하지 않습니다.
- 대화·첨부 파일은 WebView의 IndexedDB에, API 키·URL·헤더는 localStorage에 암호화 없이 저장됩니다. OS 키체인이나 SQLite로 대체하지 않습니다. 웹 브라우저 및 개발 모드와 배포 앱은 origin이 달라 데이터를 자동 공유하거나 이전하지 않습니다.
- 공급자 요청은 WebView에서 직접 전송합니다. 공급자나 사용자 지정 API는 앱 origin의 CORS를 허용해야 하며 Rust HTTP 프록시로 우회하지 않습니다.
- 웹 UI의 HTML5 파일 드롭을 유지하도록 Tauri의 네이티브 드롭 처리를 끕니다. Windows WebView2에서도 웹의 이미지 첨부 경로를 사용합니다.
- 원격 콘텐츠에 네이티브 권한을 부여하지 않습니다. 현재 UI는 Tauri IPC를 사용하지 않으므로 capability 권한도 부여하지 않습니다. CSP는 기존 웹 앱과 마찬가지로 강제하지 않습니다.
- 받아쓰기는 OS/WebView의 마이크 지원·권한에 따라 달라지며 실제 공급자 API와 플랫폼별 확인이 필요합니다.

아이콘은 `apps/web/public/favicon.ico`에서 Tauri CLI의 `icon` 명령으로 생성했습니다.
