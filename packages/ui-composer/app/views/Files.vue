<script setup lang="ts">
import type { FileWithStatus } from '@keundal/chat/file'

const { t } = useLocale()

defineProps<{
  files: FileWithStatus[]
}>()

defineEmits<{
  remove: [id: string]
}>()
</script>

<template>
  <div class="flex flex-wrap gap-2">
    <FilePreview
      v-for="fileWithStatus in files"
      :key="fileWithStatus.id"
      :name="fileWithStatus.file.name"
      :type="fileWithStatus.file.type"
      :preview-url="fileWithStatus.previewUrl"
      :status="fileWithStatus.status"
      :error="fileWithStatus.error"
      removable
      @remove="$emit('remove', fileWithStatus.id)"
    />
    <p v-if="files.some(file => file.attachment?.text)" class="w-full text-xs text-muted">
      {{ t('file.documentPrivacy') }}
    </p>
  </div>
</template>
