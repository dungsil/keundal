<script setup lang="ts">
const { t } = useLocale()
const route = useRoute()
const returnTo = computed(() => {
  const path = route.query.returnTo
  return typeof path === 'string' && (path === '/' || /^\/chat\/[^/?#]+$/.test(path)) ? path : '/'
})

const sections = computed(() => [
  { id: 'models', label: t('model.defaultTitle'), icon: 'i-lucide-bot' },
  { id: 'llm', label: 'LLM', icon: 'i-lucide-plug' },
  { id: 'skills', label: t('skill.title'), icon: 'i-lucide-book-open' }
])
const activeSection = computed(() => {
  const section = route.query.section
  return sections.value.some(item => item.id === section)
    ? section
    : route.query.provider ? 'llm' : 'models'
})

useHead(() => ({ title: t('settings.title') }))
</script>

<template>
  <UDashboardPanel id="settings" class="min-h-0">
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
              :to="{ path: '/settings', query: { ...route.query, section: section.id } }"
              :active="activeSection === section.id"
              :aria-current="activeSection === section.id ? 'page' : undefined"
              :variant="activeSection === section.id ? 'soft' : 'ghost'"
              color="neutral"
              class="shrink-0 justify-start md:w-full"
            />
          </nav>
          <div class="min-w-0 flex-1">
            <ModelSettings v-show="activeSection === 'models'" />
            <LLMSettings v-show="activeSection === 'llm'" :return-to="returnTo" />
            <ClientOnly>
              <SkillSettings v-show="activeSection === 'skills'" />
            </ClientOnly>
          </div>
        </div>
      </UContainer>
    </template>
  </UDashboardPanel>
</template>
