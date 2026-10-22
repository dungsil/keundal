# @keundal/plugin-context-node

이 패키지는 Node.js를 사용하는 컨텍스트 공급자를 제공합니다. 서비스 계약은 `@keundal/context`에서 가져옵니다.

- `createAgentInstructionsContext(fs, config)`는 파일 서비스로 작업 지침을 읽습니다. 경로, 사용자 홈, 해시 계산에는 Node.js를 사용합니다.
- `LocalFileReferenceService`와 `localFileReferencePlugin`은 로컬 파일을 탐색하여 `fileReferences` 계약을 구현합니다.
- `createTmuxContext(config)`는 tmux와 프로세스 TTY를 확인합니다. 취소 신호를 프로세스 호출에 전달합니다.

호스트는 이 공급자들을 `@keundal/plugin-context`의 `contextPlugin.providers`에 전달합니다. `createFileReferenceContext`는 `@keundal/plugin-context`에서, `activeAtToken`과 `formatFileMention`은 `@keundal/context`에서 가져옵니다.

동작과 설정은 [plugin-context 문서](../plugin-context/README.md)를 참고하십시오. 참조 코드의 MIT 라이선스는 [LICENSE](./LICENSE)에 보존합니다.
