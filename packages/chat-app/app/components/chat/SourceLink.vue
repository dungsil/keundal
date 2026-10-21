<script setup lang="ts">
import { getCitationUrl } from '../../utils/url'

defineOptions({ inheritAttrs: false })

const props = defineProps<{
  url: string
  favicon: string
  label: string
}>()

const destination = computed(() => getCitationUrl(props.url))
</script>

<template>
  <UButton
    v-if="destination"
    :to="destination"
    target="_blank"
    :avatar="{ src: getCitationUrl(favicon) }"
    :label="label"
    trailing-icon="i-lucide-arrow-up-right"
    size="xs"
    color="neutral"
    variant="outline"
    class="rounded-full align-middle"
  />
  <span v-else>{{ label }}</span>
</template>
