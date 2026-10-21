<script setup lang="ts">
import type { DropdownMenuItem } from '@nuxt/ui'

const { t } = useLocale()

const { renameChat, deleteChat } = useChatActions()

const route = useRoute()
const sidebarOpen = ref(false)
const searchOpen = ref(false)
const { $chatStore } = useNuxtApp()

const { data: chats, status: chatsStatus } = await useAsyncData('chats', () => $chatStore.list(), {
  server: false,
  transform: data => data.map(chat => ({
    id: chat.id,
    label: chat.title || '',
    to: `/chat/${chat.id}`,
    icon: 'i-lucide-message-circle',
    createdAt: chat.createdAt
  }))
})

useStartupPending('chats', chatsStatus)

const localizedChats = computed(() => chats.value?.map(chat => ({
  ...chat,
  untitled: !chat.label,
  label: chat.label || t('chat.untitled')
})))
const { groups } = useChats(localizedChats)

const items = computed(() => groups.value?.flatMap((group) => {
  return [{
    label: group.label,
    type: 'label' as const
  }, ...group.items.map(item => ({
    ...item,
    slot: 'chat' as const,
    icon: undefined,
    class: item.untitled ? 'text-muted' : ''
  }))]
}))

function getChatActions(item: { id: string, label: string, untitled?: boolean }): DropdownMenuItem[][] {
  return [[
    {
      label: t('common.rename'),
      icon: 'i-lucide-pencil',
      onSelect: () => renameChat(item.id, item.untitled ? '' : item.label)
    }
  ], [
    {
      label: t('common.delete'),
      icon: 'i-lucide-trash',
      color: 'error' as const,
      onSelect: () => deleteChat(item.id)
    }
  ]]
}

defineShortcuts({
  meta_o: () => {
    navigateTo('/')
  }
})
</script>

<template>
  <UDashboardGroup unit="rem">
    <UDashboardSidebar
      id="default"
      v-model:open="sidebarOpen"
      :min-size="12"
      collapsible
      resizable
      :menu="{ inset: true }"
      class="border-r-0 py-4 dark:[--ui-bg-elevated:var(--ui-color-neutral-900)]"
    >
      <template #header="{ collapsed }">
        <NuxtLink
          v-if="!collapsed"
          to="/"
          class="flex items-end gap-0.5 outline-primary/25 focus-visible:outline-3 rounded-md"
        >
          <Logo class="h-8 w-auto shrink-0" />
          <span class="text-xl font-bold text-highlighted">Chat</span>
        </NuxtLink>

        <UDashboardSidebarCollapse class="ms-auto" />
      </template>

      <template #default="{ collapsed }">
        <UNavigationMenu
          :items="[{
            label: t('chat.new'),
            to: '/',
            kbds: ['meta', 'o'],
            icon: 'i-lucide-circle-plus'
          }, {
            label: t('chat.search'),
            icon: 'i-lucide-search',
            kbds: ['meta', 'k'],
            onSelect: () => {
              searchOpen = true
            }
          }]"
          :collapsed="collapsed"
          orientation="vertical"
        >
          <template #item-trailing="{ item }">
            <div v-if="item.kbds?.length" class="flex items-center gap-px opacity-0 group-hover:opacity-100 transition-opacity">
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

        <UNavigationMenu
          v-if="!collapsed"
          :items="items"
          :collapsed="collapsed"
          orientation="vertical"
          :ui="{
            link: 'overflow-hidden pr-7.5',
            linkTrailing: 'translate-x-full group-hover:translate-x-0 group-has-data-[state=open]:translate-x-0 transition-transform ms-0 absolute inset-e-px'
          }"
        >
          <template #chat-trailing="{ item }">
            <UDropdownMenu
              :items="getChatActions(item as { id: string, label: string })"
              :content="{ align: 'end' }"
            >
              <UButton
                as="div"
                icon="i-lucide-ellipsis"
                color="neutral"
                variant="link"
                size="sm"
                class="rounded-[5px] hover:bg-accented/50 focus-visible:bg-accented/50 data-[state=open]:bg-accented/50"
                :aria-label="t('chat.actions')"
                tabindex="-1"
                @click.stop.prevent
              />
            </UDropdownMenu>
          </template>
        </UNavigationMenu>
      </template>

      <template #footer="{ collapsed }">
        <div class="flex flex-col gap-1 w-full">
          <UButton
            :label="collapsed ? '' : t('settings.title')"
            :to="{ path: '/settings', query: route.path === '/settings' ? route.query : { returnTo: route.path } }"
            icon="i-lucide-settings-2"
            color="neutral"
            :variant="route.path === '/settings' ? 'soft' : 'ghost'"
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
      :groups="[{
        id: 'links',
        items: [{
          label: t('chat.new'),
          to: '/',
          icon: 'i-lucide-circle-plus',
          kbds: ['meta', 'o']
        }]
      }, ...groups]"
    />

    <div class="flex-1 flex mt-4 ml-4 lg:ml-0 rounded-tl-lg ring ring-default bg-default/75 shadow-sm min-w-0 overflow-hidden">
      <slot />
    </div>
  </UDashboardGroup>
</template>
