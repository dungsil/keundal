<script setup lang="ts">
import { listChatSummaries } from '@keundal/chat/chat-store'
import { useTemplateRef } from 'vue'
import { chatPath } from '../../shared/utils/chat-navigation'

const { t } = useLocale()

const { renameChat, deleteChat } = useChatActions()

const route = useRoute()
const isSettings = computed(() => route.path === '/settings' || route.path.startsWith('/settings/'))
const sidebarOpen = ref(false)
const searchOpen = ref(false)
const { $chatStore } = useNuxtApp()
const mainContent = useTemplateRef('mainContent')
const removePageHook = useNuxtApp().hook('page:finish', async () => {
  sidebarOpen.value = false
  await nextTick()
  mainContent.value?.focus()
})
onUnmounted(removePageHook)

const { data: chats, status: chatsStatus } = await useAsyncData('chats', () => listChatSummaries($chatStore), {
  server: false,
  transform: data => data.map(chat => ({
    id: chat.id,
    label: chat.title || '',
    to: chatPath(chat.id),
    icon: 'i-lucide-message-circle',
    createdAt: chat.createdAt
  }))
})

useStartupPending('chats', chatsStatus)

const showChatsSkeleton = computed(() => !chats.value && (chatsStatus.value === 'idle' || chatsStatus.value === 'pending'))

const localizedChats = computed(() => chats.value?.map(chat => ({
  ...chat,
  untitled: !chat.label,
  label: chat.label || t('chat.untitled')
})))
const { groups } = useChats(localizedChats)
const currentChat = computed(() => localizedChats.value?.find(chat => chat.id === route.params.id))
const commandGroups = computed(() => [{
  id: 'links',
  items: [
    { label: t('chat.new'), to: '/', icon: 'i-lucide-circle-plus', kbds: ['meta', 'o'] },
    { label: t('history.title'), to: '/history', icon: 'i-lucide-history' }
  ]
}, {
  id: 'settings',
  label: t('settings.title'),
  items: [
    { label: t('settings.appearance'), path: 'appearance', icon: 'i-lucide-palette' },
    { label: 'LLM', path: 'llm', icon: 'i-lucide-plug' },
    { label: t('model.defaultTitle'), path: 'models', icon: 'i-lucide-bot' },
    { label: t('plugin.manage'), path: 'plugins', icon: 'i-lucide-blocks' },
    { label: t('skill.title'), path: 'skills', icon: 'i-lucide-book-open' },
    { label: t('plugin.servers'), path: 'mcp', icon: 'i-lucide-network' }
  ].map(item => ({ ...item, to: { path: `/settings/${item.path}`, query: { returnTo: isSettings.value ? route.query.returnTo : route.path } } }))
}, ...(currentChat.value ? [{
  id: 'current-chat',
  label: currentChat.value.label,
  items: [
    { label: t('common.rename'), icon: 'i-lucide-pencil', onSelect: () => runCurrentChatAction('rename') },
    { label: t('common.delete'), icon: 'i-lucide-trash', onSelect: () => runCurrentChatAction('delete') }
  ]
}] : []), ...groups.value])

async function runCurrentChatAction(action: 'rename' | 'delete') {
  const chat = currentChat.value
  if (!chat) return
  searchOpen.value = false
  await nextTick()
  if (action === 'rename') await renameChat(chat.id, chat.untitled ? '' : chat.label)
  else await deleteChat(chat.id)
}

defineShortcuts({
  meta_o: () => {
    navigateTo('/')
  }
})
</script>

<template>
  <a href="#main-content" class="sr-only focus:not-sr-only focus:fixed focus:start-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-default focus:p-3" @click.prevent="mainContent?.focus()">
    {{ t('navigation.skipToContent') }}
  </a>
  <UDashboardGroup unit="rem">
    <UDashboardSidebar
      id="default"
      role="complementary"
      :aria-label="t('navigation.chats')"
      v-model:open="sidebarOpen"
      :min-size="12"
      collapsible
      resizable
      :menu="{ inset: true }"
      class="border-r-0 py-4 dark:[--ui-bg-elevated:var(--ui-color-neutral-900)]"
    >
      <template #header>
        <UDashboardSidebarCollapse class="ms-auto" />
      </template>

      <template #default="{ collapsed }">
        <UNavigationMenu
          :aria-label="t('chat.actions')"
          :items="[{
            label: t('chat.new'),
            'aria-label': collapsed ? t('chat.new') : undefined,
            to: '/',
            kbds: ['meta', 'o'],
            icon: 'i-lucide-circle-plus'
          }, {
            label: t('chat.search'),
            'aria-label': collapsed ? t('chat.search') : undefined,
            icon: 'i-lucide-search',
            kbds: ['meta', 'k'],
            onSelect: () => {
              searchOpen = true
            }
          }, { label: t('history.title'), to: '/history', icon: 'i-lucide-history', 'aria-label': collapsed ? t('history.title') : undefined }]"
          :collapsed="collapsed"
          orientation="vertical"
        >
          <template #item-trailing="{ item }">
            <div v-if="item.kbds?.length" class="flex items-center gap-px opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
              <UKbd
                v-for="kbd in item.kbds"
                :key="kbd"
                :value="kbd"
                size="sm"
                variant="soft"
                class="bg-accented/50"
              />
            </div>
          </template>
        </UNavigationMenu>

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

        <SidebarChatList v-else-if="!collapsed" :chats="localizedChats ?? []" />
      </template>

      <template #footer="{ collapsed }">
        <div class="flex flex-col gap-1 w-full">
          <UButton
            :label="collapsed ? '' : t('settings.title')"
            :to="{ path: isSettings ? route.path : '/settings', query: isSettings ? route.query : { returnTo: route.path } }"
            icon="i-lucide-settings-2"
            color="neutral"
            :variant="isSettings ? 'soft' : 'ghost'"
            class="w-full"
            :aria-label="t('settings.title')"
            @click="sidebarOpen = false"
          />
        </div>
      </template>
    </UDashboardSidebar>

    <UDashboardSearch
      v-model:open="searchOpen"
      :placeholder="t('chat.searchPlaceholder')"
      :groups="commandGroups"
    />

    <main id="main-content" ref="mainContent" tabindex="-1" class="flex-1 flex mt-4 sm:ms-4 lg:ms-0 sm:rounded-ss-lg ring ring-default bg-default/75 shadow-sm min-w-0 overflow-hidden">
      <slot />
    </main>
  </UDashboardGroup>
</template>
