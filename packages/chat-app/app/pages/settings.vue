<script setup lang="ts">
const { t } = useLocale()
const route = useRoute()
const returnTo = computed(() => {
  const path = route.query.returnTo
  return typeof path === 'string' && (path === '/' || /^\/chat\/[^/?#]+$/.test(path)) ? path : '/'
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
      <UContainer class="w-full max-w-3xl pt-(--ui-header-height) pb-6 sm:pb-8">
        <UButton
          :label="t('settings.back')"
          :to="returnTo"
          icon="i-lucide-arrow-left"
          color="neutral"
          variant="ghost"
          class="mb-6"
        />
        <ClientOnly>
          <ModelSettings />
          <LLMSettings :return-to="returnTo" />
        </ClientOnly>
      </UContainer>
    </template>
  </UDashboardPanel>
</template>
