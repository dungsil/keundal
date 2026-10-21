<script setup lang="ts">
definePageMeta({
  middleware: (to) => {
    const { section, ...query } = to.query
    const sections = ['appearance', 'models', 'llm', 'mcp', 'skills']
    const target = typeof section === 'string' && sections.includes(section)
      ? section
      : query.provider ? 'llm' : 'models'
    return navigateTo({ path: `/settings/${target}`, query }, { replace: true })
  }
})
</script>

<template>
  <div />
</template>
