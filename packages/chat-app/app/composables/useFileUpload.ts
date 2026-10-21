function createObjectUrl(file: File): string {
  return URL.createObjectURL(file)
}

export function useFileUploadWithStatus() {
  const { t } = useLocale()
  const files = ref<FileWithStatus[]>([])
  const toast = useToast()

  async function uploadFiles(newFiles: File[]) {
    const filesWithStatus: FileWithStatus[] = newFiles.map(file => ({
      file,
      id: crypto.randomUUID(),
      previewUrl: createObjectUrl(file),
      status: 'uploading' as const
    }))

    files.value = [...files.value, ...filesWithStatus]

    const uploadPromises = filesWithStatus.map(async (fileWithStatus) => {
      const index = files.value.findIndex(f => f.id === fileWithStatus.id)
      if (index === -1) return

      try {
        if (!fileWithStatus.file.type.startsWith('image/'))
          throw new Error(t('file.imagesOnly'))
        if (fileWithStatus.file.size > 8 * 1024 * 1024) throw new Error(t('file.tooLarge'))
        const url = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => resolve(reader.result as string)
          reader.onerror = () => reject(reader.error)
          reader.readAsDataURL(fileWithStatus.file)
        })
        const current = files.value.find(f => f.id === fileWithStatus.id)
        if (!current) return
        Object.assign(current, {
          status: 'uploaded',
          uploadedUrl: url
        })
      } catch (error) {
        const errorMessage
          = (error as { data?: { message?: string } }).data?.message || (error as Error).message || t('file.failed')
        toast.add({
          title: t('file.failed'),
          description: errorMessage,
          icon: 'i-lucide-alert-circle',
          color: 'error'
        })
        files.value[index] = {
          ...files.value[index]!,
          status: 'error',
          error: errorMessage
        }
      }
    })

    await Promise.allSettled(uploadPromises)
  }

  const { dropzoneRef, isDragging, open } = useFileUpload({
    accept: FILE_UPLOAD_CONFIG.acceptPattern,
    multiple: true,
    onUpdate: uploadFiles
  })

  const uploading = computed(() => files.value.some(f => f.status === 'uploading'))

  const uploadedFiles = computed(() =>
    files.value
      .filter(f => f.status === 'uploaded' && f.uploadedUrl)
      .map(f => ({
        type: 'file' as const,
        mediaType: f.file.type,
        filename: f.file.name,
        url: f.uploadedUrl!
      }))
  )

  function removeFile(id: string) {
    const file = files.value.find(f => f.id === id)
    if (!file) return

    URL.revokeObjectURL(file.previewUrl)
    files.value = files.value.filter(f => f.id !== id)
  }

  function clearFiles() {
    if (files.value.length === 0) return
    files.value.forEach(fileWithStatus => URL.revokeObjectURL(fileWithStatus.previewUrl))
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
