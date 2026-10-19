import { Service, type Context } from 'cordis'

import type { ExecutionOptions } from './execution.js'

export interface FileSystemOptions extends ExecutionOptions {
  /** 정책이 읽기 기록을 구분하는 호출자 ID입니다. 도구는 threadId를 사용합니다. */
  readonly scope?: string
}

export interface FileMutationOptions extends FileSystemOptions {
  /** null은 새 파일만 만듭니다. 생략해도 기존 파일을 덮어쓰지 않습니다. */
  readonly expectedVersion?: string | null
}

export interface FileSnapshot {
  readonly path: string
  readonly content: string
  readonly version: string
}

export interface FileMutation {
  readonly path: string
  readonly version: string
}

export interface DirectoryEntry {
  readonly name: string
  readonly kind: 'file' | 'directory' | 'symlink' | 'other'
}

export interface FileEdit {
  readonly oldText: string
  readonly newText: string
}

export abstract class FileSystemService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'fs')
  }

  /** 기존 경로는 링크를 해석하고, 새 경로는 기존 조상을 기준으로 해석합니다. */
  abstract resolve(path: string, options?: ExecutionOptions): Promise<string>
  /** resolve()가 반환한 경로를 공급자의 경로 규칙으로 비교합니다. */
  abstract contains(root: string, path: string): boolean
  abstract read(path: string, options?: FileSystemOptions): Promise<FileSnapshot>
  abstract list(path: string, options?: FileSystemOptions): Promise<readonly DirectoryEntry[]>
  abstract write(path: string, content: string, options?: FileMutationOptions): Promise<FileMutation>
  /** oldText가 정확히 한 번 나타날 때만 바꿉니다. */
  abstract edit(path: string, edit: FileEdit, options?: FileMutationOptions): Promise<FileMutation>
}
