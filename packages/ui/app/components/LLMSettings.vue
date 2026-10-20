<script setup lang="ts">
import { LLM_PROVIDERS, defaultLLMSettings, providerSettingsSchema, type LLMProvider } from '#shared/utils/llm-settings'

const { t } = useLocale()

defineProps<{ collapsed?: boolean }>()

const { settings, open, requestedProvider } = useLLMSettings()
const { model } = useModels()
const { $chatStore, $saveLLMSettings } = useNuxtApp()
const desktop = useRuntimeConfig().public.desktop
const toast = useToast()
const provider = ref<LLMProvider>('anthropic')
const draft = ref(defaultLLMSettings())
const headerRows = ref<Record<LLMProvider, { id: string; key: string; value: string }[]>>({
  anthropic: [],
  google: [],
  openai: []
})
const error = ref('')
const saving = ref(false)
const current = computed(() => LLM_PROVIDERS.find((item) => item.id === provider.value)!)

watch(open, (value) => {
  error.value = ''
  if (value) {
    draft.value = JSON.parse(JSON.stringify(settings.value))
    for (const item of LLM_PROVIDERS)
      headerRows.value[item.id] = Object.entries(draft.value[item.id].headers ?? {}).map(([key, value]) => ({
        id: crypto.randomUUID(),
        key,
        value
      }))
    provider.value =
      requestedProvider.value ?? LLM_PROVIDERS.find((item) => model.value.startsWith(`${item.id}/`))?.id ?? 'anthropic'
    requestedProvider.value = null
  } else {
    // Do not retain an extra copy of credentials after closing the form.
    draft.value = defaultLLMSettings()
    headerRows.value = { anthropic: [], google: [], openai: [] }
  }
})

async function addHeader() {
  const id = crypto.randomUUID()
  headerRows.value[provider.value].push({ id, key: '', value: '' })
  await nextTick()
  document.getElementById(id)?.focus()
}

async function save(forget = false) {
  error.value = ''
  const next = JSON.parse(JSON.stringify(settings.value))
  if (forget) next[provider.value] = { apiKey: '', baseURL: '' }
  else {
    for (const item of LLM_PROVIDERS) {
      const rows = headerRows.value[item.id]
        .map((row) => ({ key: row.key.trim(), value: row.value }))
        .filter((row) => row.key || row.value)
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
      draft.value[item.id].headers = Object.fromEntries(rows.map((row) => [row.key, row.value]))
      const parsed = providerSettingsSchema.safeParse(draft.value[item.id])
      if (!parsed.success) {
        provider.value = item.id
        const field = parsed.error.issues[0]!.path[0]
        error.value = t(
          field === 'apiKey' ? 'llm.invalidKey' : field === 'baseURL' ? 'llm.invalidURL' : 'llm.invalidHeaders'
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
    open.value = false
  } catch {
    error.value = desktop ? t('llm.saveFailedOS') : t('llm.saveFailedBrowser')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="t('llm.title')"
    :description="desktop ? t('llm.descriptionOS') : t('llm.descriptionBrowser')"
    :dismissible="!saving"
    :close="!saving"
  >
    <UButton
      :label="collapsed ? '' : t('llm.title')"
      icon="i-lucide-settings-2"
      color="neutral"
      variant="ghost"
      class="w-full"
      :aria-label="t('llm.title')"
    />

    <template #body>
      <form id="llm-settings" class="flex flex-col gap-5" @submit.prevent="save()">
        <UFormField :label="t('llm.provider')" name="provider">
          <USelect
            v-model="provider"
            :items="[...LLM_PROVIDERS]"
            value-key="id"
            label-key="label"
            class="w-full"
            :disabled="saving"
          />
        </UFormField>
        <p class="text-sm text-muted">
          {{ t('llm.modelsDescription') }}
        </p>
        <UFormField :label="t('llm.apiKey')" name="apiKey">
          <UInput
            v-model="draft[provider].apiKey"
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
            v-model="draft[provider].baseURL"
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
          <div v-for="(row, index) in headerRows[provider]" :key="row.id" class="flex items-start gap-2">
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
              @click="headerRows[provider].splice(index, 1)"
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
    </template>

    <template #footer>
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
            (!settings[provider]?.apiKey &&
              !settings[provider]?.baseURL &&
              !Object.keys(settings[provider]?.headers ?? {}).length)
          "
          @click="save(true)"
        />
        <div class="flex gap-2">
          <UButton
            :label="t('common.cancel')"
            color="neutral"
            variant="ghost"
            :disabled="saving"
            @click="open = false"
          />
          <UButton
            :label="desktop ? t('llm.saveOS') : t('llm.saveBrowser')"
            type="submit"
            form="llm-settings"
            :loading="saving"
          />
        </div>
      </div>
    </template>
  </UModal>
</template>
