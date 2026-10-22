# @keundal/context

이 패키지는 `requestContext`, `fileReferences`, `sessionReferenceResolver`의 서비스 계약과 Cordis Context 확장을 제공합니다. 구현 플러그인이나 Node.js 모듈을 가져오지 않습니다.

`RequestContextService`, `FileReferenceService`, `SessionReferenceService`를 상속하면 같은 서비스 이름으로 다른 구현을 등록할 수 있습니다. 소비자는 이 패키지의 계약만 참조하고, 호스트가 구현 플러그인을 등록합니다.

메시지 함수 `contextMessage`, `latestContextMessage`, `appendContext`와 `ContextOptions`, `ContextProvider`, `ContextMessage`, `CONTEXT_MESSAGE_PREFIX`는 이 패키지에 남습니다. 파일 멘션 함수 `activeAtToken`, `formatFileMention`도 이 패키지에서 제공합니다.

세션 멘션 함수 `encodeSessionReferenceUri`, `decodeSessionReferenceUri`, `formatSessionReferenceMention`, `parseSessionReferenceText`는 Node.js 없이 동작합니다. `SESSION_REFERENCE_SCHEME`, `SessionReferenceError`, `SessionReferenceErrorCode`, `SessionReferenceInput`, `SessionReferenceCandidate`, `ParsedSessionReferenceText`도 이 패키지에서 가져옵니다.

순서대로 준비하고 결과를 검사하는 구현은 [plugin-context](../plugin-context/README.md)에 있습니다. 로컬 파일과 프로세스를 사용하는 공급자는 [plugin-context-node](../plugin-context-node/README.md)에 있습니다. 참조 코드의 MIT 라이선스는 [LICENSE](./LICENSE)에 보존합니다.
