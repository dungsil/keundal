<script setup lang="ts">
const { locale, setLocale, t } = useLocale()

function changeLanguage(event: Event) {
  setLocale((event.target as HTMLSelectElement).value)
}
</script>

<template>
  <div class="relative inline-flex items-center">
    <UIcon
      name="i-lucide-languages"
      class="pointer-events-none absolute start-2.5 size-4 text-muted"
      aria-hidden="true"
    />
    <select
      :value="locale"
      :aria-label="t('language.label')"
      class="appearance-none rounded-md bg-default py-1.5 ps-8 pe-8 text-sm text-default hover:bg-elevated focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      @change="changeLanguage"
    >
      <option value="en">English</option>
      <option value="ko">한국어</option>
    </select>
    <UIcon
      name="i-lucide-chevron-down"
      class="pointer-events-none absolute end-2.5 size-4 text-muted"
      aria-hidden="true"
    />
  </div>
</template>
