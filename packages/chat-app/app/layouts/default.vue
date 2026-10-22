<script setup lang="ts">
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
          }]"
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

        <ul v-else-if="!collapsed && groups" class="flex flex-col">
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
                :to="`/chat/${item.id}`"
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

    <main id="main-content" ref="mainContent" tabindex="-1" class="flex-1 flex mt-4 ms-4 lg:ms-0 rounded-ss-lg ring ring-default bg-default/75 shadow-sm min-w-0 overflow-hidden">
      <slot />
    </main>
  </UDashboardGroup>
</template>
