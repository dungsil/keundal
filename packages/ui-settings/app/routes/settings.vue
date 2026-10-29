<script setup lang="ts">
import { SlotOutlet } from '@keundal/ui-slots'

definePageMeta({
  // Keep one page instance across sections so each section keeps its drafts.
  key: 'settings',
  middleware: (to) => {
    const sections = useNuxtApp().$ui.slots.describe('settings.section')
    const section = to.params.section
    if (typeof section === 'string' && section) {
      if (sections.some(entry => entry.key === section)) return
      return abortNavigation(createError({ statusCode: 404, statusMessage: 'Page not found' }))
    }
    const { section: requested, ...query } = to.query
    const target = sections.find(entry => entry.key === requested)
      ?? sections.find(entry => entry.meta.query !== undefined && entry.meta.query in query)
      ?? sections[0]
    if (target) return navigateTo({ path: `/settings/${target.key}`, query }, { replace: true })
  }
})

const route = useRoute()
</script>

<template>
  <SlotOutlet name="page.settings" :owner="{ section: String(route.params.section ?? '') }" />
</template>
