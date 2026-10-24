<script setup lang="ts">
import { useText } from '../locale'

const { t } = useText()
</script>

<template>
  <UDashboardPanel
    id="chat"
    class="relative min-h-0"
    :ui="{ body: 'p-0 sm:p-0 overscroll-none overflow-hidden' }"
    aria-busy="true"
  >
    <template #header>
      <Navbar>
        <template #title>
          <USkeleton class="h-5 w-40 max-w-full motion-reduce:animate-none" aria-hidden="true" />
        </template>
      </Navbar>
    </template>

    <template #body>
      <span role="status" class="sr-only">{{ t('chat.loading') }}</span>
      <UContainer class="flex-1 pt-(--ui-header-height) pb-4 sm:pb-6" aria-hidden="true">
        <div class="flex flex-col gap-8 px-2.5 sm:gap-10">
          <div v-for="row in 2" :key="row" class="flex flex-col gap-6">
            <USkeleton class="h-12 w-2/3 max-w-sm self-end rounded-lg motion-reduce:animate-none" />
            <div class="flex flex-col gap-3">
              <USkeleton class="h-4 w-full motion-reduce:animate-none" />
              <USkeleton class="h-4 w-11/12 motion-reduce:animate-none" />
              <USkeleton class="h-4 w-3/4 motion-reduce:animate-none" />
            </div>
          </div>
        </div>
      </UContainer>
    </template>
  </UDashboardPanel>
</template>
