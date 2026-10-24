<script setup lang="ts">
import type { ModelOption } from '@keundal/chat/models'
import type { Ref } from 'vue'
import { useMounted } from '@vueuse/core'

import { useText } from '../locale'

const { t } = useText()
const props = defineProps<{
  models: Ref<ModelOption[]>
  defaultModel: Ref<string>
  titleModel: Ref<string>
  saveDefaultModel: (value: string) => void
  saveTitleModel: (value: string) => void
  loading: Ref<boolean>
  modelError: Ref<string>
  refresh: (force?: boolean) => Promise<void>
}>()
const mounted = useMounted()
const draft = ref('')
const titleDraft = ref('')
onMounted(() => {
  draft.value = props.defaultModel.value
  titleDraft.value = props.titleModel.value
})
const error = ref('')
const toast = useToast()
// 빈 문자열은 선택 항목의 값으로 쓸 수 없어 목록이 열리지 않으므로, 저장값 ''(선택 안 함)은 이 값으로 바꿔 표시합니다.
const NONE = 'none'
function modelItems(value: string, fallback: string) {
  const available = [...props.models.value]
  if (value && !available.some(item => item.value === value))
    available.unshift({ value, label: value, icon: 'i-lucide-bot' })
  return [{ value: NONE, label: fallback, icon: 'i-lucide-bot' }, ...available]
}
function selection(draft: Ref<string>) {
  return computed({
    get: () => draft.value || NONE,
    set: (value: string) => { draft.value = value === NONE ? '' : value }
  })
}
const defaultSelection = selection(draft)
const titleSelection = selection(titleDraft)
const items = computed(() => modelItems(draft.value, t('model.noDefault')))
const titleItems = computed(() => modelItems(titleDraft.value, t('model.useChatModel')))
// 모델 id는 공백이 없는 긴 문자열일 수 있어, 말줄임 대신 줄바꿈해 끝부분까지 보이게 합니다.
const wrapUi = { value: 'whitespace-normal break-all', itemLabel: 'whitespace-normal break-all' }

function save() {
  error.value = ''
  try {
    props.saveDefaultModel(draft.value)
    props.saveTitleModel(titleDraft.value)
    toast.add({ title: t('model.defaultSaved'), icon: 'i-lucide-check', color: 'success' })
  } catch {
    error.value = t('model.defaultSaveFailed')
  }
}
</script>

<template>
  <section class="space-y-4" aria-labelledby="model-settings-title">
    <h2 id="model-settings-title" class="text-lg font-semibold text-highlighted">
      {{ t('model.defaultTitle') }}
    </h2>
    <form class="space-y-4" @submit.prevent="save">
      <UFormField :label="t('model.defaultLabel')" name="defaultModel">
        <USelectMenu
          v-model="defaultSelection"
          :items="items"
          value-key="value"
          :loading="mounted && loading.value"
          :disabled="!mounted"
          class="w-full"
          :ui="wrapUi"
          @update:open="
            (open) => {
              if (open) refresh(false)
            }
          "
        />
      </UFormField>
      <UFormField :label="t('model.titleLabel')" name="titleModel">
        <USelectMenu
          v-model="titleSelection"
          :items="titleItems"
          value-key="value"
          :loading="mounted && loading.value"
          :disabled="!mounted"
          class="w-full"
          :ui="wrapUi"
          @update:open="
            (open) => {
              if (open) refresh(false)
            }
          "
        />
      </UFormField>
      <div class="space-y-2">
        <p v-if="mounted && modelError.value" role="alert" class="text-sm text-error">
          {{ modelError.value }}
        </p>
        <p v-if="error" role="alert" class="text-sm text-error">
          {{ error }}
        </p>
      </div>
      <div class="flex items-center justify-between gap-3">
        <UButton
          :label="t('model.refresh')"
          :icon="mounted && loading.value ? 'i-lucide-loader-circle' : 'i-lucide-refresh-cw'"
          :ui="{ leadingIcon: mounted && loading.value ? 'motion-safe:animate-spin' : '' }"
          :aria-busy="mounted && loading.value"
          color="neutral"
          variant="ghost"
          @click="refresh()"
        />
        <UButton type="submit" :disabled="!mounted" :label="t('common.save')" />
      </div>
    </form>
  </section>
</template>
