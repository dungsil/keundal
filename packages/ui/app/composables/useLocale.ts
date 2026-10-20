import { isLocale, resolveLocale, translate, type Locale, type MessageKey, type MessageParams } from '../utils/locale'

export function useLocale() {
  const saved = useCookie<string | undefined>('keundal-locale', {
    maxAge: 60 * 60 * 24 * 365,
    sameSite: 'lax',
    path: '/'
  })
  const locale = useState<Locale>('keundal-locale', () =>
    resolveLocale(
      saved.value,
      import.meta.server ? useRequestHeaders(['accept-language'])['accept-language'] : navigator.languages
    )
  )
  const intlLocale = computed(() => (locale.value === 'ko' ? 'ko-KR' : 'en-US'))

  function setLocale(value: string) {
    if (!isLocale(value)) return
    locale.value = value
    saved.value = value
  }

  function t(key: MessageKey, params?: MessageParams) {
    return translate(locale.value, key, params)
  }

  return { locale: readonly(locale), intlLocale, setLocale, t }
}
