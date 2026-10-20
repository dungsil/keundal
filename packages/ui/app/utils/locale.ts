import en from '../locales/en'
import ko from '../locales/ko'

export const SUPPORTED_LOCALES = ['en', 'ko'] as const
export type Locale = (typeof SUPPORTED_LOCALES)[number]
export type MessageKey = keyof typeof en
export type MessageParams = Record<string, string | number>

const messages = { en, ko }

export function isLocale(value: unknown): value is Locale {
  return value === 'en' || value === 'ko'
}

/** A saved choice takes precedence over the browser's ordered language preferences. */
export function resolveLocale(saved?: unknown, languages: string | readonly string[] = []): Locale {
  if (isLocale(saved)) return saved
  const preferences =
    typeof languages === 'string'
      ? languages
          .split(',')
          .map((entry, index) => {
            const [language = '', ...parameters] = entry.trim().split(';')
            const quality = parameters.find((value) => value.trim().startsWith('q='))
            return { language, quality: quality ? Number(quality.trim().slice(2)) : 1, index }
          })
          .filter((entry) => entry.quality > 0 && entry.quality <= 1)
          .sort((a, b) => b.quality - a.quality || a.index - b.index)
          .map((entry) => entry.language)
      : languages

  for (const preference of preferences) {
    const language = preference.trim().toLowerCase().split('-')[0]
    if (isLocale(language)) return language
  }
  return 'en'
}

export function translate(locale: Locale, key: MessageKey, params: MessageParams = {}): string {
  const message = messages[locale][key] || en[key]
  return message.replace(/\{(\w+)\}/g, (placeholder, name: string) => String(params[name] ?? placeholder))
}
