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
        <section class="mb-8 space-y-4" aria-labelledby="appearance-settings-title">
          <h2 id="appearance-settings-title" class="text-lg font-semibold text-highlighted">
            {{ t('settings.appearance') }}
          </h2>
          <div class="flex items-center justify-between gap-3">
            <span class="text-sm font-medium text-highlighted">{{ t('language.label') }}</span>
            <LanguageSelect />
          </div>
          <div class="flex items-center justify-between gap-3">
            <span class="text-sm font-medium text-highlighted">{{ t('settings.colorMode') }}</span>
            <UColorModeButton />
          </div>
        </section>
        <ClientOnly>
          <ModelSettings />
          <LLMSettings :return-to="returnTo" />
        </ClientOnly>
      </UContainer>
    </template>
  </UDashboardPanel>
</template>
