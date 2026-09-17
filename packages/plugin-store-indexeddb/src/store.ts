import {
  mergeMessages,
  type AGUIEvent,
  type AgentMessage,
  type GenerationJournalEntry,
  type GenerationRequest,
  type GenerationSnapshot,
  type GenerationStatus,
  type RunAgentInput,
  type SessionCommit,
  type SessionSnapshot
} from '@keundal/core'

import { recordJournal } from './messages.js'

const DATABASE_VERSION = 1
const THREADS = 'threads'
const RUNS = 'runs'
const JOURNAL = 'journal'

export interface WebLockManager {
  request<T>(
    name: string,
    options: { readonly mode?: 'exclusive'; readonly ifAvailable?: boolean; readonly signal?: AbortSignal },
    callback: (lock: unknown | null) => T | Promise<T>
  ): Promise<T>
}

export interface IndexedDBStoreOptions {
  /** 브라우저마다 분리되는 IndexedDB 데이터베이스 이름입니다. 기본값은 `keundal`입니다. */
  readonly databaseName?: string
  /** 테스트 또는 별도 브라우저 컨텍스트에서 사용할 IndexedDB 구현입니다. */
  readonly indexedDB?: IDBFactory
  /** 테스트 환경에서만 필요한 Web Locks 구현입니다. 브라우저에서는 navigator.locks를 사용합니다. */
  readonly locks?: WebLockManager
}

interface StoredThread {
  readonly threadId: string
  readonly revision: number
  readonly messages: AgentMessage[]
  readonly state: RunAgentInput['state']
}

interface StoredRun {
  readonly runId: string
  readonly threadId: string
  readonly request: GenerationRequest
  readonly status: GenerationStatus
  /** journal에 확정된 다음 sequence 번호입니다. */
  readonly nextSequence: number
}

interface StoredJournal {
  readonly runId: string
  readonly sequence: number
  readonly event: AGUIEvent
}

/** IndexedDB에 session, generation, append-only journal을 보관합니다. */
export class IndexedDBStore {
  readonly databaseName: string

  private readonly idb: IDBFactory
  private readonly lockManager?: WebLockManager
  private database?: Promise<IDBDatabase>
  private closed = false

  constructor(options: IndexedDBStoreOptions = {}) {
    this.databaseName = options.databaseName ?? 'keundal'
    if (!this.databaseName.trim()) throw new Error('databaseName must be a non-empty string')
    const indexedDB = options.indexedDB ?? globalThis.indexedDB
    if (!indexedDB) throw new Error('IndexedDB is unavailable in this environment')
    this.idb = indexedDB
    this.lockManager = options.locks
  }

  async getThread(threadId: string, signal?: AbortSignal): Promise<SessionSnapshot | undefined> {
    const stored = await this.transaction(
      [THREADS],
      'readonly',
      async (transaction) => request<StoredThread | undefined>(transaction.objectStore(THREADS).get(threadId)),
      signal
    )
    return stored && snapshotThread(stored)
  }

  async prepareThread(threadId: string, signal?: AbortSignal): Promise<StoredThread | undefined> {
    return this.transaction(
      [THREADS],
      'readonly',
      async (transaction) => request<StoredThread | undefined>(transaction.objectStore(THREADS).get(threadId)),
      signal
    )
  }

  async startRun(run: GenerationRequest): Promise<void> {
    await this.transaction([THREADS, RUNS], 'readwrite', async (transaction) => {
      const runs = transaction.objectStore(RUNS)
      if (await request<StoredRun | undefined>(runs.get(run.input.runId)))
        throw new Error(`generation run is already recorded: ${run.input.runId}`)
      const threads = transaction.objectStore(THREADS)
      if (!(await request<StoredThread | undefined>(threads.get(run.input.threadId)))) {
        threads.add({
          threadId: run.input.threadId,
          revision: 0,
          messages: [],
          state: undefined
        } satisfies StoredThread)
      }
      runs.add({
        runId: run.input.runId,
        threadId: run.input.threadId,
        request: run,
        status: 'running',
        nextSequence: 0
      } satisfies StoredRun)
    })
  }

  /** 이벤트 하나를 append-only journal에 먼저 확정합니다. */
  async appendEvent(runId: string, event: AGUIEvent): Promise<void> {
    await this.transaction([RUNS, JOURNAL], 'readwrite', async (transaction) => {
      const runs = transaction.objectStore(RUNS)
      const run = await request<StoredRun | undefined>(runs.get(runId))
      if (!run || run.status !== 'running') throw new Error(`generation run is not active: ${runId}`)
      transaction.objectStore(JOURNAL).add({ runId, sequence: run.nextSequence, event } satisfies StoredJournal)
      runs.put({ ...run, nextSequence: run.nextSequence + 1 } satisfies StoredRun)
    })
  }

  async getRun(runId: string): Promise<GenerationSnapshot | undefined> {
    const stored = await this.transaction([RUNS, JOURNAL], 'readonly', async (transaction) => {
      const run = await request<StoredRun | undefined>(transaction.objectStore(RUNS).get(runId))
      if (!run) return undefined
      const journal = await readJournal(transaction.objectStore(JOURNAL), runId)
      return { run, journal }
    })
    return stored && snapshotRun(stored.run, stored.journal)
  }

  async listRuns(): Promise<GenerationSnapshot[]> {
    const stored = await this.transaction([RUNS, JOURNAL], 'readonly', async (transaction) => {
      const runs = (await request<StoredRun[]>(transaction.objectStore(RUNS).getAll())).sort((a, b) =>
        a.runId.localeCompare(b.runId)
      )
      return Promise.all(
        runs.map(async (run) => ({ run, journal: await readJournal(transaction.objectStore(JOURNAL), run.runId) }))
      )
    })
    return stored.map(({ run, journal }) => snapshotRun(run, journal))
  }

  /** session revision과 generation 종료 기록을 한 트랜잭션에서 반영합니다. */
  async commit(change: SessionCommit, signal?: AbortSignal): Promise<SessionSnapshot> {
    return this.transaction(
      [THREADS, RUNS, JOURNAL],
      'readwrite',
      async (transaction) => {
        const threads = transaction.objectStore(THREADS)
        const current =
          (await request<StoredThread | undefined>(threads.get(change.threadId))) ??
          ({ threadId: change.threadId, revision: 0, messages: [], state: undefined } satisfies StoredThread)
        const generation = change.generation
        let running: StoredRun | undefined
        if (generation) {
          const runId = generation.request.input.runId
          if (!runId) throw new Error('generation commit requires a runId')
          if (generation.request.input.threadId !== change.threadId)
            throw new Error(`generation ${runId} belongs to another thread: ${generation.request.input.threadId}`)
          const runs = transaction.objectStore(RUNS)
          const run = await request<StoredRun | undefined>(runs.get(runId))
          // 이미 확정된 같은 실행은 revision과 메시지를 다시 반영하지 않습니다.
          if (run && run.threadId !== change.threadId)
            throw new Error(`generation ${runId} belongs to another thread: ${run.threadId}`)
          if (run && run.status !== 'running') return snapshotThread(current)
          running = run
        }
        if (current.revision !== change.expectedRevision) {
          throw new Error(
            `session revision conflict for ${change.threadId}: expected ${change.expectedRevision}, stored ${current.revision}`
          )
        }

        if (generation) {
          const runId = generation.request.input.runId
          const runs = transaction.objectStore(RUNS)
          const run = running
          if (run) {
            if (generation.journal.length < run.nextSequence)
              throw new Error(`generation journal is truncated for ${runId}`)
            const missing = generation.journal.slice(run.nextSequence)
            for (const [offset, entry] of missing.entries()) {
              if (entry.sequence !== run.nextSequence + offset)
                throw new Error(`generation journal sequence is invalid for ${runId}`)
              transaction
                .objectStore(JOURNAL)
                .add({ runId, sequence: entry.sequence, event: entry.event } satisfies StoredJournal)
            }
            runs.put({ ...run, status: generation.status, nextSequence: generation.journal.length } satisfies StoredRun)
          } else {
            for (const entry of generation.journal)
              transaction
                .objectStore(JOURNAL)
                .add({ runId, sequence: entry.sequence, event: entry.event } satisfies StoredJournal)
            runs.add({
              runId,
              threadId: change.threadId,
              request: generation.request,
              status: generation.status,
              nextSequence: generation.journal.length
            } satisfies StoredRun)
          }
        }

        const next: StoredThread = {
          threadId: change.threadId,
          revision: current.revision + 1,
          messages: mergeMessages(current.messages, change.messages),
          state: change.state ?? current.state
        }
        threads.put(next)
        return snapshotThread(next)
      },
      signal
    )
  }

  async markInterrupted(runId: string): Promise<void> {
    await this.transaction([RUNS], 'readwrite', async (transaction) => {
      const runs = transaction.objectStore(RUNS)
      const run = await request<StoredRun | undefined>(runs.get(runId))
      if (run?.status === 'running') runs.put({ ...run, status: 'interrupted' } satisfies StoredRun)
    })
  }

  async withRunLock<T>(
    runId: string,
    signal: AbortSignal,
    callback: () => Promise<T>
  ): Promise<{ value: T; release: () => Promise<void> }> {
    const locks = this.locks()
    const release = Promise.withResolvers<void>()
    const acquired = Promise.withResolvers<void>()
    signal.throwIfAborted()
    const requestPromise = locks.request(
      this.lockName(runId),
      { mode: 'exclusive', ifAvailable: true },
      async (lock) => {
        if (!lock) throw new Error(`generation run is already active: ${runId}`)
        signal.throwIfAborted()
        acquired.resolve()
        await release.promise
      }
    )
    try {
      await Promise.race([acquired.promise, requestPromise])
      const value = await callback()
      return {
        value,
        release: async () => {
          release.resolve()
          await requestPromise
        }
      }
    } catch (error) {
      release.resolve()
      await requestPromise.catch(() => {})
      throw error
    }
  }

  async recoverIfUnlocked(runId: string, signal: AbortSignal, callback: () => Promise<void>): Promise<boolean> {
    const locks = this.locks()
    signal.throwIfAborted()
    return locks.request(this.lockName(runId), { mode: 'exclusive', ifAvailable: true }, async (lock) => {
      if (!lock) return false
      signal.throwIfAborted()
      await callback()
      return true
    })
  }

  close(): void {
    this.closed = true
    void this.database?.then((database) => database.close()).catch(() => {})
  }

  private locks(): WebLockManager {
    const locks =
      this.lockManager ?? (globalThis.navigator as (Navigator & { locks?: WebLockManager }) | undefined)?.locks
    if (!locks) throw new Error('Web Locks API is required; use a secure browser context with navigator.locks')
    return locks
  }

  private lockName(runId: string): string {
    return `keundal:indexeddb:${this.databaseName}:run:${runId}`
  }

  private async transaction<T>(
    stores: string[],
    mode: IDBTransactionMode,
    body: (transaction: IDBTransaction) => Promise<T>,
    signal?: AbortSignal
  ): Promise<T> {
    if (this.closed) throw new Error('indexeddb store is closed')
    signal?.throwIfAborted()
    const database = await this.open()
    signal?.throwIfAborted()
    const transaction =
      mode === 'readwrite'
        ? database.transaction(stores, mode, { durability: 'strict' })
        : database.transaction(stores, mode)
    const complete = transactionDone(transaction)
    const abort = () => transaction.abort()
    signal?.addEventListener('abort', abort, { once: true })
    try {
      const value = await body(transaction)
      await complete
      return value
    } catch (error) {
      try {
        transaction.abort()
      } catch {
        // 이미 완료된 transaction은 중단할 수 없습니다.
      }
      await complete.catch(() => {})
      throw error
    } finally {
      signal?.removeEventListener('abort', abort)
    }
  }

  private open(): Promise<IDBDatabase> {
    if (this.closed) return Promise.reject(new Error('indexeddb store is closed'))
    this.database ??= this.openDatabase()
    return this.database
  }

  private openDatabase(): Promise<IDBDatabase> {
    const opening = new Promise<IDBDatabase>((resolve, reject) => {
      let settled = false
      const settle = (callback: () => void) => {
        if (settled) return false
        settled = true
        callback()
        return true
      }
      const request = this.idb.open(this.databaseName, DATABASE_VERSION)
      request.onupgradeneeded = () => {
        const database = request.result
        if (!database.objectStoreNames.contains(THREADS)) database.createObjectStore(THREADS, { keyPath: 'threadId' })
        if (!database.objectStoreNames.contains(RUNS)) database.createObjectStore(RUNS, { keyPath: 'runId' })
        if (!database.objectStoreNames.contains(JOURNAL)) {
          const journal = database.createObjectStore(JOURNAL, { keyPath: ['runId', 'sequence'] })
          journal.createIndex('by-run', 'runId')
        }
      }
      request.onsuccess = () => {
        const database = request.result
        database.onversionchange = () => database.close()
        if (!settle(() => resolve(database))) database.close()
      }
      request.onerror = () =>
        settle(() => reject(request.error ?? new Error(`could not open IndexedDB ${this.databaseName}`)))
      request.onblocked = () =>
        settle(() => reject(new Error(`opening IndexedDB ${this.databaseName} is blocked by another tab`)))
    })
    // 열기는 onblocked 등 일시적 상황으로 실패할 수 있으므로 캐시를 비워 다음 호출이 다시
    // 시도하게 합니다. 블록이 풀린 뒤의 onsuccess는 이미 거부된 약속을 되살리지 못합니다.
    opening.catch(() => {
      if (this.database === opening) this.database = undefined
    })
    return opening
  }
}

function snapshotThread(thread: StoredThread): SessionSnapshot {
  return { threadId: thread.threadId, revision: thread.revision, messages: thread.messages, state: thread.state }
}

function snapshotRun(run: StoredRun, journal: GenerationJournalEntry[]): GenerationSnapshot {
  const recorder = recordJournal(journal)
  return { request: run.request, status: run.status, journal, messages: recorder.messages }
}

async function readJournal(store: IDBObjectStore, runId: string): Promise<GenerationJournalEntry[]> {
  const records = (await request<StoredJournal[]>(store.index('by-run').getAll(runId))).sort(
    (a, b) => a.sequence - b.sequence
  )
  return records.map(({ sequence, event }) => ({ sequence, event }))
}

function request<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'))
  })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'))
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'))
  })
}
