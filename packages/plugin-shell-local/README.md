# @keundal/plugin-shell-local

Node.js에서 `shell` 서비스를 제공합니다. 명령은 지정한 셸의 전경 작업으로 실행합니다.

```ts
import localShellPlugin from '@keundal/plugin-shell-local'
import { Context } from 'cordis'

const ctx = new Context()
const controller = new AbortController()
const provider = await ctx.plugin(localShellPlugin, { cwd: '/workspace/project' })
const result = await ctx.shell.execute(
  { command: 'git status --short', cwd: '.', timeoutMs: 1000 },
  { signal: controller.signal }
)
await provider.dispose()
```

`cwd`는 필수입니다. 공급자는 실제 경로를 확인하고 디렉터리인지 검사합니다.
요청의 상대 경로는 설정한 `cwd`를 기준으로 해석합니다.
절대 경로도 허용하지만 설정한 디렉터리 밖이면 거부합니다. 외부를 가리키는 심볼릭 링크도 거부합니다.

- `shell`: 실행 파일입니다. 기본값은 POSIX의 `/bin/sh`와 Windows의 `ComSpec` 또는 `cmd.exe`입니다.
- `timeoutMs`: 기본값은 120000ms입니다. 요청은 이 한도를 줄일 수만 있습니다.
- `maxOutputBytes`: 각 출력에서 보관할 최대 바이트 수입니다. 기본값은 64000입니다.
- `killGraceMs`: 강제 종료 전 대기 시간입니다. 기본값은 100ms입니다.

숫자 설정은 1부터 2147483647까지의 정수만 허용합니다.
출력은 UTF-8로 해석합니다. 한도 끝의 불완전한 문자는 버립니다.
한도를 넘긴 출력은 버리면서 계속 소비하고 `truncated`를 반환합니다.
명령의 비정상 종료는 `exitCode`와 `signal`로 반환합니다.
실행 준비 오류와 실행 전 취소는 예외로 전달하며, 실행 중 취소와 시간 초과는 결과의 플래그로 구분합니다.

POSIX에서는 프로세스 그룹에 TERM을 보내고 유예 시간 뒤에 KILL을 보냅니다.
직접 자식이 먼저 종료해도 강제 종료를 생략하지 않습니다.
직접 자식이 정상 종료해도 남은 그룹을 정리합니다. 백그라운드 작업을 유지하는 용도로 사용하지 마십시오.
유예 시간이 끝나면 상속된 출력 파이프를 닫아 자손 때문에 출력 수집이 멈추지 않도록 합니다.

공급자를 해제하면 실행을 취소하고 정리를 기다립니다. 보관한 서비스 참조로 새 명령을 실행할 수 없습니다.

## 보안 한계

이 공급자는 셸 샌드박스가 아닙니다. `cwd` 검사는 명령이 접근할 경로를 제한하지 않습니다.
명령은 외부 파일, 네트워크, 환경 변수와 호스트 권한에 접근할 수 있습니다.
경로 검사와 실행 사이에 파일 시스템을 바꾸는 공격도 막지 못합니다.
신뢰할 수 없는 명령에는 컨테이너처럼 OS가 제공하는 격리를 적용하십시오.
새 세션이나 프로세스 그룹으로 이탈한 자손은 그룹 종료를 피할 수 있습니다.

Windows에서는 `taskkill /T /F`로 트리 종료를 요청합니다.
부모가 먼저 사라진 트리와 이탈한 자손의 종료는 보장하지 않습니다. Windows 동작에는 별도 검증이 필요합니다.
출력 파이프는 유예 시간 뒤에 닫지만 OS가 직접 자식의 종료를 보고할 때까지 기다립니다.

다른 실행 파일은 POSIX의 `-c` 또는 Windows의 `/d /s /c` 인자를 지원해야 합니다.
Tauri나 원격 서버에서는 코어의 `ShellService`를 별도 공급자로 구현하고 이 Node.js 패키지를 교체하십시오.
코어 계약에는 Node.js 의존성이 없습니다.
