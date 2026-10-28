# Agent memory

`@keundal/memory` owns the `MemoryService` contract and Cordis `ctx.memory` extension. Memory is independent of conversation compaction, sessions, and generation journals. `@keundal/plugin-memory` implements validation and scoped keyword retrieval over a storage adapter. The existing store plugins register this service alongside sessions:

- IndexedDB: a dedicated `memories` object store, with an additive v1/v2 → v3 upgrade preserving conversations, journals, and tasks.
- SQLite: a dedicated `memories` table in the configured database.
- In-memory store: an independent map, intentionally lost when the process exits.

## Scopes and ownership

A user memory applies across conversations in this storage instance. Project memories require an exact `projectId`, and conversation memories require an exact `threadId`. These are retrieval scopes, **not authorization boundaries**. The current app uses a private browser database or a single-user host protected by its bearer token. A shared multi-user host must supply independently authorized storage instances; a client-provided project identifier does not establish user identity.

Each record contains content, scope, a source label, optional original conversation/message IDs, and creation/update timestamps. Source metadata is user supplied, not an independently verified citation. Editing preserves the original creation timestamp. Updating a deleted record fails rather than recreating it. Deleting a conversation does not delete independently saved memories or change their provenance.

## Retrieval

`memory.search()` performs normalized Unicode keyword retrieval without calling a model. `retrieveMemories()` from `@keundal/memory/retrieval` combines these results with **model-based semantic selection**, not embeddings. It uses the selected chat model to find related facts even when words differ. Only eligible scopes are sent to the model. Unknown or out-of-scope IDs returned by the model are discarded; malformed JSON falls back to keyword results. Provider failures and cancellation propagate to the caller.

The semantic pass considers up to 64 candidates, prioritizing keyword matches and then recent updates, with at most 8,192 input tokens and 512 output tokens. Candidates are removed until they fit the model context limit. Recall defaults to eight results. This is a bounded initial implementation, not an exhaustive vector index: an older semantic-only match outside the candidate window may not be found. Every recall with eligible candidates adds a model request, latency, and provider cost. The normal agent run budget also applies to that request.

The common agent loop recalls at the beginning of each run using the latest user text, `input.threadId`, and optional `input.forwardedProps.memoryProjectId`. It replaces previous memory projections, attaches source metadata as untrusted reference context, and runs the normal input-budget/compaction checks before generating an answer. Recalled context is recorded through the existing context journal event. The loop does not automatically infer or save memories from conversations.

## App and HTTP

Settings → Memory supports manual creation, scope/context selection, keyword/semantic search, source inspection, content editing, and confirmed deletion. The active project setting applies to future turns, including new conversations, and can be cleared. Records can be managed without provider credentials; semantic search and automatic recall require a working selected model. Memory data is sent to that model's provider during recall. No extra embedding provider or API key is required.

The authenticated host API provides:

| Method | Path               | Body                                              |
| ------ | ------------------ | ------------------------------------------------- |
| GET    | `/memories`        | —                                                 |
| POST   | `/memories`        | `MemoryDraft`                                     |
| PUT    | `/memories/:id`    | `MemoryDraft`                                     |
| DELETE | `/memories/:id`    | —                                                 |
| POST   | `/memories/search` | `{ text, projectId?, threadId?, limit?, model? }` |

Memory entries are limited to 4,000 content characters; source labels and scope identifiers to 200. Search results are limited to 1–20 entries. Omitting `model` uses keyword-only search without provider credentials; supplying an allowed model adds semantic retrieval. Browser-local execution and remote/desktop connections use the same service contract and management UI.

Deletion prevents future recall of that record; it does not erase facts already included in past messages, summaries, or durable execution journals. An in-flight request may already contain the old value. For a clean context after removal, start a new conversation.
