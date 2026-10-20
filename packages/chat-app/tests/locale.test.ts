import { describe, expect, test } from 'vitest'
import en from '../../../packages/ui/app/locales/en'
import ko from '../../../packages/ui/app/locales/ko'
import { resolveLocale, translate } from '../../../packages/ui/app/utils/locale'

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
    expect(translate('ko', 'skill.enable', { name: 'my-$&-{name}' })).toBe('my-$&-{name} 활성화')
    expect(translate('en', 'llm.headerKey', { index: 2 })).toBe('Header 2 key')
    expect(translate('ko', 'llm.headerKey', { index: 2 })).toBe('헤더 2 키')
  })

  test('한국어 사전은 모든 영어 문구와 보간 변수를 포함한다', () => {
    expect(Object.keys(ko).sort()).toEqual(Object.keys(en).sort())
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect(ko[key].trim(), key).not.toBe('')
      expect(ko[key].match(/\{\w+\}/g)?.sort() ?? [], key)
        .toEqual(en[key].match(/\{\w+\}/g)?.sort() ?? [])
    }
  })
})
