<script setup lang="ts">
definePageMeta({
  middleware: (to) => {
    const { section, ...query } = to.query
    const sections = ['appearance', 'llm', 'models', 'mcp', 'skills'] as const
    const target = typeof section === 'string' && sections.some(item => item === section)
      ? section
      : query.provider ? 'llm' : sections[0]
    return navigateTo({ path: `/settings/${target}`, query }, { replace: true })
  }
})
</script>

<template>
  <div />
</template>
