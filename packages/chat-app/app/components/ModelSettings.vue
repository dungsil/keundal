<script setup lang="ts">
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
const draft = ref(defaultModel.value)
const titleDraft = ref(titleModel.value)
const error = ref('')
const toast = useToast()
function modelItems(value: string, fallback: string) {
  const available = [...models.value]
  if (value && !available.some(item => item.value === value))
    available.unshift({ value, label: value, icon: 'i-lucide-bot' })
  return [{ value: '', label: fallback, icon: 'i-lucide-bot' }, ...available]
}
const items = computed(() => modelItems(draft.value, t('model.noDefault')))
const titleItems = computed(() => modelItems(titleDraft.value, t('model.useChatModel')))

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
          v-model="draft"
          :items="items"
          value-key="value"
          :loading="loading"
          class="w-full"
          @update:open="
            (open) => {
              if (open) refresh(false)
            }
          "
        />
      </UFormField>
      <UFormField :label="t('model.titleLabel')" :description="t('model.titleDescription')" name="titleModel">
        <USelectMenu
          v-model="titleDraft"
          :items="titleItems"
          value-key="value"
          :loading="loading"
          class="w-full"
          @update:open="
            (open) => {
              if (open) refresh(false)
            }
          "
        />
      </UFormField>
      <p v-if="modelError" role="alert" class="text-sm text-error">
        {{ modelError }}
      </p>
      <p v-if="error" role="alert" class="text-sm text-error">
        {{ error }}
      </p>
      <div class="flex items-center justify-between gap-3">
        <UButton
          :label="t('model.refresh')"
          icon="i-lucide-refresh-cw"
          color="neutral"
          variant="ghost"
          :loading="loading"
          @click="refresh()"
        />
        <UButton type="submit" :label="t('common.save')" />
      </div>
    </form>
  </section>
</template>
