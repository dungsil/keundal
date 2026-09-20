import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite'

import type {
  AGUIEvent,
  AgentMessage,
  GenerationJournalEntry,
  GenerationRequest,
  GenerationStatus,
  RunAgentInput
} from '@keundal/core'

/** 스레드 하나의 확정된 저장 상태입니다. */
export interface StoredThread {
  /** 마지막으로 확정된 revision입니다. */
  revision: number
  /** 확정된 대화 메시지입니다. */
  messages: AgentMessage[]
  /** 마지막으로 확정된 상태입니다. */
  state: RunAgentInput['state']
}

/** 실행 하나의 저장 상태입니다. */
export interface StoredRun {
  readonly runId: string
  readonly threadId: string
  readonly request: GenerationRequest
  /** 실행 중에는 running이며, 종료를 확정하면 terminal 상태가 됩니다. */
  readonly status: GenerationStatus
  readonly journal: GenerationJournalEntry[]
  /** 실행이 생성한 메시지입니다. 실행 중에는 부분 응답이 담깁니다. */
  readonly messages: AgentMessage[]
}

/** 실행의 소유권과 임차 상태입니다. */
export interface RunOwnership {
  readonly runId: string
  readonly status: GenerationStatus
  /** 실행 중인 기록을 확정할 수 있는 서비스의 식별자입니다. */
  readonly ownerId: string | null
  /** 임차 만료 시각입니다. null이면 임차를 연장하지 않는 상태입니다. */
  readonly leaseExpiresAt: number | null
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS threads (
  thread_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  state TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS thread_messages (
  thread_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  message TEXT NOT NULL,
  PRIMARY KEY (thread_id, message_id)
) STRICT;

CREATE INDEX IF NOT EXISTS thread_messages_order ON thread_messages (thread_id, position);

CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  request TEXT NOT NULL,
  status TEXT NOT NULL,
  owner_id TEXT,
  lease_expires_at INTEGER
) STRICT;

CREATE TABLE IF NOT EXISTS run_journal (
  run_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  event TEXT NOT NULL,
  PRIMARY KEY (run_id, sequence)
) STRICT;

CREATE TABLE IF NOT EXISTS run_messages (
  run_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  message TEXT NOT NULL,
  PRIMARY KEY (run_id, message_id)
) STRICT;

CREATE INDEX IF NOT EXISTS run_messages_order ON run_messages (run_id, position);
`

/** 데이터베이스 잠금을 기다리는 최대 시간입니다. */
const BUSY_TIMEOUT_MS = 5_000

const READ_THREAD = 'SELECT revision, state FROM threads WHERE thread_id = ?'
const READ_THREADS = 'SELECT thread_id, revision, state FROM threads ORDER BY rowid'
const READ_THREAD_MESSAGES = 'SELECT message FROM thread_messages WHERE thread_id = ? ORDER BY position'
const ENSURE_THREAD =
  'INSERT INTO threads (thread_id, revision, state) VALUES (?, 0, NULL) ON CONFLICT (thread_id) DO NOTHING'
const WRITE_THREAD = `INSERT INTO threads (thread_id, revision, state) VALUES (?, ?, ?)
ON CONFLICT (thread_id) DO UPDATE SET revision = excluded.revision, state = excluded.state`
const WRITE_THREAD_MESSAGE = `INSERT INTO thread_messages (thread_id, message_id, position, message)
SELECT ?, ?, COALESCE(MAX(position) + 1, 0), ? FROM thread_messages WHERE thread_id = ?
ON CONFLICT (thread_id, message_id) DO UPDATE SET message = excluded.message`

const REGISTER_RUN = `INSERT INTO runs (run_id, thread_id, request, status, owner_id, lease_expires_at)
VALUES (?, ?, ?, 'running', ?, ?) ON CONFLICT (run_id) DO NOTHING`
const ENSURE_RUN = `INSERT INTO runs (run_id, thread_id, request, status, owner_id, lease_expires_at)
VALUES (?, ?, ?, ?, NULL, NULL) ON CONFLICT (run_id) DO NOTHING`
const READ_RUN = 'SELECT run_id, thread_id, request, status FROM runs WHERE run_id = ?'
const READ_RUN_HEADER = 'SELECT thread_id, status FROM runs WHERE run_id = ?'
const READ_RUNS = 'SELECT run_id, thread_id, request, status FROM runs ORDER BY rowid'
const READ_OWNERSHIPS = 'SELECT run_id, status, owner_id, lease_expires_at FROM runs ORDER BY rowid'
const READ_RUNNING = `SELECT 1 FROM runs WHERE run_id = ? AND status = 'running'`
const READ_OWNED = `SELECT 1 FROM runs WHERE run_id = ? AND status = 'running' AND owner_id = ?`
const READ_JOURNAL = 'SELECT sequence, event FROM run_journal WHERE run_id = ? ORDER BY sequence'
const READ_RUN_MESSAGES = 'SELECT message FROM run_messages WHERE run_id = ? ORDER BY position'
const APPEND_JOURNAL = `INSERT INTO run_journal (run_id, sequence, event)
SELECT ?, COALESCE(MAX(sequence) + 1, 0), ? FROM run_journal WHERE run_id = ?`
const WRITE_JOURNAL = `INSERT INTO run_journal (run_id, sequence, event) VALUES (?, ?, ?)
ON CONFLICT (run_id, sequence) DO UPDATE SET event = excluded.event`
const WRITE_RUN_MESSAGE = `INSERT INTO run_messages (run_id, message_id, position, message)
SELECT ?, ?, COALESCE(MAX(position) + 1, 0), ? FROM run_messages WHERE run_id = ?
ON CONFLICT (run_id, message_id) DO UPDATE SET message = excluded.message`
const FINISH_RUN = 'UPDATE runs SET status = ?, owner_id = NULL, lease_expires_at = NULL WHERE run_id = ?'
const ABANDON_RUN = `UPDATE runs SET status = ?, owner_id = NULL, lease_expires_at = NULL
WHERE run_id = ? AND status = 'running' AND owner_id = ?`
const REFRESH_LEASES = `UPDATE runs SET lease_expires_at = ? WHERE status = 'running' AND owner_id = ?`
const RELEASE_LEASES = `UPDATE runs SET lease_expires_at = NULL WHERE status = 'running' AND owner_id = ?`

interface ThreadRow {
  readonly revision: number
  readonly state: string | null
}

interface ThreadListRow {
  readonly thread_id: string
  readonly revision: number
  readonly state: string | null
}

interface RunRow {
  readonly run_id: string
  readonly thread_id: string
  readonly request: string
  readonly status: GenerationStatus
}

interface RunHeaderRow {
  readonly thread_id: string
  readonly status: GenerationStatus
}

interface OwnershipRow {
  readonly run_id: string
  readonly status: GenerationStatus
  readonly owner_id: string | null
  readonly lease_expires_at: number | null
}

interface MessageRow {
  readonly message: string
}

interface JournalRow {
  readonly sequence: number
  readonly event: string
}

const parse = <T>(value: string): T => JSON.parse(value) as T

/**
 * 대화와 실행을 SQLite 데이터베이스 파일에 보관합니다. journal과 실행 메시지는 실행 중에도 행으로
 * 기록되므로 프로세스가 종료되어도 마지막으로 커밋된 지점까지 복구할 수 있습니다. 서비스가 커밋한
 * 변경은 하나의 트랜잭션으로 확정되며, 같은 데이터베이스 파일을 사용하는 다른 연결에서도 읽을 수
 * 있습니다.
 */
export class SqliteStore {
  /** SQLite 연결입니다. 연결 수명은 retain()과 release()로 관리합니다. */
  readonly database: DatabaseSync

  private readonly prepared = new Map<string, StatementSync>()
  private references = 1

  constructor(path: string) {
    try {
      this.database = new DatabaseSync(path, { timeout: BUSY_TIMEOUT_MS })
    } catch (error) {
      throw new Error(`failed to open the SQLite database: ${path}`, { cause: error })
    }
    // WAL은 읽기와 쓰기를 겹치게 하고, NORMAL 동기화는 프로세스가 비정상 종료해도 커밋된 트랜잭션을
    // 보존합니다. 운영체제 자체가 중단되면 마지막 커밋 몇 개가 유실될 수 있습니다.
    this.database.exec('PRAGMA journal_mode = WAL')
    this.database.exec('PRAGMA synchronous = NORMAL')
    this.database.exec(SCHEMA)
  }

  /** 저장소를 사용하는 서비스가 늘어날 때마다 참조를 추가합니다. */
  retain(): void {
    this.references += 1
  }

  /** 참조가 남아 있지 않으면 데이터베이스 연결을 닫습니다. */
  release(): void {
    this.references -= 1
    if (this.references > 0) return
    this.prepared.clear()
    this.database.close()
  }

  /** 하나의 트랜잭션에서 작업을 실행하고, 실패하면 모든 변경을 되돌립니다. */
  transaction<T>(work: () => T): T {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const result = work()
      this.database.exec('COMMIT')
      return result
    } catch (error) {
      try {
        this.database.exec('ROLLBACK')
      } catch {
        // 되돌리기 실패가 원래 오류를 대신하지 않게 합니다.
      }
      throw error
    }
  }

  /** 스레드의 확정된 대화와 상태를 읽습니다. 스레드가 없으면 undefined를 돌려줍니다. */
  readThread(threadId: string): StoredThread | undefined {
    const row = this.row<ThreadRow>(READ_THREAD, threadId)
    if (!row) return undefined
    return {
      revision: row.revision,
      messages: this.rows<MessageRow>(READ_THREAD_MESSAGES, threadId).map((message) =>
        parse<AgentMessage>(message.message)
      ),
      state: row.state === null ? undefined : parse<RunAgentInput['state']>(row.state)
    }
  }

  /** 저장된 모든 스레드를 등록 순서로 읽습니다. */
  listThreads(): Array<{ threadId: string } & StoredThread> {
    return this.rows<ThreadListRow>(READ_THREADS).map((row) => ({
      threadId: row.thread_id,
      revision: row.revision,
      messages: this.rows<MessageRow>(READ_THREAD_MESSAGES, row.thread_id).map((message) =>
        parse<AgentMessage>(message.message)
      ),
      state: row.state === null ? undefined : parse<RunAgentInput['state']>(row.state)
    }))
  }

  /** 스레드가 없으면 revision 0인 빈 스레드를 만듭니다. */
  ensureThread(threadId: string): void {
    this.statement(ENSURE_THREAD).run(threadId)
  }

  /** 스레드의 revision과 상태를 덮어씁니다. */
  writeThread(threadId: string, revision: number, state: RunAgentInput['state']): void {
    this.statement(WRITE_THREAD).run(threadId, revision, state === undefined ? null : JSON.stringify(state))
  }

  /** 스레드의 메시지를 id 기준으로 추가하거나 대체합니다. 새 메시지는 뒤에 붙습니다. */
  writeThreadMessages(threadId: string, messages: readonly AgentMessage[]): void {
    this.writeMessages(WRITE_THREAD_MESSAGE, threadId, messages)
  }

  /**
   * 실행을 running으로 등록합니다. 같은 runId의 기록이 이미 있으면 아무것도 바꾸지 않고 false를
   * 돌려줍니다.
   */
  registerRun(
    runId: string,
    threadId: string,
    request: GenerationRequest,
    ownerId: string,
    leaseExpiresAt: number
  ): boolean {
    const result = this.statement(REGISTER_RUN).run(runId, threadId, JSON.stringify(request), ownerId, leaseExpiresAt)
    return result.changes === 1
  }

  /** 실행 기록을 journal과 메시지까지 읽습니다. 실행이 없으면 undefined를 돌려줍니다. */
  readRun(runId: string): StoredRun | undefined {
    const row = this.row<RunRow>(READ_RUN, runId)
    return row ? this.toRun(row) : undefined
  }

  /** 실행이 속한 스레드와 상태만 읽습니다. 실행이 없으면 undefined를 돌려줍니다. */
  readRunHeader(runId: string): { threadId: string; status: GenerationStatus } | undefined {
    const row = this.row<RunHeaderRow>(READ_RUN_HEADER, runId)
    return row ? { threadId: row.thread_id, status: row.status } : undefined
  }

  /**
   * 실행 기록이 없으면 주어진 상태로 등록합니다. 기록이 이미 있으면 아무것도 바꾸지 않으므로,
   * 종료 커밋이 실행 시작 없이 도착해도 journal과 메시지를 받을 행을 만들 수 있습니다.
   */
  ensureRun(runId: string, threadId: string, request: GenerationRequest, status: GenerationStatus): void {
    this.statement(ENSURE_RUN).run(runId, threadId, JSON.stringify(request), status)
  }

  /** 저장된 모든 실행을 등록 순서로 읽습니다. */
  listRuns(): StoredRun[] {
    return this.rows<RunRow>(READ_RUNS).map((row) => this.toRun(row))
  }

  /** 모든 실행의 상태와 소유권을 등록 순서로 읽습니다. */
  listOwnerships(): RunOwnership[] {
    return this.rows<OwnershipRow>(READ_OWNERSHIPS).map((row) => ({
      runId: row.run_id,
      status: row.status,
      ownerId: row.owner_id,
      leaseExpiresAt: row.lease_expires_at
    }))
  }

  /** 실행이 아직 이 소유자의 실행 중 기록인지 확인합니다. */
  ownsRun(runId: string, ownerId: string): boolean {
    return this.statement(READ_OWNED).get(runId, ownerId) !== undefined
  }

  /** 실행이 아직 종료를 확정하지 않았는지 확인합니다. */
  isRunning(runId: string): boolean {
    return this.statement(READ_RUNNING).get(runId) !== undefined
  }

  /** journal 항목을 마지막 순서 뒤에 추가합니다. */
  appendJournal(runId: string, event: AGUIEvent): void {
    this.statement(APPEND_JOURNAL).run(runId, JSON.stringify(event), runId)
  }

  /** journal 항목을 순서대로 기록하고 같은 순서의 기존 항목을 대체합니다. */
  writeJournal(runId: string, journal: readonly GenerationJournalEntry[]): void {
    const statement = this.statement(WRITE_JOURNAL)
    for (const entry of journal) statement.run(runId, entry.sequence, JSON.stringify(entry.event))
  }

  /** 실행이 생성한 메시지를 id 기준으로 추가하거나 대체합니다. */
  writeRunMessages(runId: string, messages: readonly AgentMessage[]): void {
    this.writeMessages(WRITE_RUN_MESSAGE, runId, messages)
  }

  /** 실행을 종료 상태로 확정하고 소유권을 반납합니다. */
  finishRun(runId: string, status: GenerationStatus): void {
    this.statement(FINISH_RUN).run(status, runId)
  }

  /** 이 소유자가 확정하지 못한 실행 중 기록을 종료 상태로 남깁니다. */
  abandonRun(runId: string, ownerId: string, status: GenerationStatus): void {
    this.statement(ABANDON_RUN).run(status, runId, ownerId)
  }

  /** 이 소유자가 실행 중인 실행의 임차를 연장합니다. */
  refreshLeases(ownerId: string, leaseExpiresAt: number): void {
    this.statement(REFRESH_LEASES).run(leaseExpiresAt, ownerId)
  }

  /** 이 소유자가 실행 중인 실행의 임차를 반납합니다. */
  releaseLeases(ownerId: string): void {
    this.statement(RELEASE_LEASES).run(ownerId)
  }

  private toRun(row: RunRow): StoredRun {
    return {
      runId: row.run_id,
      threadId: row.thread_id,
      request: parse<GenerationRequest>(row.request),
      status: row.status,
      journal: this.rows<JournalRow>(READ_JOURNAL, row.run_id).map((entry) => ({
        sequence: entry.sequence,
        event: parse<AGUIEvent>(entry.event)
      })),
      messages: this.rows<MessageRow>(READ_RUN_MESSAGES, row.run_id).map((message) =>
        parse<AgentMessage>(message.message)
      )
    }
  }

  private writeMessages(sql: string, key: string, messages: readonly AgentMessage[]): void {
    const statement = this.statement(sql)
    for (const message of messages) statement.run(key, message.id, JSON.stringify(message), key)
  }

  /** 조회 결과를 지정한 행 모양으로 읽습니다. */
  private rows<T>(sql: string, ...parameters: SQLInputValue[]): T[] {
    return this.statement(sql).all(...parameters) as unknown as T[]
  }

  /** 조회 결과의 첫 행을 지정한 행 모양으로 읽습니다. */
  private row<T>(sql: string, ...parameters: SQLInputValue[]): T | undefined {
    return this.statement(sql).get(...parameters) as unknown as T | undefined
  }

  /** 같은 SQL의 준비된 문장을 재사용합니다. */
  private statement(sql: string): StatementSync {
    let statement = this.prepared.get(sql)
    if (!statement) {
      statement = this.database.prepare(sql)
      this.prepared.set(sql, statement)
    }
    return statement
  }
}
