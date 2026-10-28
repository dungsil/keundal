# 에이전트 실행 품질 평가

같은 코딩 작업을 여러 모델·프롬프트로 실행하고 성공률, 도구 호출 수, 입력·출력 토큰,
소요 시간과 비용을 비교합니다. 앱의 필수 서비스나 실행 루프를 변경하지 않는 Node.js CLI입니다.
`@keundal/plugin-agent-coding`과 메모리 저장소를 시도마다 새로 조립하고,
`@keundal/trace`의 실행 추적으로 사용량과 비용을 집계합니다.

## 재현용 실행

저장소 루트에서 실행합니다. 의존 패키지를 빌드한 뒤에는 빌드를 반복할 필요가 없습니다.

```sh
pnpm install
pnpm exec turbo run build --filter='@keundal/agent-eval^...'
pnpm --filter @keundal/agent-eval eval \
  --config configs/demo.ts --output /tmp/eval-baseline.json --repetitions 3
pnpm --filter @keundal/agent-eval eval \
  --config configs/demo.ts --output /tmp/eval-current.json --repetitions 3 \
  --baseline /tmp/eval-baseline.json
```

`demo.ts`는 실제 에이전트 루프에 정답·오답을 내는 스크립트 공급자를 연결합니다.
두 시나리오에서 정답 후보의 성공률은 100%, 오답 후보는 0%이며, 사용량과 가격도 고정값입니다.
평가 도구의 동작을 확인하는 대조군이지 실제 모델의 품질·요금 측정 결과가 아닙니다.
일반 테스트와 CI는 이 대조군만 사용하며 외부 API를 호출하지 않습니다.

## 실제 모델 비교

`configs/openai.ts`는 OpenAI Responses API를 사용합니다. 키는 `OPENAI_API_KEY`로 공급하며
결과나 설정 파일에 넣지 않습니다. 모델 한도와 가격은 호출할 때의 공식 값으로 직접 지정합니다.
아래 모델명·한도·가격은 **형식 설명용 가상 값**입니다. 사용할 모델 값으로 바꾸십시오.

```json
{
  "revision": "prompt-v1-pricing-v1",
  "models": {
    "MODEL_A": { "contextWindow": 100000, "maxOutputTokens": 2048 },
    "MODEL_B": { "contextWindow": 100000, "maxOutputTokens": 2048 }
  },
  "pricing": {
    "currency": "USD",
    "models": {
      "MODEL_A": { "inputPerMillion": 1, "outputPerMillion": 4 },
      "MODEL_B": { "inputPerMillion": 2, "outputPerMillion": 6 }
    }
  }
}
```

설정을 JSON 파일에 저장하고 절대 경로로 지정합니다.

```sh
EVAL_SETTINGS=/absolute/path/settings.json pnpm --filter @keundal/agent-eval eval \
  --config configs/openai.ts --output /tmp/model-baseline.json \
  --repetitions 5 --timeout-ms 120000
```

같은 설정의 `systemPrompt`를 변경하고 `revision`을 갱신한 뒤 다시 실행합니다.

```sh
EVAL_SETTINGS=/absolute/path/settings.json pnpm --filter @keundal/agent-eval eval \
  --config configs/openai.ts --output /tmp/model-current.json \
  --repetitions 5 --timeout-ms 120000 --baseline /tmp/model-baseline.json
```

## 결과와 비교 조건

- 각 시도는 `passed`, `failed`, `error`, `timeout` 중 하나입니다. 정상 종료뿐 아니라
  숨겨진 고정 검증 사례를 모두 통과해야 성공입니다. 예외·미완료도 성공률의 분모에 포함합니다.
- JSON은 시나리오 ID·버전, 후보 ID·모델·설정 revision, 반복 횟수, 시간제한과 시도별 결과를
  저장합니다. 사용한 설정과 코드의 revision도 함께 보관하십시오.
- 표에는 후보별 성공률, 총 호출 수·토큰 수·비용, 평균 실행 시간을 표시합니다.
  실행 시간은 에이전트 실행 시작부터 이벤트 열이 끝날 때까지이며 준비·채점·정리는 제외합니다.
- 비용은 실행 추적의 공급자 값 또는 가격표에 따른 추정값입니다. 원본의 `source`를 유지합니다.
  사용량·가격 누락이나 통화 혼합은 `null` / `unknown`으로 표시하며 0으로 처리하지 않습니다.
- 비교하려면 시나리오 ID·버전, 반복 횟수와 시간제한이 같아야 하며 후보 ID로 대응합니다.
  성공률 차이는 비율(0.1은 10%p), 비용 차이는 현재 값 − 기준 값입니다.
  후보 ID를 고정하면 모델이나 프롬프트 revision을 바꾼 전후도 비교할 수 있습니다.
- `failed`는 품질 측정 결과이므로 CLI 종료 코드는 0이며, `error` / `timeout`은 1입니다.
  비교 결과는 판단 자료이며 자동 합격 기준이나 통계적 유의성을 뜻하지 않습니다.

## 시나리오와 확장

`coding-slug`는 ASCII 문자의 슬러그 변환, `coding-median`은 배열을 변경하지 않는 중앙값 계산을
구현하는 과제입니다. 시도마다 파일을 초기화하며 모델에는 `solution.mjs` 읽기·쓰기만 공개합니다.
중앙값은 짝수 길이, 음수, 숫자 정렬과 극단적인 유한 값도 채점합니다.

직접 만든 설정은 `EvaluationConfig`를 default export하는 TypeScript / JavaScript 모듈입니다.
`EvaluationScenario.prepare()`는 독립된 입력·도구·채점·정리를 반환하며,
`EvaluationCandidate.create(tools)`는 새 에이전트와 정리를 반환합니다.
공급자 교체는 `configs/candidate.ts`와 함께 제공한 설정을 참고하십시오.
시나리오의 명세·초기값·채점을 변경하면 `version`을 갱신합니다.

## 안전성과 제한

**생성 코드는 신뢰할 수 없습니다. 비밀 정보와 중요한 파일이 없는 일회용 OS 샌드박스에서 실행하십시오.**
채점용 Node.js 자식 프로세스는 환경 변수를 상속하지 않고 3초 시간제한과 64 KiB 출력 한도를 두지만,
OS 격리가 아닙니다. Node 권한 모드로 임시 디렉터리 읽기만 허용하고 파일 쓰기·프로세스 생성을
제한하지만 악의적인 코드에 대한 보안 경계를 보장하지 않습니다. 네트워크 접근과 채점 변조도 막지 못합니다.

`--timeout-ms`는 준비 후 에이전트 실행과 채점에 적용하며 초과하면 에이전트를 취소합니다.
직접 만든 후보는 취소 신호와 `dispose()`를 실제 작업에 연결하고 준비·정리도 유한 시간 안에 끝내야 합니다.
CLI는 협조적 취소를 전제로 하며 같은 프로세스의 임의 코드를 강제 종료하지 않습니다.
모델의 비결정성과 공급자 변경은 남으므로 같은 조건에서 여러 번 측정하고 단일 결과로 우열을 단정하지 마십시오.
