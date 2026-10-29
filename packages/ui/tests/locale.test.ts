import { existsSync, readdirSync } from 'node:fs'

import { describe, expect, test } from 'vitest'

import llmEn from '../../ui-settings-llm/app/locales/en'
import llmKo from '../../ui-settings-llm/app/locales/ko'
import skillEn from '../../ui-skill/app/locales/en'
import skillKo from '../../ui-skill/app/locales/ko'
import en from '../app/locales/en'
import ko from '../app/locales/ko'
import { resolveLocale, translate, translateMessages } from '../app/utils/locale'

type Dictionary = Record<string, string>

// Every UI plugin's dictionaries. The list is read from the workspace so a new plugin is checked without editing this test.
const packages = new URL('../../', import.meta.url)
const plugins = readdirSync(packages).filter(
  (name) => name.startsWith('ui-') && existsSync(new URL(`${name}/app/locales/en.ts`, packages))
)
async function load(path: string): Promise<Dictionary> {
  const module: { default: Dictionary } = await import(path)
  return module.default
}
const dictionaries = await Promise.all(
  plugins.map(async (name) => ({
    name,
    en: await load(new URL(`${name}/app/locales/en.ts`, packages).href),
    ko: await load(new URL(`${name}/app/locales/ko.ts`, packages).href)
  }))
)

describe('표시 언어 결정', () => {
  test('저장된 언어가 브라우저 언어보다 우선한다', () => {
    expect(resolveLocale('en', 'ko-KR,ko;q=0.9')).toBe('en')
    expect(resolveLocale('ko', ['en-US'])).toBe('ko')
  })

  test('지역 태그와 언어 선호도 순서를 처리한다', () => {
    expect(resolveLocale(undefined, ['fr-FR', 'ko-KR', 'en-US'])).toBe('ko')
    expect(resolveLocale(undefined, 'en;q=0.5, ko-KR;q=0.9')).toBe('ko')
    expect(resolveLocale(undefined, 'en-US,ko;q=0.9')).toBe('en')
    expect(resolveLocale(undefined, ['KO-kr'])).toBe('ko')
  })

  test('지원하지 않는 저장 값과 허용하지 않은 언어를 건너뛴다', () => {
    expect(resolveLocale('fr', 'ko;q=0,en;q=0.8')).toBe('en')
    expect(resolveLocale('invalid', 'en;q=invalid,ko;q=0.5')).toBe('ko')
    expect(resolveLocale(undefined, 'fr-FR,ja-JP')).toBe('en')
    expect(resolveLocale()).toBe('en')
  })
})

describe('화면 번역', () => {
  test('같은 키를 선택한 언어로 표시한다', () => {
    expect(translate('ko', 'chat.new')).toBe('새 대화')
    expect(translate('en', 'chat.new')).toBe('New chat')
  })

  test('사용자가 작성한 이름과 경로를 번역하거나 재해석하지 않는다', () => {
    expect(translateMessages({ en: skillEn, ko: skillKo }, 'ko', 'skill.enable', { name: 'my-$&-{name}' })).toBe(
      'my-$&-{name} 활성화'
    )
    expect(translateMessages({ en: llmEn, ko: llmKo }, 'en', 'llm.headerKey', { index: 2 })).toBe('Header 2 key')
    expect(translateMessages({ en: llmEn, ko: llmKo }, 'ko', 'llm.headerKey', { index: 2 })).toBe('헤더 2 키')
  })

  test('플러그인 사전은 서로, 그리고 공유 사전과 키가 겹치지 않는다', () => {
    const owners = new Map<string, string>(Object.keys(en).map((key) => [key, 'ui']))
    for (const dictionary of dictionaries) {
      for (const key of Object.keys(dictionary.en)) {
        expect(owners.get(key), `${key}: ${dictionary.name}`).toBeUndefined()
        owners.set(key, dictionary.name)
      }
    }
  })

  test('한국어 사전은 모든 영어 문구와 보간 변수를 포함한다', () => {
    const sets: { en: Dictionary; ko: Dictionary }[] = [{ en, ko }, ...dictionaries]
    expect(plugins).toContain('ui-chat')
    for (const set of sets) {
      expect(Object.keys(set.ko).sort()).toEqual(Object.keys(set.en).sort())
      for (const key of Object.keys(set.en)) {
        expect(set.ko[key]!.trim(), key).not.toBe('')
        expect(set.ko[key]!.match(/\{\w+\}/g)?.sort() ?? [], key).toEqual(set.en[key]!.match(/\{\w+\}/g)?.sort() ?? [])
      }
    }
  })
})
