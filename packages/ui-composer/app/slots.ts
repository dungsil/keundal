import type {} from '@keundal/ui-slots'
import type { ChatStatus } from '@keundal/chat/chat-message'
import type { FileWithStatus } from '@keundal/chat/file'

/** How a message sent during a run is delivered: after the run, or into the run at its next safe boundary. */
export type DeliveryMode = 'queue' | 'steer'

/** Values a page passes to the `composer` factory. */
export interface ComposerOwner {
  input: string
  setInput(value: string): void
  status?: ChatStatus
  error?: Error
  disabled?: boolean
  files: FileWithStatus[]
  uploading: boolean
  /** Open the file picker. */
  openFiles(): void
  removeFile(id: string): void
  submit(event: Event): void
  stop?(): void
  reload?(): void
  /** Present on a conversation page, where messages can be sent while a run is active. */
  delivery?: DeliveryMode
  setDelivery?(mode: DeliveryMode): void
  /** `docked` squares the bottom corners for a composer attached to the bottom of a page. */
  variant?: 'standalone' | 'docked'
}

/** Values every composer action receives. */
export interface ComposerActionOwner {
  disabled: boolean
}

export type DictationState = 'idle' | 'recording' | 'transcribing'

/** Values the dictation control receives. */
export interface ComposerDictationOwner {
  state: DictationState
  setState(state: DictationState): void
  /** Interim transcript shown as the placeholder. */
  setPreview(text: string): void
  disabled: boolean
  appendTranscript(text: string): void
}

declare module '@keundal/ui-slots' {
  interface FactoryMap {
    /** The prompt input with its menu, actions and submit control. */
    composer: { owner: ComposerOwner }
  }
  interface SlotMap {
    /** Controls between the prompt menu and the submit button, ordered by `order`. */
    'composer.actions': { kind: 'list'; owner: ComposerActionOwner }
    /** Shown instead of the submit button while the prompt is empty; the submit button renders when absent. */
    'composer.dictation': { kind: 'single'; owner: ComposerDictationOwner }
  }
}
