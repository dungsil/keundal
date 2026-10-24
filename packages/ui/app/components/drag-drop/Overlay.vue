<script setup lang="ts">
import { usePreferredReducedMotion } from '@vueuse/core'
import { Motion } from 'motion-v'

const { t } = useLocale()
const prefersReducedMotion = usePreferredReducedMotion()
const reduceMotion = computed(() => prefersReducedMotion.value === 'reduce')

defineProps<{
  show: boolean
}>()
</script>

<template>
  <div class="sr-only" role="status" aria-live="polite">
    {{ show ? t('file.drop') : '' }}
  </div>
  <div
    v-if="show"
    aria-hidden="true"
    class="absolute inset-0 z-50 flex items-center justify-center backdrop-blur-lg rounded-lg pointer-events-none"
  >
    <div class="absolute text-center">
      <div class="flex items-center justify-center gap-2">
        <Motion
          :initial="reduceMotion ? { opacity: 0 } : { rotate: 0, scale: 0.5, opacity: 0 }"
          :animate="show ? (reduceMotion ? { opacity: 1 } : { rotate: -15, scale: 1, opacity: 1 }) : {}"
          :transition="{
            type: 'spring',
            stiffness: 400,
            damping: 18,
            delay: 0
          }"
        >
          <UIcon name="i-lucide-file-text" class="size-12" />
        </Motion>
        <Motion
          :initial="reduceMotion ? { opacity: 0 } : { scale: 0.5, opacity: 0, y: 0 }"
          :animate="show ? (reduceMotion ? { opacity: 1 } : { scale: 1, opacity: 1, y: 0 }) : {}"
          :transition="{
            type: 'spring',
            stiffness: 500,
            damping: 15,
            delay: 0.03
          }"
        >
          <UIcon name="i-lucide-file" class="size-14" />
        </Motion>

        <Motion
          :initial="reduceMotion ? { opacity: 0 } : { rotate: 0, scale: 0.5, opacity: 0 }"
          :animate="show ? (reduceMotion ? { opacity: 1 } : { rotate: 15, scale: 1, opacity: 1 }) : {}"
          :transition="{
            type: 'spring',
            stiffness: 400,
            damping: 18,
            delay: 0.06
          }"
        >
          <UIcon name="i-lucide-file-spreadsheet" class="size-12" />
        </Motion>
      </div>

      <Motion
        :initial="reduceMotion ? { opacity: 0 } : { opacity: 0, y: 10 }"
        :animate="show ? (reduceMotion ? { opacity: 1 } : { opacity: 1, y: 0 }) : {}"
        :transition="{
          delay: 0.08,
          duration: 0.2
        }"
      >
        <p class="text-lg/7 font-medium mt-4">{{ t('file.drop') }}</p>
      </Motion>
    </div>
  </div>
</template>
