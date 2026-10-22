<script setup lang="ts">
import { getFileIcon, removeRandomSuffix } from '@keundal/chat/file'

import type { AvatarProps } from '@nuxt/ui'

const { t } = useLocale()

interface ChatFilePreviewProps {
  name: string
  type: string
  previewUrl?: string
  size?: AvatarProps['size']
  status?: 'idle' | 'uploading' | 'uploaded' | 'error'
  error?: string
  removable?: boolean
}

const props = withDefaults(defineProps<ChatFilePreviewProps>(), {
  status: 'idle',
  removable: false,
  size: '2xl'
})

const emit = defineEmits<{
  remove: []
}>()

const isZoomable = computed(() => props.type.startsWith('image/') && props.previewUrl)
</script>

<template>
  <div class="relative group">
    <UModal v-if="isZoomable" :title="removeRandomSuffix(name)" :transition="false" :ui="{ content: 'max-w-[95vw]', body: 'flex justify-center' }">
      <button type="button" class="cursor-zoom-in rounded-lg" :aria-label="`${t('file.zoom')}: ${removeRandomSuffix(name)}`">
        <UAvatar
          :size="size"
          :src="previewUrl"
          alt=""
          class="rounded-lg"
          :class="{ 'opacity-50': status === 'uploading' }"
        />
      </button>
      <template #body>
        <img :src="previewUrl" :alt="removeRandomSuffix(name)" class="max-w-full max-h-[75dvh] object-contain rounded-md">
      </template>
    </UModal>
    <UTooltip v-else :text="removeRandomSuffix(name)">
      <UAvatar
        :size="size"
        :icon="getFileIcon(type, name)"
        :alt="removeRandomSuffix(name)"
        class="rounded-lg"
        :class="{ 'opacity-50': status === 'uploading' }"
      />
    </UTooltip>

    <div v-if="status === 'uploading'" class="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/50 rounded-lg">
      <UIcon name="i-lucide-loader-2" class="size-6 animate-spin motion-reduce:animate-none text-white" />
    </div>

    <UTooltip v-if="status === 'error'" :text="error">
      <div class="pointer-events-none absolute inset-0 flex items-center justify-center bg-error rounded-lg">
        <UIcon name="i-lucide-alert-circle" class="size-6 text-inverted" />
      </div>
    </UTooltip>

    <UButton
      v-if="removable && status !== 'uploading'"
      icon="i-lucide-x"
      size="xs"
      color="neutral"
      class="absolute size-6 p-0 -top-1 -right-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 transition-opacity rounded-full ring ring-bg"
      :aria-label="`${t('file.remove')}: ${removeRandomSuffix(name)}`"
      @click="emit('remove')"
    />
  </div>
</template>
