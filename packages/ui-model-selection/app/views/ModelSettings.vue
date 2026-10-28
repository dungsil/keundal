<script setup lang="ts">
import type { ModelOption } from '@keundal/chat/models'
import { parseModelRecoveryPolicy, type ModelRecoveryPolicy } from '@keundal/chat/model-preferences'
import { reactive, type Ref } from 'vue'
import { useMounted } from '@vueuse/core'

import { useText } from '../locale'

const { t } = useText()
const props = defineProps<{
  models: Ref<ModelOption[]>
  defaultModel: Ref<string>
  titleModel: Ref<string>
  saveDefaultModel: (value: string) => void
  saveTitleModel: (value: string) => void
  modelRecovery: Ref<ModelRecoveryPolicy | undefined>
  saveModelRecovery: (value: ModelRecoveryPolicy) => void
  loading: Ref<boolean>
  modelError: Ref<string>
  refresh: (force?: boolean) => Promise<void>
}>()
const mounted = useMounted()
const draft = ref('')
const titleDraft = ref('')
const fallbackModels = ref<string[]>([])
const retry = reactive({ maxRetries: 2, initialDelayMs: 250, maxDelayMs: 4000 })
onMounted(() => {
  draft.value = props.defaultModel.value
  titleDraft.value = props.titleModel.value
  const policy = props.modelRecovery.value
  fallbackModels.value = [...policy?.fallbackModels ?? []]
  Object.assign(retry, policy?.retry === false ? { maxRetries: 0 } : policy?.retry)
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
const unusedModels = computed(() => props.models.value.filter(item => !fallbackModels.value.includes(item.value)))
function fallbackItems(value: string) {
  return modelItems(value, '').slice(1).filter(item => item.value === value || !fallbackModels.value.includes(item.value))
}
function moveFallback(index: number, offset: number) {
  const next = [...fallbackModels.value]
  ;[next[index], next[index + offset]] = [next[index + offset]!, next[index]!]
  fallbackModels.value = next
}
// 선택값은 한 줄로 줄이고, 펼친 목록에서는 긴 모델 id도 끝까지 읽을 수 있게 합니다.
const selectUi = { value: 'min-w-0 truncate text-start', itemLabel: 'whitespace-normal break-all' }

function save() {
  error.value = ''
  let policy: ModelRecoveryPolicy
  try {
    policy = parseModelRecoveryPolicy({ retry: { ...retry }, fallbackModels: [...fallbackModels.value] })
  } catch {
    error.value = t('model.invalidRecovery')
    return
  }
  try {
    props.saveModelRecovery(policy)
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
          :ui="selectUi"
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
          :ui="selectUi"
          @update:open="
            (open) => {
              if (open) refresh(false)
            }
          "
        />
      </UFormField>
      <fieldset class="space-y-3 border-t border-default pt-4" :disabled="!mounted">
        <legend class="px-1 font-medium text-highlighted">{{ t('model.fallbackChain') }}</legend>
        <p class="text-sm text-muted">{{ t('model.fallbackCompatibility') }}</p>
        <ol class="space-y-3">
          <li v-for="(value, index) in fallbackModels" :key="index" class="space-y-1">
            <UFormField :label="t('model.fallbackPosition', { count: index + 1 })" :name="`fallback-${index}`">
              <div class="flex flex-wrap items-center gap-2">
                <USelectMenu
                  v-model="fallbackModels[index]"
                  :items="fallbackItems(value)"
                  value-key="value"
                  :aria-label="t('model.fallbackPosition', { count: index + 1 })"
                  :loading="mounted && loading.value"
                  class="w-full min-w-0 sm:w-auto sm:flex-1"
                  :ui="selectUi"
                  @update:open="open => { if (open) refresh(false) }"
                />
                <div class="ms-auto flex gap-1">
                  <UButton type="button" icon="i-lucide-arrow-up" color="neutral" variant="ghost" :disabled="index === 0" :aria-label="t('model.moveUp', { count: index + 1 })" @click="moveFallback(index, -1)" />
                  <UButton type="button" icon="i-lucide-arrow-down" color="neutral" variant="ghost" :disabled="index === fallbackModels.length - 1" :aria-label="t('model.moveDown', { count: index + 1 })" @click="moveFallback(index, 1)" />
                  <UButton type="button" icon="i-lucide-trash-2" color="error" variant="ghost" :aria-label="t('model.removeFallback', { count: index + 1 })" @click="fallbackModels.splice(index, 1)" />
                </div>
              </div>
            </UFormField>
          </li>
        </ol>
        <UButton type="button" icon="i-lucide-plus" color="neutral" variant="outline" :label="t('model.addFallback')" :disabled="!mounted || fallbackModels.length >= 8 || !unusedModels.length" @click="fallbackModels.push(unusedModels[0]!.value)" />
      </fieldset>
      <fieldset class="space-y-3 border-t border-default pt-4" :disabled="!mounted">
        <legend class="px-1 font-medium text-highlighted">{{ t('model.retryPolicy') }}</legend>
        <div class="grid gap-3 sm:grid-cols-3">
          <UFormField :label="t('model.maxRetries')" name="maxRetries">
            <UInput v-model.number="retry.maxRetries" type="number" :min="0" :max="5" :step="1" required class="w-full" />
          </UFormField>
          <UFormField :label="t('model.initialDelay')" name="initialDelayMs">
            <UInput v-model.number="retry.initialDelayMs" type="number" :min="0" :max="60000" :step="1" required class="w-full" />
          </UFormField>
          <UFormField :label="t('model.maxDelay')" name="maxDelayMs">
            <UInput v-model.number="retry.maxDelayMs" type="number" :min="0" :max="60000" :step="1" required class="w-full" />
          </UFormField>
        </div>
      </fieldset>
      <div class="space-y-2">
        <p v-if="mounted && modelError.value" role="alert" class="text-sm text-error">
          {{ modelError.value }}
        </p>
        <p v-if="error" role="alert" class="text-sm text-error">
          {{ error }}
        </p>
      </div>
      <div class="flex flex-wrap items-center justify-between gap-3">
        <UButton
          :label="t('model.refresh')"
          :icon="mounted && loading.value ? 'i-lucide-loader-circle' : 'i-lucide-refresh-cw'"
          :ui="{ leadingIcon: mounted && loading.value ? 'motion-safe:animate-spin' : '' }"
          :aria-busy="mounted && loading.value"
          color="neutral"
          variant="ghost"
          @click="refresh()"
        />
        <UButton type="submit" :disabled="!mounted" :label="t('common.save')" class="ms-auto" />
      </div>
    </form>
  </section>
</template>
