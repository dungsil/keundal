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
      <UContainer class="w-full max-w-3xl py-6 sm:py-8">
        <UButton
          :label="t('settings.back')"
          :to="returnTo"
          icon="i-lucide-arrow-left"
          color="neutral"
          variant="ghost"
          class="mb-6"
        />
        <ClientOnly>
          <div class="flex flex-col gap-6">
            <UCard>
              <ModelSettings />
            </UCard>
            <UCard>
              <LLMSettings :return-to="returnTo" />
            </UCard>
            <UCard>
              <SkillSettings />
            </UCard>
          </div>
        </ClientOnly>
      </UContainer>
    </template>
  </UDashboardPanel>
</template>
