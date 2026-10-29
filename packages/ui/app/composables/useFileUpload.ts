import { AttachmentError, type FileWithStatus, FILE_UPLOAD_CONFIG } from '@keundal/chat/file'
import pdfWorkerSrc from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'

export function useFileUploadWithStatus() {
  const { t } = useLocale()
  const files = ref<FileWithStatus[]>([])
  const toast = useToast()
  const pending = new Set<AbortController>()

  async function uploadFiles(newFiles: File[]) {
    // Document parsers run only after a browser file selection, never in the SSR/Workers bundle.
    if (import.meta.server) return
    const controller = new AbortController()
    pending.add(controller)
    const filesWithStatus: FileWithStatus[] = newFiles.map((file) => ({
      file,
      id: crypto.randomUUID(),
      previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : '',
      status: 'uploading' as const
    }))

    files.value = [...files.value, ...filesWithStatus]

    const uploadPromises = filesWithStatus.map(async (fileWithStatus) => {
      try {
        const { prepareAttachment } = await import('@keundal/chat/documents')
        const attachment = await prepareAttachment(fileWithStatus.file, { pdfWorkerSrc, signal: controller.signal })
        const current = files.value.find((f) => f.id === fileWithStatus.id)
        if (!current) return
        Object.assign(current, {
          status: 'uploaded',
          attachment
        })
      } catch (error) {
        const current = files.value.find((f) => f.id === fileWithStatus.id)
        if (!current || controller.signal.aborted) return
        const errorMessage = error instanceof AttachmentError ? t(`file.${error.code}`) : t('file.failed')
        toast.add({
          title: t('file.failed'),
          description: errorMessage,
          icon: 'i-lucide-alert-circle',
          color: 'error',
          duration: 0
        })
        Object.assign(current, {
          status: 'error',
          error: errorMessage
        })
      }
    })

    await Promise.allSettled(uploadPromises)
    pending.delete(controller)
  }

  const { dropzoneRef, isDragging, open } = useFileUpload({
    accept: FILE_UPLOAD_CONFIG.acceptPattern,
    multiple: true,
    onUpdate: uploadFiles
  })

  const uploading = computed(() => files.value.some((f) => f.status === 'uploading'))

  const uploadedFiles = computed(() =>
    // Strip Vue's reactive proxy before the message reaches structured-clone storage.
    files.value.flatMap((f) => (f.status === 'uploaded' && f.attachment ? [{ ...f.attachment }] : []))
  )

  function removeFile(id: string) {
    const file = files.value.find((f) => f.id === id)
    if (!file) return

    URL.revokeObjectURL(file.previewUrl)
    files.value = files.value.filter((f) => f.id !== id)
  }

  function clearFiles() {
    for (const controller of pending) controller.abort()
    pending.clear()
    if (files.value.length === 0) return
    files.value.forEach((fileWithStatus) => URL.revokeObjectURL(fileWithStatus.previewUrl))
    files.value = []
  }

  onUnmounted(() => {
    clearFiles()
  })

  return {
    dropzoneRef,
    dragging: isDragging,
    open,
    files,
    uploading,
    uploadedFiles,
    addFiles: uploadFiles,
    removeFile,
    clearFiles
  }
}
