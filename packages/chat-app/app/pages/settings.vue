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
  { id: 'models', label: t('model.defaultTitle'), icon: 'i-lucide-bot' },
  { id: 'mcp', label: 'MCP', icon: 'i-lucide-network' },
  { id: 'skills', label: t('skill.title'), icon: 'i-lucide-book-open' }
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
          <h1 class="text-lg font-semibold text-highlighted">
            {{ t('settings.title') }}
          </h1>
        </template>
      </Navbar>
    </template>

    <template #body>
      <UContainer class="w-full max-w-6xl py-6 sm:py-8">
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
            class="flex shrink-0 gap-1 overflow-x-auto border-b border-default pb-4 md:sticky md:top-0 md:w-48 md:flex-col md:self-start md:border-0 md:pb-0"
          >
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
          </nav>
          <div class="min-w-0 flex-1">
            <NuxtPage keepalive />
          </div>
        </div>
      </UContainer>
    </template>
  </UDashboardPanel>
</template>
