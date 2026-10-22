<script setup lang="ts">
import type { Ref } from 'vue'
import { useMounted } from '@vueuse/core'

const { t } = useLocale()
const {
  models,
  defaultModel,
  saveDefaultModel,
  titleModel,
  saveTitleModel,
  loading,
  error: modelError,
  refresh
} = useModels()
const mounted = useMounted()
const draft = ref('')
const titleDraft = ref('')
onMounted(() => {
  draft.value = defaultModel.value
  titleDraft.value = titleModel.value
})
const error = ref('')
const toast = useToast()
// 빈 문자열은 선택 항목의 값으로 쓸 수 없어 목록이 열리지 않으므로, 저장값 ''(선택 안 함)은 이 값으로 바꿔 표시합니다.
const NONE = 'none'
function modelItems(value: string, fallback: string) {
  const available = [...models.value]
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
    saveDefaultModel(draft.value)
    saveTitleModel(titleDraft.value)
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
      <UFormField :label="t('model.defaultLabel')" :description="t('model.defaultDescription')" name="defaultModel">
        <USelectMenu
          v-model="defaultSelection"
          :items="items"
          value-key="value"
          :loading="mounted && loading"
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
      <UFormField :label="t('model.titleLabel')" :description="t('model.titleDescription')" name="titleModel">
        <USelectMenu
          v-model="titleSelection"
          :items="titleItems"
          value-key="value"
          :loading="mounted && loading"
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
      <p v-if="mounted && modelError" role="alert" class="text-sm text-error">
        {{ modelError }}
      </p>
      <p v-if="error" role="alert" class="text-sm text-error">
        {{ error }}
      </p>
      <div class="flex items-center justify-between gap-3">
        <UButton
          :label="t('model.refresh')"
          :icon="mounted && loading ? 'i-lucide-loader-circle' : 'i-lucide-refresh-cw'"
          :ui="{ leadingIcon: mounted && loading ? 'motion-safe:animate-spin' : '' }"
          :aria-busy="mounted && loading"
          color="neutral"
          variant="ghost"
          @click="refresh()"
        />
        <UButton type="submit" :disabled="!mounted" :label="t('common.save')" />
      </div>
    </form>
  </section>
</template>
