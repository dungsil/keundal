import { defineMessages } from '@keundal/ui/app/composables/useLocale.ts'

import en from './locales/en'
import ko from './locales/ko'

export const messages = { en, ko }

/** Translations of this plugin; keys it does not own fall back to the shared dictionary. */
export const useText = defineMessages(messages)
