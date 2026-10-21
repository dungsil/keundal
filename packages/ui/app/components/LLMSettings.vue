<script setup lang="ts">
import {
  LLM_PROVIDERS,
  defaultLLMSettings,
  configuredProviders,
  providerSettingsSchema,
  type LLMProvider
} from '#shared/utils/llm-settings'

const { t } = useLocale()

defineProps<{ returnTo: string }>()

const { settings } = useLLMSettings()
const route = useRoute()
const { model } = useModels()
const { $chatStore, $saveLLMSettings } = useNuxtApp()
const desktop = useRuntimeConfig().public.desktop
const toast = useToast()
const provider = ref('anthropic')
const newType = ref<LLMProvider>('openai')
const draft = ref(defaultLLMSettings())
const headerRows = ref<Record<string, { id: string; key: string; value: string }[]>>({
  anthropic: [],
  google: [],
  openai: []
})
const error = ref('')
const saving = ref(false)
const providers = computed(() => configuredProviders(draft.value))
const current = computed(() => providers.value.find((item) => item.id === provider.value)!)
const currentDraft = computed(() => draft.value[provider.value]!)
const currentHeaders = computed(() => headerRows.value[provider.value]!)

function addProvider() {
  const id = `${newType.value}@${crypto.randomUUID()}`
  const preset = LLM_PROVIDERS.find((item) => item.id === newType.value)!
  draft.value[id] = {
    name: `${preset.label} ${providers.value.filter((item) => item.providerType === newType.value).length + 1}`,
    apiKey: '',
    baseURL: preset.baseURL
  }
  headerRows.value[id] = []
  provider.value = id
}

function loadDraft() {
  draft.value = JSON.parse(JSON.stringify(settings.value))
  for (const item of configuredProviders(draft.value))
    headerRows.value[item.id] = Object.entries(draft.value[item.id]!.headers ?? {}).map(([key, value]) => ({
      id: crypto.randomUUID(),
      key,
      value
    }))
}

loadDraft()
watch(
  [() => route.query.provider, model],
  ([value]) => {
    provider.value =
      configuredProviders(settings.value).find((item) => item.id === value)?.id ??
      configuredProviders(settings.value).find((item) => model.value.startsWith(`${item.id}/`))?.id ??
      'anthropic'
  },
  { immediate: true }
)

onBeforeRouteLeave(() => !saving.value)

async function addHeader() {
  const id = crypto.randomUUID()
  currentHeaders.value.push({ id, key: '', value: '' })
  await nextTick()
  document.getElementById(id)?.focus()
}

async function save(forget = false) {
  if (saving.value) return
  error.value = ''
  const next = JSON.parse(JSON.stringify(settings.value))
  if (forget) {
    if (provider.value.includes('@')) delete next[provider.value]
    else next[provider.value] = { apiKey: '', baseURL: '' }
  } else {
    for (const item of configuredProviders(draft.value)) {
      const rows = headerRows.value[item.id]!.map((row) => ({ key: row.key.trim(), value: row.value })).filter(
        (row) => row.key || row.value
      )
      if (rows.some((row) => !row.key)) {
        provider.value = item.id
        error.value = t('llm.headerKeyRequired')
        return
      }
      if (new Set(rows.map((row) => row.key.toLowerCase())).size !== rows.length) {
        provider.value = item.id
        error.value = t('llm.duplicateHeaders')
        return
      }
      draft.value[item.id]!.headers = Object.fromEntries(rows.map((row) => [row.key, row.value]))
      const parsed = providerSettingsSchema.safeParse(draft.value[item.id])
      if (!parsed.success) {
        provider.value = item.id
        const field = parsed.error.issues[0]!.path[0]
        error.value = t(
          field === 'name'
            ? 'llm.invalidName'
            : field === 'apiKey'
              ? 'llm.invalidKey'
              : field === 'baseURL'
                ? 'llm.invalidURL'
                : 'llm.invalidHeaders'
        )
        return
      }
      next[item.id] = parsed.data
    }
  }
  saving.value = true
  try {
    await $chatStore.stop()
    await $saveLLMSettings(next)
    toast.add({
      title: forget ? t('llm.removed') : desktop ? t('llm.savedOS') : t('llm.savedBrowser'),
      icon: 'i-lucide-check',
      color: 'success'
    })
    loadDraft()
    if (!draft.value[provider.value]) provider.value = 'anthropic'
  } catch {
    error.value = desktop ? t('llm.saveFailedOS') : t('llm.saveFailedBrowser')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <section class="space-y-6" aria-labelledby="llm-settings-title">
    <div class="space-y-2">
      <h2 id="llm-settings-title" class="text-lg font-semibold text-highlighted">LLM</h2>
      <p class="text-sm text-muted">
        {{ desktop ? t('llm.descriptionOS') : t('llm.descriptionBrowser') }}
      </p>
    </div>
    <form id="llm-settings" class="flex flex-col gap-5" @submit.prevent="save()">
      <UFormField :label="t('llm.provider')" name="provider">
        <USelect
          v-model="provider"
          :items="providers"
          value-key="id"
          label-key="label"
          class="w-full"
          :disabled="saving"
        />
      </UFormField>
      <div class="flex items-end gap-2">
        <UFormField :label="t('llm.providerType')" class="flex-1">
          <USelect
            v-model="newType"
            :items="[...LLM_PROVIDERS]"
            value-key="id"
            label-key="label"
            class="w-full"
            :disabled="saving"
          />
        </UFormField>
        <UButton
          type="button"
          icon="i-lucide-plus"
          :label="t('llm.addProvider')"
          :disabled="saving"
          @click="addProvider"
        />
      </div>
      <UFormField :label="t('llm.providerName')" name="providerName">
        <UInput
          v-model="currentDraft.name"
          :placeholder="current.label"
          :maxlength="100"
          :disabled="saving"
          class="w-full"
        />
      </UFormField>
      <p class="text-sm text-muted">
        {{ t('llm.modelsDescription') }}
      </p>
      <UFormField :label="t('llm.apiKey')" name="apiKey">
        <UInput
          v-model="currentDraft.apiKey"
          type="password"
          autocomplete="off"
          autocapitalize="off"
          :spellcheck="false"
          :placeholder="t('llm.apiKeyPlaceholder')"
          class="w-full"
          :disabled="saving"
        />
      </UFormField>
      <UFormField :label="t('llm.baseURL')" name="baseURL" :description="t('llm.baseURLDescription')">
        <UInput
          v-model="currentDraft.baseURL"
          :placeholder="current.baseURL"
          type="url"
          autocomplete="off"
          class="w-full"
          :disabled="saving"
        />
      </UFormField>
      <fieldset class="space-y-3">
        <legend class="text-sm font-medium text-highlighted">{{ t('llm.headers') }}</legend>
        <p class="text-sm text-muted">
          {{ t('llm.headersDescription') }}
        </p>
        <div v-for="(row, index) in currentHeaders" :key="row.id" class="flex items-start gap-2">
          <UInput
            :id="row.id"
            v-model="row.key"
            :aria-label="t('llm.headerKey', { index: index + 1 })"
            :placeholder="t('common.key')"
            autocomplete="off"
            autocapitalize="off"
            :spellcheck="false"
            class="min-w-0 flex-1"
            :disabled="saving"
          />
          <UInput
            v-model="row.value"
            :aria-label="t('llm.headerValue', { index: index + 1 })"
            :placeholder="t('common.value')"
            autocomplete="off"
            autocapitalize="off"
            :spellcheck="false"
            class="min-w-0 flex-1"
            :disabled="saving"
          />
          <UButton
            type="button"
            icon="i-lucide-trash-2"
            :aria-label="t('llm.removeHeader', { index: index + 1 })"
            color="neutral"
            variant="ghost"
            :disabled="saving"
            @click="currentHeaders.splice(index, 1)"
          />
        </div>
        <UButton
          type="button"
          :label="t('llm.addHeader')"
          icon="i-lucide-plus"
          color="neutral"
          variant="outline"
          :disabled="saving"
          @click="addHeader"
        />
      </fieldset>
      <UAlert
        :icon="desktop ? 'i-lucide-shield-check' : 'i-lucide-shield-alert'"
        color="neutral"
        variant="subtle"
        :title="desktop ? t('llm.protectedOS') : t('llm.browserWarning')"
        :description="desktop ? t('llm.storageOS') : t('llm.storageBrowser')"
      />
    </form>
    <div class="flex flex-wrap items-center justify-between gap-3 w-full">
      <p v-if="error" role="alert" class="w-full text-sm text-error">
        {{ error }}
      </p>
      <UButton
        :label="t('llm.forget')"
        color="error"
        variant="ghost"
        :disabled="
          saving ||
          (!provider.includes('@') &&
            !settings[provider]?.name &&
            !settings[provider]?.apiKey &&
            !settings[provider]?.baseURL &&
            !Object.keys(settings[provider]?.headers ?? {}).length)
        "
        @click="save(true)"
      />
      <div class="flex gap-2">
        <UButton :label="t('common.cancel')" :to="returnTo" color="neutral" variant="ghost" :disabled="saving" />
        <UButton
          :label="desktop ? t('llm.saveOS') : t('llm.saveBrowser')"
          type="submit"
          form="llm-settings"
          :loading="saving"
        />
      </div>
    </div>
  </section>
</template>
