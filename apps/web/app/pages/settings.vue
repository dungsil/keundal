<script setup lang="ts">
const route = useRoute()
const returnTo = computed(() => {
  const path = route.query.returnTo
  return typeof path === 'string' && (path === '/' || /^\/chat\/[^/?#]+$/.test(path)) ? path : '/'
})

useHead({ title: '설정' })
</script>

<template>
  <UDashboardPanel id="settings" class="min-h-0">
    <template #header>
      <Navbar>
        <template #title>
          <h1 class="text-lg font-semibold text-highlighted">
            설정
          </h1>
        </template>
      </Navbar>
    </template>

    <template #body>
      <UContainer class="w-full max-w-3xl pt-(--ui-header-height) pb-6 sm:pb-8">
        <UButton
          label="대화로 돌아가기"
          :to="returnTo"
          icon="i-lucide-arrow-left"
          color="neutral"
          variant="ghost"
          class="mb-6"
        />
        <ClientOnly>
          <LLMSettings :return-to="returnTo" />
        </ClientOnly>
      </UContainer>
    </template>
  </UDashboardPanel>
</template>
