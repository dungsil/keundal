/** Durable attachment data, independent of the parser and storage backend. */
export type StoredAttachment = {
  type: 'file'
  mediaType: string
  filename?: string
  /** Images retain their data URL. Documents store only extracted text, never a remote URL. */
  url: string
  text?: string
}

export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024
export const MAX_DOCUMENT_CHARACTERS = 200_000
export const DOCUMENT_MEDIA_TYPES = ['application/pdf', 'text/csv', 'text/plain'] as const

export class AttachmentError extends Error {
  constructor(readonly code: 'unsupported' | 'tooLarge' | 'tooMuchText' | 'invalidDocument' | 'emptyDocument') {
    super(code)
  }
}

export interface FileWithStatus {
  file: File
  id: string
  previewUrl: string
  status: 'uploading' | 'uploaded' | 'error'
  attachment?: StoredAttachment
  error?: string
}

export const FILE_UPLOAD_CONFIG = {
  maxSize: '8MB',
  types: ['image', ...DOCUMENT_MEDIA_TYPES],
  acceptPattern: 'image/*,application/pdf,.pdf,.csv,text/csv,.txt,text/plain'
} as const

export function getFileIcon(mimeType: string, fileName?: string): string {
  if (mimeType.startsWith('image/')) return 'i-lucide-image'
  if (mimeType === 'application/pdf') return 'i-lucide-file-text'
  if (mimeType === 'text/csv' || fileName?.endsWith('.csv')) return 'i-lucide-file-spreadsheet'
  return 'i-lucide-file'
}
