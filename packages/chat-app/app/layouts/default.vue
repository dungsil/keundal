<script setup lang="ts">
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

const showChatsSkeleton = computed(() => !chats.value && (chatsStatus.value === 'idle' || chatsStatus.value === 'pending'))

const localizedChats = computed(() => chats.value?.map(chat => ({
  ...chat,
  untitled: !chat.label,
  label: chat.label || t('chat.untitled')
})))
const { groups } = useChats(localizedChats)

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

        <div v-else-if="!collapsed" class="space-y-2">
          <div v-for="group in groups" :key="group.id">
            <p class="px-2.5 py-1.5 text-xs font-semibold text-muted">
              {{ group.label }}
            </p>
            <ul class="space-y-0.5">
              <li
                v-for="item in group.items"
                :key="item.id"
                class="flex items-center gap-0.5"
              >
                <ULink
                  :to="`/chat/${item.id}`"
                  class="min-w-0 flex-1 truncate rounded-md px-2.5 py-1.5 text-sm font-medium focus-visible:outline-primary"
                  active-class="bg-elevated text-highlighted"
                  :inactive-class="item.untitled ? 'text-muted hover:bg-elevated/50' : 'text-default hover:bg-elevated/50'"
                >
                  {{ item.label }}
                </ULink>
                <UTooltip :text="t('common.rename')">
                  <UButton
                    icon="i-lucide-pencil"
                    color="neutral"
                    variant="ghost"
                    size="sm"
                    class="shrink-0"
                    :aria-label="t('common.rename')"
                    @click="renameChat(item.id, item.untitled ? '' : item.label)"
                  />
                </UTooltip>
                <UTooltip :text="t('common.delete')">
                  <UButton
                    icon="i-lucide-trash"
                    color="error"
                    variant="ghost"
                    size="sm"
                    class="shrink-0"
                    :aria-label="t('common.delete')"
                    @click="deleteChat(item.id)"
                  />
                </UTooltip>
              </li>
            </ul>
          </div>
        </div>
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
