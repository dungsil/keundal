<script setup lang="ts">
const { t } = useLocale()
</script>

<template>
  <UDashboardNavbar class="absolute top-0 inset-x-0 border-b-0 z-10 backdrop-blur-sm sm:px-4" :ui="{ left: 'min-w-0' }">
    <template #left>
      <div v-if="$slots.title" class="flex min-w-0 items-center whitespace-nowrap [&>*]:truncate">
        <slot name="title" />
      </div>
    </template>

    <template #right>
      <slot />

      <UButton
        color="neutral"
        variant="ghost"
        icon="i-lucide-circle-plus"
        to="/"
        class="lg:hidden"
        :aria-label="t('chat.new')"
      />
    </template>
  </UDashboardNavbar>
</template>
