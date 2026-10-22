<script setup lang="ts">
const { t } = useLocale()
const route = useRoute()
const returnTo = computed(() => {
  const path = route.query.returnTo
  return typeof path === 'string' && (path === '/' || /^\/chat\/[^/?#]+$/.test(path)) ? path : '/'
})

const sections = computed(() => [
  { id: 'appearance', label: t('settings.appearance'), icon: 'i-lucide-palette' },
  { id: 'llm', label: 'LLM', icon: 'i-lucide-plug' },
  { id: 'models', label: t('model.defaultTitle'), icon: 'i-lucide-bot' }
])

const pluginSections = computed(() => [
  { id: 'plugins', label: t('plugin.manage'), icon: 'i-lucide-blocks' },
  { id: 'skills', label: t('skill.title'), icon: 'i-lucide-book-open' },
  { id: 'mcp', label: t('plugin.servers'), icon: 'i-lucide-network' }
])

useHead(() => ({ title: t('settings.title') }))
</script>

<template>
  <UDashboardPanel
    id="settings"
    class="min-h-0"
    :ui="{ body: '[scrollbar-gutter:stable]' }"
  >
    <template #header>
      <Navbar>
        <template #title>
          <div class="w-full max-w-6xl">
            <h1 class="text-lg font-semibold text-highlighted">
              {{ t('settings.title') }}
            </h1>
          </div>
        </template>
      </Navbar>
    </template>

    <template #body>
      <UContainer class="w-full max-w-6xl pt-(--ui-header-height) pb-6 sm:pb-8">
        <UButton
          :label="t('settings.back')"
          :to="returnTo"
          icon="i-lucide-arrow-left"
          color="neutral"
          variant="ghost"
          class="mb-6"
        />
        <div class="flex flex-col gap-8 md:flex-row md:gap-10 lg:gap-14">
          <nav
            :aria-label="t('settings.title')"
            class="flex shrink-0 flex-col gap-4 border-b border-default pb-4 md:sticky md:top-(--ui-header-height) md:w-48 md:self-start md:border-0 md:pb-0"
          >
            <div class="flex gap-1 overflow-x-auto md:flex-col">
              <UButton
                v-for="section in sections"
                :key="section.id"
                :label="section.label"
                :icon="section.icon"
                :to="{ path: `/settings/${section.id}`, query: { returnTo: route.query.returnTo } }"
                :active="route.path === `/settings/${section.id}`"
                :aria-current="route.path === `/settings/${section.id}` ? 'page' : undefined"
                :variant="route.path === `/settings/${section.id}` ? 'soft' : 'ghost'"
                color="neutral"
                class="shrink-0 justify-start md:w-full"
              />
            </div>
            <div role="group" aria-labelledby="plugin-navigation-title" class="min-w-0 space-y-2">
              <h2 id="plugin-navigation-title" class="px-3 text-sm font-semibold text-muted">
                {{ t('plugin.title') }}
              </h2>
              <div class="flex flex-wrap gap-1 md:ml-3 md:flex-col md:border-l md:border-default md:pl-2">
                <UButton
                  v-for="section in pluginSections"
                  :key="section.id"
                  :label="section.label"
                  :icon="section.icon"
                  :to="{ path: `/settings/${section.id}`, query: { returnTo: route.query.returnTo } }"
                  :active="route.path === `/settings/${section.id}`"
                  :aria-current="route.path === `/settings/${section.id}` ? 'page' : undefined"
                  :variant="route.path === `/settings/${section.id}` ? 'soft' : 'ghost'"
                  color="neutral"
                  class="shrink-0 justify-start md:w-full"
                />
              </div>
            </div>
          </nav>
          <div class="min-w-0 flex-1">
            <NuxtPage keepalive />
          </div>
        </div>
      </UContainer>
    </template>
  </UDashboardPanel>
</template>
