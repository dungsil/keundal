<script setup lang="ts">
const { locale } = useLocale()
</script>

<template>
  <div
    role="status"
    aria-live="polite"
    style="position: fixed; inset: 0; z-index: 2147483647; display: grid; place-content: center; gap: 16px; text-align: center; background: var(--startup-bg, #fafafa); color: var(--startup-fg, #18181b); font: 16px system-ui, sans-serif;"
  >
    <strong style="font-size: 24px; letter-spacing: -0.5px;">Keundal</strong>
    <span>{{ locale === 'ko' ? '화면을 준비하고 있어요' : 'Getting ready' }}</span>
    <a :href="$route.fullPath" style="color: inherit; font-size: 14px;">
      {{ locale === 'ko' ? '멈췄나요? 새로고침' : 'Stuck? Reload' }}
    </a>
  </div>
</template>
