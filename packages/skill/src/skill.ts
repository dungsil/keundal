import type { ExecutionOptions } from '@keundal/core'
import { Service, type Context } from 'cordis'

export interface SkillSummary {
  readonly name: string
  readonly description: string
}

export interface SkillDefinition extends SkillSummary {
  readonly content: string
  readonly resources?: readonly string[]
}

/** 목록과 이름별 공급자 선택은 고정하며, 본문은 load를 호출할 때 읽습니다. */
export interface SkillCatalog {
  readonly skills: readonly SkillSummary[]
  load(name: string, options?: ExecutionOptions): Promise<SkillDefinition | undefined>
  readResource?(name: string, path: string, options?: ExecutionOptions): Promise<string | undefined>
}

export function isSkillResourcePath(path: string): boolean {
  return (
    /^(references|assets|scripts)\/.+/.test(path) &&
    !path.includes('\\') &&
    !path.includes('\0') &&
    !path.split('/').some((part) => !part || part === '.' || part === '..')
  )
}

export interface SkillProvider {
  readonly name: string
  prepare(options?: ExecutionOptions): Promise<SkillCatalog>
}

export abstract class SkillService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'skills')
  }

  /** 먼저 등록한 공급자가 동명 스킬을 제공합니다. 반환한 함수로 등록을 해제합니다. */
  abstract registerProvider(provider: SkillProvider): () => void

  abstract prepare(options?: ExecutionOptions): Promise<SkillCatalog>
}

declare module 'cordis' {
  interface Context {
    readonly skills: SkillService
  }
}
