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

/** One feature's dictionaries. Korean must translate every English key. */
export interface MessageSet<K extends string> {
  en: Record<K, string>
  ko: Record<K, string>
}

function interpolate(message: string, params: MessageParams): string {
  return message.replace(/\{(\w+)\}/g, (placeholder, name: string) => String(params[name] ?? placeholder))
}

export function translate(locale: Locale, key: MessageKey, params: MessageParams = {}): string {
  return interpolate(messages[locale][key] || en[key], params)
}

export function translateMessages<K extends string>(
  set: MessageSet<K>,
  locale: Locale,
  key: K,
  params: MessageParams = {}
): string {
  return interpolate(set[locale][key] || set.en[key], params)
}

/** Text given in every supported language, for metadata that is read outside the component that owns the copy. */
export type LocalizedText = Record<Locale, string>

export function localizedText<K extends string>(set: MessageSet<K>, key: K): LocalizedText {
  return { en: set.en[key], ko: set.ko[key] }
}

/** A shared dictionary entry in every supported language. */
export function sharedText(key: MessageKey): LocalizedText {
  return { en: en[key], ko: ko[key] }
}
