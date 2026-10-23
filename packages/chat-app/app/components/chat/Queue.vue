<script setup lang="ts">
import type { ChatMessage } from '@keundal/chat/chat-message'

const { t } = useLocale()

defineProps<{
  queue: ChatMessage[]
  /** 실행이 없는데 대기 메시지가 남아 있으면 정상 종료가 아니었으므로 이어서 보낼지 묻습니다. */
  paused: boolean
  /** 실행이 브라우저 탭 안에서만 진행되는지 여부입니다. */
  browserOnly: boolean
}>()

const emit = defineEmits<{
  remove: [messageId: string]
  resume: []
}>()

function preview(message: ChatMessage) {
  const text = message.parts.flatMap(part => (part.type === 'text' ? [part.text] : [])).join(' ').trim()
  return text || t('chat.attachment')
}
</script>

<template>
  <section
    v-if="queue.length"
    :aria-label="t('chat.queued')"
    class="rounded-lg border border-default bg-elevated/50 px-3 py-2 text-sm"
  >
    <div class="flex items-center justify-between gap-2">
      <span class="font-medium text-highlighted">{{ t('chat.queued') }} ({{ queue.length }})</span>
      <UButton
        v-if="paused"
        :label="t('chat.queueResume')"
        icon="i-lucide-play"
        size="xs"
        color="neutral"
        variant="soft"
        @click="emit('resume')"
      />
    </div>
    <p v-if="paused" class="mt-1 text-muted">
      {{ t('chat.queuePaused') }}
    </p>
    <!-- 목록만 높이를 제한합니다. p-1과 음수 마진은 레이아웃 크기를 유지하면서 삭제 버튼의 포커스 링이 스크롤 경계에서 잘리지 않게 합니다. -->
    <ol class="mt-1 -mx-1 -mb-1 flex max-h-32 flex-col gap-1 overflow-y-auto p-1">
      <li v-for="(message, index) in queue" :key="message.id" class="flex items-center gap-2">
        <span class="w-[4ch] shrink-0 text-right text-muted tabular-nums">{{ index + 1 }}.</span>
        <UTooltip :text="preview(message)" :content="{ side: 'top' }">
          <span dir="auto" class="min-w-0 flex-1 truncate">{{ preview(message) }}</span>
        </UTooltip>
        <UButton
          icon="i-lucide-x"
          size="xs"
          color="neutral"
          variant="ghost"
          :aria-label="t('chat.queueRemove')"
          @click="emit('remove', message.id)"
        />
      </li>
    </ol>
    <p v-if="browserOnly" class="mt-2 text-xs text-muted">
      {{ t('chat.queueBrowserOnly') }}
    </p>
  </section>
</template>
