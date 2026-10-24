<script setup lang="ts">
import { settingsReturnTo } from '@keundal/ui/app/utils/chat-navigation.ts'
import { SlotOutlet, useSlotEntries } from '@keundal/ui-slots'

import { useText } from '../locale'

const props = defineProps<{
  section: string
}>()

const { t, locale } = useText()
const route = useRoute()
const returnTo = computed(() => settingsReturnTo(route.query.returnTo))

const entries = useSlotEntries('settings.section')
const sections = computed(() => entries.value.map(entry => ({
  id: entry.key!,
  label: entry.meta.label[locale.value],
  icon: entry.meta.icon,
  group: entry.meta.group
})))
const groups = computed(() => [
  sections.value.filter(section => section.group === 'general'),
  sections.value.filter(section => section.group === 'plugins')
])

useHead(() => {
  const current = sections.value.find(section => section.id === props.section)
  return { title: current ? `${current.label} - ${t('settings.title')}` : t('settings.title') }
})
</script>

<template>
  <UDashboardPanel
    id="settings"
    class="min-h-0"
    :ui="{ body: '[scrollbar-gutter:stable] [scroll-padding-top:var(--ui-header-height)]' }"
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
      <UContainer class="w-full max-w-6xl pt-[calc(var(--ui-header-height)+1.5rem)] pb-6 sm:pt-[calc(var(--ui-header-height)+2rem)] sm:pb-8">
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
            <div v-if="groups[0]!.length" class="flex flex-wrap gap-1 md:flex-col">
              <UButton
                v-for="item in groups[0]"
                :key="item.id"
                :label="item.label"
                :icon="item.icon"
                :to="{ path: `/settings/${item.id}`, query: { returnTo: route.query.returnTo } }"
                :active="section === item.id"
                :aria-current="section === item.id ? 'page' : undefined"
                :variant="section === item.id ? 'soft' : 'ghost'"
                color="neutral"
                class="shrink-0 justify-start md:w-full"
              />
            </div>
            <div v-if="groups[1]!.length" role="group" aria-labelledby="plugin-navigation-title" class="min-w-0 space-y-2">
              <h2 id="plugin-navigation-title" class="px-3 text-sm font-semibold text-muted">
                {{ t('plugin.title') }}
              </h2>
              <div class="flex flex-wrap gap-1 md:ml-3 md:flex-col md:border-l md:border-default md:pl-2">
                <UButton
                  v-for="item in groups[1]"
                  :key="item.id"
                  :label="item.label"
                  :icon="item.icon"
                  :to="{ path: `/settings/${item.id}`, query: { returnTo: route.query.returnTo } }"
                  :active="section === item.id"
                  :aria-current="section === item.id ? 'page' : undefined"
                  :variant="section === item.id ? 'soft' : 'ghost'"
                  color="neutral"
                  class="shrink-0 justify-start md:w-full"
                />
              </div>
            </div>
          </nav>
          <div class="min-w-0 flex-1">
            <!-- Each section keeps its unsaved drafts while another section is open. -->
            <KeepAlive>
              <SlotOutlet :key="section" name="settings.section" :entry-key="section" />
            </KeepAlive>
          </div>
        </div>
      </UContainer>
    </template>
  </UDashboardPanel>
</template>
