import {
  isLocale,
  resolveLocale,
  translate,
  translateMessages,
  type Locale,
  type MessageKey,
  type MessageParams,
  type MessageSet
} from '../utils/locale'

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

/**
 * Create a feature's translation composable. Its `t` resolves the feature's own keys first and then the shared
 * dictionary, so a plugin package owns the copy only it uses.
 */
export function defineMessages<K extends string>(set: MessageSet<K>) {
  const owns = (key: string): key is K => Object.hasOwn(set.en, key)
  return function useMessages() {
    const shared = useLocale()
    function t(key: K | MessageKey, params?: MessageParams) {
      return owns(key) ? translateMessages(set, shared.locale.value, key, params) : shared.t(key, params)
    }
    return { ...shared, t }
  }
}
