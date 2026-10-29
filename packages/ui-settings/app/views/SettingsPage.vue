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
const sectionPending = ref(false)

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
const currentSection = computed(() => sections.value.find(section => section.id === props.section))
const mobileItems = computed(() => groups.value.map(group => group.map(item => ({
  label: item.label,
  icon: item.icon,
  to: { path: `/settings/${item.id}`, query: { returnTo: route.query.returnTo } },
  'aria-current': props.section === item.id ? 'page' as const : undefined
}))))

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
          class="mb-4 md:mb-6"
        />
        <div class="flex flex-col gap-6 md:flex-row md:gap-10 lg:gap-14">
          <UDropdownMenu
            :items="mobileItems"
            :modal="false"
            :content="{ align: 'start' }"
            :ui="{ content: 'w-(--reka-dropdown-menu-trigger-width)', item: 'min-h-[44px]' }"
          >
            <UButton
              :label="currentSection?.label"
              :icon="currentSection?.icon"
              :aria-label="`${t('settings.title')}: ${currentSection?.label ?? ''}`"
              trailing-icon="i-lucide-chevron-down"
              color="neutral"
              variant="outline"
              class="min-h-[44px] w-full md:hidden"
              :ui="{ trailingIcon: 'ms-auto' }"
            />
          </UDropdownMenu>
          <nav
            :aria-label="t('settings.title')"
            class="hidden shrink-0 flex-col gap-4 md:sticky md:top-(--ui-header-height) md:flex md:w-48 md:self-start"
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
            <div v-if="groups[1]!.length" role="group" :aria-label="t('plugin.title')" class="min-w-0 border-t border-default pt-4">
              <div class="flex flex-wrap gap-1 md:flex-col">
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
          <div class="min-w-0 flex-1" :aria-busy="sectionPending" :inert="sectionPending">
            <!-- Each section keeps its unsaved drafts while another section is open. -->
            <!-- Keep the previous section visible until the next lazy view is ready. -->
            <KeepAlive>
              <Suspense @pending="sectionPending = true" @resolve="sectionPending = false">
                <SlotOutlet :key="section" name="settings.section" :entry-key="section" />
              </Suspense>
            </KeepAlive>
          </div>
        </div>
      </UContainer>
    </template>
  </UDashboardPanel>
</template>
