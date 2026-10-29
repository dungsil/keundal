import Papa from 'papaparse'
import type { TextContent } from 'pdfjs-dist/types/src/display/api'

import { AttachmentError, MAX_ATTACHMENT_BYTES, MAX_DOCUMENT_CHARACTERS, type StoredAttachment } from './file'

function checkedText(text: string): string {
  if (text.length > MAX_DOCUMENT_CHARACTERS) throw new AttachmentError('tooMuchText')
  if (!text.trim()) throw new AttachmentError('emptyDocument')
  return text
}

async function pdfText(bytes: Uint8Array, workerSrc?: string, signal?: AbortSignal): Promise<string> {
  const { getDocument, GlobalWorkerOptions } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  if (workerSrc) GlobalWorkerOptions.workerSrc = workerSrc
  signal?.throwIfAborted()
  const task = getDocument({
    data: bytes,
    useSystemFonts: false,
    disableFontFace: true,
    verbosity: 0,
    // Do not prompt for passwords or hang on encrypted documents.
    password: ''
  })
  const abort = () => {
    void task.destroy()
  }
  signal?.addEventListener('abort', abort, { once: true })
  try {
    const document = await task.promise
    if (document.numPages > 200) throw new AttachmentError('tooMuchText')
    let text = ''
    for (let number = 1; number <= document.numPages; number++) {
      signal?.throwIfAborted()
      const page = await document.getPage(number)
      const reader = (page.streamTextContent() as ReadableStream<TextContent>).getReader()
      try {
        while (true) {
          signal?.throwIfAborted()
          const { value, done } = await reader.read()
          if (done) break
          text += value.items.map((item) => ('str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '')).join('')
          if (text.length > MAX_DOCUMENT_CHARACTERS) throw new AttachmentError('tooMuchText')
        }
      } finally {
        reader.releaseLock()
      }
      text += '\n'
      page.cleanup()
      if (text.length > MAX_DOCUMENT_CHARACTERS) throw new AttachmentError('tooMuchText')
    }
    return checkedText(text)
  } finally {
    signal?.removeEventListener('abort', abort)
    await task.destroy()
  }
}

/** Parse locally; only images keep original bytes. No upload, URL fetching, or parser diagnostics escape. */
export async function prepareAttachment(
  file: File,
  options: { pdfWorkerSrc?: string; signal?: AbortSignal } = {}
): Promise<StoredAttachment> {
  const { signal } = options
  signal?.throwIfAborted()
  if (file.size > MAX_ATTACHMENT_BYTES) throw new AttachmentError('tooLarge')
  // Extensions are only a fallback for browsers that omit/guess a generic MIME type.
  const mediaType =
    !file.type || file.type === 'application/octet-stream'
      ? ({ pdf: 'application/pdf', csv: 'text/csv', txt: 'text/plain' }[file.name.split('.').pop()!.toLowerCase()] ??
        '')
      : file.type
  if (!mediaType.startsWith('image/') && !['application/pdf', 'text/csv', 'text/plain'].includes(mediaType))
    throw new AttachmentError('unsupported')
  try {
    const bytes = new Uint8Array(await file.arrayBuffer())
    signal?.throwIfAborted()
    if (mediaType.startsWith('image/')) {
      const chunks: string[] = []
      for (let offset = 0; offset < bytes.length; offset += 8192)
        chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)))
      return { type: 'file', filename: file.name, mediaType, url: `data:${mediaType};base64,${btoa(chunks.join(''))}` }
    }
    let text: string
    if (mediaType === 'application/pdf') text = await pdfText(bytes, options.pdfWorkerSrc, signal)
    else {
      text = checkedText(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
      // oxlint-disable-next-line no-control-regex -- Reject binary control bytes in text documents.
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(text)) throw new AttachmentError('invalidDocument')
      if (mediaType === 'text/csv') {
        const parsed = Papa.parse<string[]>(text, { delimiter: ',', skipEmptyLines: 'greedy' })
        if (parsed.errors.length) throw new AttachmentError('invalidDocument')
        if (!parsed.data.length) throw new AttachmentError('emptyDocument')
        // Preserve quoted commas, embedded newlines, empty cells, and literal formula strings.
        text = checkedText(JSON.stringify(parsed.data))
      }
    }
    signal?.throwIfAborted()
    return { type: 'file', filename: file.name, mediaType, url: '', text }
  } catch (error) {
    signal?.throwIfAborted()
    if (error instanceof AttachmentError) throw error
    throw new AttachmentError('invalidDocument')
  }
}
