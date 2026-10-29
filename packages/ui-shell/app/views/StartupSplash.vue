<script setup lang="ts">
defineProps<{
  /** 닫히는 동안 배경을 서서히 지우고 입력을 통과시킨다. */
  leaving?: boolean
}>()
</script>

<template>
  <div
    role="status"
    aria-live="polite"
    style="position: fixed; inset: 0; z-index: 2147483647; background: var(--startup-bg, #fafafa);"
    class="motion-safe:transition-opacity motion-safe:duration-200"
    :class="leaving ? 'pointer-events-none opacity-0' : 'opacity-100'"
  ></div>
</template>
