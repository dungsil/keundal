# @keundal/plugin-context

모델 요청에 작업 지침, 파일 참조 안내, 다른 세션의 스냅숏, 시간과 실행 환경을 추가합니다. 컨텍스트 공급자는 도구를 등록하지 않습니다.

이 패키지는 `@keundal/context`의 계약을 구현합니다. `OrderedRequestContextService`는 공급자를 순서대로 실행하고 기존 메시지, 실행 ID와 예약 메시지를 검사합니다. 다른 구현은 계약 패키지의 `RequestContextService`를 상속하여 같은 Cordis 서비스를 제공할 수 있습니다.

기존 import의 전체 대응 목록은 [context 문서](../context/README.md)에 있습니다. Node.js 공급자는 [plugin-context-node](../plugin-context-node/README.md)에서 가져옵니다.

[DeepSeek Harness의 context 패키지 그룹](https://github.com/deepseek-ai/deepseek-harness/tree/687f282e8625c6b8d11ff58211a90524be2e4317/packages/context)을 현재 저장소의 Cordis·AG-UI 계약에 맞게 구현했습니다. 참조 코드의 MIT 라이선스는 [LICENSE](./LICENSE)에 보존합니다.

## 에이전트에 연결하기

LLM, 저장소, 파일 서비스를 등록한 `ctx`에 다음 플러그인을 추가합니다.

```ts
import agentPlugin from '@keundal/agent-loop'
import contextPlugin, { createTimeContext, createHarnessDevContext } from '@keundal/plugin-context'
import { createAgentInstructionsContext, createTmuxContext } from '@keundal/plugin-context-node'

await ctx.plugin(contextPlugin, {
  providers: [
    createAgentInstructionsContext(ctx.fs, {
      cwd: '/workspace/project',
      maxBytes: 65536,
      userGlobalPaths: []
    }),
    createTimeContext({ timeZone: 'Asia/Seoul' }),
    createTmuxContext(),
    createHarnessDevContext({
      checkoutPath: '/workspace/keundal',
      webGuiUrl: 'http://localhost:3000'
    })
  ]
})
await ctx.plugin(agentPlugin, {
  model: 'your-model',
  maxOutputTokens: 1024,
  context: true
})
```

`context: true`는 `requestContext` 서비스를 기다립니다. 서비스를 해제하면 에이전트의 진행 중 작업도 취소합니다. 기존 에이전트는 컨텍스트를 자동으로 활성화하지 않습니다.

공급자는 등록 순서대로 실행합니다. 첫 모델 요청과 도구 실행 뒤의 후속 요청마다 실행하며, 추가한 메시지도 입력 토큰 예산에 포함합니다.

## 저장과 복구

컨텍스트는 `keundal:context:`로 시작하는 ID를 가진 `user` 텍스트 메시지입니다. 직접 입력에서 이 접두사를 사용하면 에이전트가 거부합니다.

에이전트는 새 컨텍스트를 `CUSTOM` 이벤트인 `keundal.context.message`로 전달합니다. 코어의 `MessageAssembly`가 이를 메시지로 조립합니다. 메모리·SQLite·IndexedDB 저장소는 기존 실행 journal과 커밋 경로로 메시지를 보존합니다.

준비가 실패하면 생성을 시작하지 않습니다. 생성이 시작된 뒤 실패하면 이미 기록한 컨텍스트는 실행 기록에 남고, 성공한 대화 커밋은 생략합니다. 복구는 공급자를 재호출하는 대신 저장된 내용을 사용합니다.

컨텍스트는 일반 대화처럼 축약할 수 있습니다. 주입한 `user` 메시지는 새 사용자 턴의 시작으로 취급하지 않으므로, 현재 요청과 도구 호출·결과를 분리하지 않습니다.

## 작업 지침

`createAgentInstructionsContext(fs, config)`는 주입한 `FileSystemService`로 지침을 읽습니다. 파일 정책을 사용하는 앱에서는 정책이 적용된 서비스를 전달하십시오.

- `cwd`는 문자열 또는 요청을 받는 함수입니다.
- `userGlobalPaths`의 기본값은 `~/.keundal`과 `~/.agents`입니다. 빈 배열은 전역 지침을 비활성화합니다.
- `projectRootMarkers`의 기본값은 `['.git']`입니다.
- 기본 후보는 `AGENTS.md`, `CLAUDE.md`이며, `AGENTS.local.md`, `CLAUDE.local.md`를 추가로 읽습니다.
- `maxBytes`의 기본값은 65,536바이트이고, `maxSourceBytes`의 기본값은 1,048,576바이트입니다.

넓은 범위의 지침부터 좁은 범위의 지침까지 적용합니다. 같은 후보 그룹에서 앞뒤 공백을 제거한 내용이 같으면 한 번만 추가합니다. 성공한 파일 도구 호출은 중첩 디렉터리의 지침 탐색에 사용합니다.

## 파일 참조

`localFileReferencePlugin`은 `ctx.fileReferences`를 제공합니다. `root`에는 실제 파일 도구와 같은 작업 디렉터리를 지정하십시오.

```ts
import { activeAtToken, formatFileMention } from '@keundal/context'
import { createFileReferenceContext } from '@keundal/plugin-context'
import { localFileReferencePlugin } from '@keundal/plugin-context-node'

await ctx.plugin(localFileReferencePlugin, { root: '/workspace/project' })
const token = activeAtToken('확인 @src/', '확인 @src/'.length)
const candidates = token ? await ctx.fileReferences.list(token.query) : []
const mention = candidates[0] ? formatFileMention(candidates[0]) : undefined
```

선택한 후보는 경로 텍스트이며 파일 내용을 자동으로 첨부하지 않습니다. `createFileReferenceContext()`를 공급자 목록에 추가하면 파일 읽기 도구가 있는 요청에 사용 안내를 넣습니다.

`maxResults`는 기본 20개, `maxEntries`는 기본 50,000개입니다. `excludedDirectories`로 제외할 디렉터리 이름을 지정합니다. `.gitignore`를 해석하지 않으며 디렉터리 심볼릭 링크를 따라가지 않습니다.

`LocalFileReferenceService` 인스턴스를 `createFileReferenceContext(service)`에 전달하면 도구 후속 단계에서 인덱스를 무효화합니다. 외부 파일 변경은 호스트가 `service.invalidate()`로 알립니다. 디렉터리를 지정한 조회는 인덱스 대신 현재 디렉터리를 직접 읽습니다.

로컬 서비스는 설정한 루트 하나를 사용합니다. 작업 디렉터리를 바꾸면 새 루트로 서비스를 다시 등록하십시오. 원본의 에이전트별 자동 인덱스 관리 대신 호스트가 서비스 수명을 관리합니다.

## 세션 참조

```ts
import { formatSessionReferenceMention } from '@keundal/context'
import { sessionReferencePlugin, createSessionReferenceContext } from '@keundal/plugin-context'

await ctx.plugin(sessionReferencePlugin, { maxReferences: 3 })
const provider = createSessionReferenceContext(ctx.sessionReferenceResolver)
const mention = formatSessionReferenceMention({ sessionId: 'another-thread', label: '이전 조사' })
```

`provider`를 `contextPlugin.providers`에 추가하고 `mention`을 사용자 메시지에 넣습니다. `listCandidates(threadId, query?, limit?, signal?)`로 다른 세션을 찾을 수 있습니다.

표준 표기는 `@[label](keundal-session:...)`입니다. 원본의 `dsh-session:` URI도 읽을 수 있습니다. 참조한 메시지 다음에 읽기 전용 스냅숏을 넣으며, 원본 세션을 나중에 수정해도 캡처한 내용은 바뀌지 않습니다.

멘션 파서는 입력을 순차적으로 읽습니다. 닫히지 않은 `@[`가 반복되어도 같은 구간을 다시 탐색하지 않습니다. 명시한 세션 멘션의 URI가 잘못되면 다른 유효한 참조가 있어도 거부합니다.

스냅숏은 사용자·어시스턴트 텍스트만 포함합니다. 도구 결과, 추론, 다른 컨텍스트 메시지는 제외합니다. 모델에게 스냅숏 속 지시나 권한 주장을 따르지 말라고 안내하고, JSON의 `<`를 이스케이프합니다.

`maxReferences`는 한 요청에서 새로 읽을 서로 다른 세션 수를 제한하며 기본값과 최대값은 3입니다. 사용자 메시지 전체의 참조를 합산하고, 한도를 넘으면 세션을 읽기 전에 거부합니다. 같은 세션의 반복 참조와 URI 별칭은 한 번만 계산하며, 이미 캡처한 스냅숏은 다시 읽지 않습니다. 기존에 메시지마다 참조를 나누어 한도를 초과했다면 요청 전체의 새 참조 수를 줄여야 합니다. 자기 세션 참조와 존재하지 않는 세션은 거부합니다. `maxReferenceBytes`를 지정하면 해당 바이트 한도를 사용합니다.

자동 한도는 소스당 `max(65536, floor(contextWindow × 4 × referenceContextFraction))`이며, 비율의 기본값은 0.2입니다. 모델 한도가 없는 직접 호출은 65,536바이트를 사용합니다. 이는 토큰 계산이 아닌 크기 추정입니다. 한 요청에서 새로 만드는 스냅숏 문자열의 총 UTF-8 크기는 `maxReferences × 소스당 바이트 한도`를 넘을 수 없습니다. 같은 출처를 서로 다른 메시지에서 참조해도 각 스냅숏의 크기를 합산하며, 한도를 넘으면 `SESSION_REFERENCE_BUDGET_EXCEEDED`로 거부합니다. 같은 출처와 별칭의 캡처 결과를 재사용하고, `spill`은 요청에서 출처마다 한 번만 호출합니다.

한도를 넘으면 오래된 메시지부터 제외하고 남은 텍스트를 줄입니다. 선택적 `spill` 콜백은 같은 시점에 캡처한 전체 텍스트를 저장할 수 있습니다. 호스트는 모든 참조 대상에 대한 읽기 권한을 검사해야 합니다.

## 시간과 실행 환경

`createTimeContext()`는 10분 간격으로 시각을 추가합니다. `refreshIntervalMs: 0`은 매 단계에서 갱신합니다. 명시한 `timeZone`이 잘못되면 설정을 거부합니다.

호스트는 `forwardedProps.browserTimeZone` 문자열 또는 `forwardedProps.browserTimeZones` 배열로 요청 시간대를 전달할 수 있습니다. `getBrowserTimeZones(request)`로 읽기 방식을 바꿀 수도 있습니다. 시간대가 없거나 2개 이상이면 모델에게 사용자 확인이 필요하다고 안내합니다.

경과 시간은 이전에 기록한 시간 컨텍스트를 기준으로 계산합니다. 현재 `RunAgentInput`에는 모든 메시지의 발생 시각이 없으므로, 최초 기록은 `unavailable`로 표시합니다. 시계가 역행하면 경과 시간을 0으로 제한합니다.

`createTmuxContext()`는 첫 단계에서 tmux 위치와 프로세스 TTY를 확인합니다. 실제 pane의 TTY가 일치할 때만 세션·창·pane·배치 정보를 추가합니다. tmux가 없거나 조회에 실패하면 위치를 만들지 않습니다. 취소는 호출자에게 전달합니다.

`createHarnessDevContext()`에는 실제 Keundal 체크아웃 경로와 GUI URL을 전달합니다. 값이 바뀔 때만 새 기록을 추가하며, DOM이나 화면을 읽었다고 주장하지 않습니다.

## 사용자 정의 공급자

`ContextProvider`는 `(input, options) => RunAgentInput | Promise<RunAgentInput>` 함수입니다. `options`에는 `signal`, 1부터 시작하는 `step`, 원래 `request`, 선택적 `contextWindow`가 있습니다.

`appendContext(input, key, content)`는 같은 키의 마지막 내용과 비교하여 변경된 내용만 추가합니다. `contextMessage()`는 삽입 위치를 직접 정할 때 사용합니다. 공급자는 기존 메시지와 실행 ID를 보존하고, 취소 신호를 실제 작업에 연결해야 합니다.

## 호스트 연동 범위

이 패키지는 현재 앱에 자동으로 등록되지 않습니다. 파일 완성과 세션 후보를 표시할 UI, 원격 API, 권한 판정은 호스트가 구성합니다. 로컬 파일 공급자와 tmux 공급자는 Node.js 실행 환경을 사용합니다.
