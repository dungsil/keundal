# 계약과 구현 플러그인을 분리하고 앱이 조립한다

`@keundal/agent`, `tools`, `context`, `mcp`, `shell`, `transcription`, `fs`는 서비스 계약만 제공한다. 구현은 `plugin-*` 패키지에 두고, 공통 실행 루프와 축약·도구 정책은 `agent-loop`가 소유한다. 앱의 `app/platform.ts`가 실행 환경과 기본 플러그인 목록을 정한다. 계약 패키지와 공통 UI는 구현 패키지를 실행 의존성으로 가져오지 않으며, `pnpm check:boundaries`가 이를 검사한다.

서비스 구현은 런타임 매니페스트로 고른다. web은 `/keundal.plugins.json`을 기본으로 읽고 `NUXT_PUBLIC_PLUGIN_CONFIG`로 다른 URL을 지정한다. Node.js 호스트와 desktop은 `KEUNDAL_PLUGIN_CONFIG`, 앱 데이터 디렉터리, 현재 디렉터리 순서로 설정 파일을 찾는다. 외부 모듈은 ESM URL, 파일 경로, 설치된 패키지 이름으로 지정하며 앱은 실행 중에 패키지를 설치하지 않는다. 설정이나 모듈이 잘못되면 기본 구성으로 대체하지 않고 시작을 거부한다. UI 설정은 자격 증명, MCP 서버, 스킬처럼 사용자가 바꾸는 데이터를 다루고, 모듈 선택은 매니페스트가 맡는다.

저장소와 `session`의 수명은 LLM에 종속시키지 않는다. LLM을 교체하면 `generation`과 에이전트만 다시 구성하고 기존 대화와 journal은 유지한다. 플러그인 전체를 해제할 때는 진행 중인 생성을 먼저 정리한 뒤 소유한 저장소를 닫는다.

## 검토한 선택

- 앱의 TypeScript 조립 코드만 두는 안: 구현을 바꿀 때마다 앱을 다시 빌드해야 하므로 사용하지 않는다.
- YAML 로더와 실행 중 패키지 설치: 설정 형식과 공급망 경계를 늘리므로 사용하지 않는다.
- MCP 도구 조립만을 위한 별도 패키지: 독립 소비자가 없으므로 추가하지 않는다.

플랫폼별 구현 선택은 `docs/plugin-composition.md`에 정리한다.
