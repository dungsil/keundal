<script setup lang="ts">
import { useMounted } from '@vueuse/core'
import type { Ref } from 'vue'

import { useText } from '../locale'

const props = defineProps<{
  systemPrompt: Ref<string>
  saveSystemPrompt: (value: string) => void
}>()

const { t } = useText()
const mounted = useMounted()
const draft = ref('')
const error = ref('')
const toast = useToast()

onMounted(() => {
  draft.value = props.systemPrompt.value
})

function save() {
  error.value = ''
  try {
    props.saveSystemPrompt(draft.value)
    draft.value = props.systemPrompt.value
    toast.add({ title: t('prompt.saved'), icon: 'i-lucide-check', color: 'success' })
  } catch {
    error.value = t('prompt.saveFailed')
  }
}
</script>

<template>
  <section class="space-y-4" aria-labelledby="system-prompt-settings-title">
    <h2 id="system-prompt-settings-title" class="text-lg font-semibold text-highlighted">
      {{ t('prompt.title') }}
    </h2>
    <form class="space-y-4" @submit.prevent="save">
      <UFormField :label="t('prompt.title')" name="systemPrompt">
        <UTextarea
          id="system-prompt"
          v-model="draft"
          :placeholder="t('prompt.placeholder')"
          :rows="10"
          :disabled="!mounted"
          class="w-full"
        />
      </UFormField>
      <p v-if="error" role="alert" class="text-sm text-error">
        {{ error }}
      </p>
      <div class="flex justify-end">
        <UButton type="submit" :disabled="!mounted" :label="t('common.save')" />
      </div>
    </form>
  </section>
</template>
