# @keundal/tool-approval

Tool-specific `allow`, `ask`, and `deny` policies, approval requests, and single-use responses. `@keundal/tool-execution` applies the policy before executing normal, deferred, and subagent tools. Discovery does not grant execution permission.

```ts
import { ToolApproval } from '@keundal/tool-approval'

const toolApproval = new ToolApproval({
  default: 'ask',
  tools: { read_file: 'allow', shell: 'ask', write_file: 'deny', search_tool: 'allow' }
})

// Pass the same host-owned instance to createAgentHost({ toolApproval, ... })
// or to AgentConfig.toolApproval. Local ChatStore accepts it as its third argument.
// Forward AgentMountConfig.toolApproval when mounting an agent.
```

`new ToolApproval()` defaults to `ask`. For backward compatibility, callers that do not configure approval use an explicit `allow` policy; those decisions are still journaled. This does not make existing applications secure by default. Node hosts accept `NodeHostOptions.toolApproval`, `createAgentRuntime(..., { toolApproval })`, or the operator-owned `KEUNDAL_TOOL_APPROVAL` JSON environment variable. Do not accept a policy from model input or `forwardedProps`.

## Approval protocol

- The `keundal.tool.approval` CUSTOM event carries `requestId`, `threadId`, `runId`, `toolCallId`, `toolName`, the exact JSON arguments, and operation details. Tools can supply a side-effect-free `describeOperation()` to show a command, target paths, and operation kind. Shell and file tools do so; unknown tools show their name and arguments. Shell paths describe the working directory, not every resource a command may access.
- `ask` emits `status: 'requested'` and suspends that call until the user answers. Other independent calls may proceed when parallel execution is enabled. The chat view shows **Allow once** and **Deny**, including requests from subagents.
- The authenticated HTTP endpoint `POST /runs/:runId/approvals/:requestId` accepts only `{ "decision": "allow" | "deny" }`. It returns 202 for the first valid response and 409 for stale, duplicate, or wrongly scoped responses. In-process callers use `ToolApproval.respond()` or `host.services.respondToToolApproval()`.
- Each decision emits `status: 'decided'`, `policy`, `decision`, and `source: 'policy' | 'user'`. A denial returns `{"error":"TOOL_PERMISSION_DENIED","tool":"..."}` as the tool result, allowing the model to continue without running the tool.
- The executor waits until the generation consumer has recorded the decision. SQLite and IndexedDB flush approval events before continuing the stream, rather than waiting for their normal journal batch threshold. A storage error prevents execution.
- Cancellation clears pending requests and prevents a late response from executing anything. A cancelled request remains `requested` in the journal; the generation's terminal status makes it inactive.
- Reconnecting replays/subscribes to the existing Generation Journal, never invokes the executor again, and never recreates an approval queue. After process loss, `recover()` marks unfinished generations `interrupted`; it does not resume approved work. This is not an exactly-once transaction with external side effects across a crash.

## Security boundary

Approval is not an OS sandbox. Existing file-path policies still apply after approval; shell commands do not acquire file-policy isolation. A command's working directory does not confine its filesystem or network access. Tool descriptions and operation summaries are supplied by trusted tool providers. External module import, plugin initialization, and `describeOperation()` run outside this gate. Isolating untrusted plugins requires a separate process/OS boundary.

Journal arguments can contain sensitive data; they have the same access and retention boundary as the conversation. Only authenticated, trusted host clients may answer approvals. A custom agent or plugin that calls an executor outside `@keundal/tool-execution` must enforce its own policy.
