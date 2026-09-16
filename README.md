# Keundal

Keundal("큰달"으로 읽음)은 개인용 오픈소스 에이전트 도구입니다.

Cordis로 에이전트 서비스를 구성하고, AG-UI 입력과 이벤트로 실행 요청과 결과를 주고받는 라이브러리를 제공합니다.

OpenAI Responses API 연결은 [@keundal/plugin-llm-openai](packages/plugin-llm-openai/README.md)에서 제공합니다. 세션과 생성 실행을 메모리에 보관하는 저장소는 `@keundal/plugin-store-memory`에서 제공합니다.

브라우저에서 세션과 생성 실행을 유지하려면 [@keundal/plugin-store-indexeddb](packages/plugin-store-indexeddb/README.md)를 사용합니다. IndexedDB에 대화와 실행 기록을 저장하고, Web Locks로 여러 탭의 실행과 복구를 조정합니다.

## 라이선스

이 프로젝트는 [MIT License](./LICENSE)에 따라 배포됩니다.

### 크레딧

- [Cordis] - 플러그인 기반의 메타 프레임워크
- [AG-UI] - 에이전트 실행 입력과 이벤트를 정의하는 프로토콜

<!-- 링크 -->

[Cordis]: https://github.com/cordiverse/cordis
[AG-UI]: https://github.com/ag-ui-protocol/ag-ui
