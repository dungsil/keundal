<script setup lang="ts">
import type { ChatSummary } from '@keundal/ui-runtime'
import { chatPath, sidebarChats } from '@keundal/ui/app/utils/chat-navigation.ts'
import type { Ref } from 'vue'

import { useLocalizedChats } from '../lib/useLocalizedChats'
import { useChats } from '../lib/useChats'
import { useText } from '../locale'

const props = defineProps<{
  collapsed: boolean
  chats: Ref<ChatSummary[] | undefined>
  rename: (id: string, title: string) => Promise<void>
  remove: (id: string) => Promise<void>
}>()

const { t } = useText()

const { renameChat, deleteChat } = useChatActions({
  rename: (id, title) => props.rename(id, title),
  remove: id => props.remove(id)
})

const showChatsSkeleton = computed(() => !props.chats.value)

const route = useRoute()
const limit = ref(40)
const localizedChats = useLocalizedChats(() => props.chats.value)
// Keep the current chat reachable without mounting the entire history.
const visibleChats = computed(() => sidebarChats(localizedChats.value ?? [], limit.value, typeof route.params.id === 'string' ? route.params.id : undefined))
const { groups } = useChats(visibleChats)
</script>

<template>
  <div
    v-if="!collapsed && showChatsSkeleton"
    class="flex flex-col gap-1 px-2.5 py-1.5"
    aria-hidden="true"
  >
    <div class="flex h-8 items-center">
      <USkeleton class="h-3 w-16 motion-reduce:animate-none" />
    </div>
    <div
      v-for="(width, index) in ['w-4/5', 'w-3/5', 'w-5/6', 'w-2/3', 'w-3/4']"
      :key="index"
      class="flex h-8 items-center"
    >
      <USkeleton :class="['h-4 motion-reduce:animate-none', width]" />
    </div>
  </div>

  <template v-else-if="!collapsed">
    <ul class="flex flex-col" data-testid="sidebar-chat-list">
      <template v-for="group in groups" :key="group.label">
        <li class="w-full flex items-center gap-1.5 font-semibold text-xs/5 text-highlighted px-2.5 py-1.5">
          {{ group.label }}
        </li>
        <li
          v-for="item in group.items"
          :key="item.id"
          class="group relative min-w-0"
        >
          <NuxtLink
            :to="chatPath(item.id)"
            class="group relative w-full flex items-center gap-1.5 font-medium text-sm before:absolute before:z-[-1] before:rounded-md flex-row px-2.5 py-1.5 before:inset-y-px before:inset-x-0 text-default hover:before:bg-elevated/50 focus-visible:before:bg-elevated/50 [&.router-link-exact-active]:text-primary [&.router-link-exact-active]:before:bg-elevated overflow-hidden pe-14.5"
          >
            <span class="truncate" :class="item.untitled ? 'text-muted group-[.router-link-exact-active]:text-toned' : ''">{{ item.label }}</span>
          </NuxtLink>
          <div class="absolute end-0 inset-y-0 flex items-center gap-0.5 pe-1.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
            <UButton
              icon="i-lucide-pencil"
              color="neutral"
              variant="ghost"
              size="sm"
              class="rounded-[5px]"
              :aria-label="`${t('common.rename')}: ${item.label}`"
              :title="t('common.rename')"
              @click="renameChat(item.id, item.untitled ? '' : item.label)"
            />
            <UButton
              icon="i-lucide-trash"
              color="neutral"
              variant="ghost"
              size="sm"
              class="rounded-[5px]"
              :aria-label="`${t('common.delete')}: ${item.label}`"
              :title="t('common.delete')"
              @click="deleteChat(item.id)"
            />
          </div>
        </li>
      </template>
    </ul>
    <UButton
      v-if="visibleChats.length < (localizedChats?.length ?? 0)"
      :label="t('history.loadMore')"
      color="neutral"
      variant="ghost"
      class="w-full"
      data-testid="sidebar-load-more"
      @click="limit += 40"
    />
  </template>
</template>
