<script setup lang="ts">
import { useMounted } from '@vueuse/core'
import {
  LLM_PROVIDERS,
  defaultLLMSettings,
  configuredProviders,
  registeredProviders,
  providerSettingsSchema,
  type LLMProvider,
  type LLMSettings
} from '@keundal/llm-settings'
import type { Ref } from 'vue'

import { useText } from '../locale'

const props = defineProps<{
  /** Saved provider settings. */
  settings: Ref<LLMSettings>
  /** The selected chat model; the provider that serves it opens first. */
  model: Ref<string>
  capabilities: { secureSettings: boolean }
  /** Stop active responses before the settings change. */
  stop: () => Promise<void>
  saveSettings: (next: LLMSettings) => Promise<void>
}>()

const { t } = useText()

const saved = computed(() => props.settings.value)
const mounted = useMounted()
const route = useRoute()
const secureSettings = props.capabilities.secureSettings
const toast = useToast()
const provider = ref('')
const adding = ref(false)
const newName = ref('')
const visibleIds = ref<string[]>([])
const newType = ref<LLMProvider>('openai')
const draft = ref(defaultLLMSettings())
const headerRows = ref<Record<string, { id: string, key: string, value: string }[]>>({
  anthropic: [],
  google: [],
  openai: [],
  'openai-chat': []
})
const error = ref('')
const errorField = ref<'' | 'name' | 'apiKey' | 'baseURL'>('')
// Every header value is masked like the API key. Guessing which names carry credentials missed
// headers named by the provider, so the row exposes a toggle instead.
const revealedHeaders = ref<Record<string, boolean>>({})
const saving = ref(false)
const providers = computed(() => configuredProviders(draft.value).filter(item => visibleIds.value.includes(item.id)))
const current = computed(() => providers.value.find(item => item.id === provider.value))
const currentDraft = computed(() => draft.value[provider.value]!)
const currentHeaders = computed(() => headerRows.value[provider.value]!)

function addProvider() {
  const id = `${newType.value}@${crypto.randomUUID()}`
  const preset = LLM_PROVIDERS.find(item => item.id === newType.value)!
  draft.value[id] = {
    name: newName.value.trim() || preset.label,
    apiKey: '',
    baseURL: preset.baseURL
  }
  headerRows.value[id] = []
  visibleIds.value.push(id)
  provider.value = id
  adding.value = false
  newName.value = ''
}

function loadDraft() {
  draft.value = JSON.parse(JSON.stringify(saved.value))
  revealedHeaders.value = {}
  visibleIds.value = registeredProviders(saved.value).map(item => item.id)
  for (const item of configuredProviders(draft.value))
    headerRows.value[item.id] = Object.entries(draft.value[item.id]!.headers ?? {}).map(([key, value]) => ({
      id: crypto.randomUUID(),
      key,
      value
    }))
}

onMounted(loadDraft)
watch(
  [() => route.query.provider, () => props.model.value, mounted],
  ([value, , ready]) => {
    if (!ready) return
    provider.value
      = registeredProviders(saved.value).find(item => item.id === value)?.id
        ?? registeredProviders(saved.value).find(item => props.model.value.startsWith(`${item.id}/`))?.id
        ?? providers.value[0]?.id ?? ''
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
  errorField.value = ''
  const next = JSON.parse(JSON.stringify(saved.value))
  if (forget) {
    if (provider.value.includes('@')) Reflect.deleteProperty(next, provider.value)
    else next[provider.value] = { apiKey: '', baseURL: '' }
  } else {
    for (const item of providers.value) {
      const rows = headerRows.value[item.id]!.map(row => ({ key: row.key.trim(), value: row.value })).filter(
        row => row.key || row.value
      )
      if (rows.some(row => !row.key)) {
        provider.value = item.id
        error.value = t('llm.headerKeyRequired')
        await nextTick()
        document.getElementById(headerRows.value[item.id]!.find(row => !row.key.trim())!.id)?.focus()
        return
      }
      if (new Set(rows.map(row => row.key.toLowerCase())).size !== rows.length) {
        provider.value = item.id
        error.value = t('llm.duplicateHeaders')
        await nextTick()
        document.getElementById(headerRows.value[item.id]!.find(row => row.key.trim())!.id)?.focus()
        return
      }
      draft.value[item.id]!.headers = Object.fromEntries(rows.map(row => [row.key, row.value]))
      const parsed = providerSettingsSchema.safeParse(draft.value[item.id])
      if (!parsed.success) {
        provider.value = item.id
        const field = parsed.error.issues[0]!.path[0]
        errorField.value = field === 'name' || field === 'apiKey' || field === 'baseURL' ? field : ''
        error.value = t(
          field === 'name'
            ? 'llm.invalidName'
            : field === 'apiKey'
              ? 'llm.invalidKey'
              : field === 'baseURL'
                ? 'llm.invalidURL'
                : 'llm.invalidHeaders'
        )
        await nextTick()
        const inputId = field === 'name'
          ? 'llm-provider-name'
          : field === 'apiKey'
            ? 'llm-api-key'
            : field === 'baseURL'
              ? 'llm-base-url'
              : undefined
        const target = inputId ?? headerRows.value[item.id]![0]?.id
        if (target) document.getElementById(target)?.focus()
        return
      }
      next[item.id] = parsed.data
    }
  }
  saving.value = true
  try {
    await props.stop()
    await props.saveSettings(next)
    toast.add({
      title: forget ? t('llm.removed') : secureSettings ? t('llm.savedOS') : t('llm.savedBrowser'),
      icon: 'i-lucide-check',
      color: 'success'
    })
    loadDraft()
    if (!providers.value.some(item => item.id === provider.value)) provider.value = providers.value[0]?.id ?? ''
  } catch {
    error.value = secureSettings ? t('llm.saveFailedOS') : t('llm.saveFailedBrowser')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <section class="space-y-4" aria-labelledby="llm-settings-title">
    <h2 id="llm-settings-title" class="text-lg font-semibold text-highlighted">
      LLM
    </h2>
    <div class="space-y-3">
      <p v-if="!providers.length" class="text-sm text-muted">
        {{ t('llm.noProviders') }}
      </p>
      <ul v-else class="space-y-2" :aria-label="t('llm.registeredProviders')">
        <li
          v-for="item in providers"
          :key="item.id"
          class="rounded-lg border"
          :class="provider === item.id ? 'border-primary' : 'border-default'"
        >
          <button
            :id="`llm-provider-${item.id}`"
            type="button"
            class="flex w-full items-center justify-between gap-3 rounded-lg p-4 text-left"
            :class="provider === item.id ? 'rounded-b-none bg-primary/5' : ''"
            :aria-expanded="provider === item.id"
            :aria-controls="provider === item.id ? 'llm-settings' : undefined"
            :disabled="!mounted || saving"
            @click="provider = provider === item.id ? '' : item.id"
          >
            <span class="block break-words font-medium text-highlighted">{{ item.label }}</span>
            <UIcon name="i-lucide-chevron-down" class="shrink-0" :class="provider === item.id ? 'rotate-180' : ''" />
          </button>
          <form
            v-if="provider === item.id && current"
            id="llm-settings"
            class="flex flex-col gap-5 border-t border-default p-4"
            :aria-labelledby="`llm-provider-${item.id}`"
            @submit.prevent="save()"
          >
            <UFormField :label="t('llm.providerName')" name="providerName" :error="errorField === 'name' ? error : undefined">
              <UInput
                id="llm-provider-name"
                v-model="currentDraft.name"
                :placeholder="current.label"
                :maxlength="100"
                :disabled="!mounted || saving"
                class="w-full"
              />
            </UFormField>
            <UFormField :label="t('llm.apiKey')" name="apiKey" :error="errorField === 'apiKey' ? error : undefined">
              <UInput
                id="llm-api-key"
                v-model="currentDraft.apiKey"
                type="password"
                autocomplete="off"
                autocapitalize="off"
                :spellcheck="false"
                :placeholder="t('llm.apiKeyPlaceholder')"
                class="w-full"
                :disabled="!mounted || saving"
              />
            </UFormField>
            <UFormField :label="t('llm.baseURL')" name="baseURL" :description="t('llm.baseURLDescription')" :error="errorField === 'baseURL' ? error : undefined">
              <UInput
                id="llm-base-url"
                v-model="currentDraft.baseURL"
                :placeholder="current.baseURL"
                type="url"
                autocomplete="off"
                class="w-full"
                :disabled="!mounted || saving"
              />
            </UFormField>
            <fieldset class="space-y-2">
              <legend class="text-sm font-medium text-highlighted">
                {{ t('llm.headers') }}
              </legend>
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
                  :disabled="!mounted || saving"
                />
                <UInput
                  v-model="row.value"
                  :type="revealedHeaders[row.id] ? 'text' : 'password'"
                  :aria-label="t('llm.headerValue', { index: index + 1 })"
                  :placeholder="t('common.value')"
                  autocomplete="off"
                  autocapitalize="off"
                  :spellcheck="false"
                  class="min-w-0 flex-1"
                  :disabled="!mounted || saving"
                />
                <UButton
                  type="button"
                  :icon="revealedHeaders[row.id] ? 'i-lucide-eye-off' : 'i-lucide-eye'"
                  :aria-label="t(revealedHeaders[row.id] ? 'llm.hideHeaderValue' : 'llm.showHeaderValue', { index: index + 1 })"
                  :aria-pressed="!!revealedHeaders[row.id]"
                  color="neutral"
                  variant="ghost"
                  :disabled="!mounted || saving"
                  @click="revealedHeaders[row.id] = !revealedHeaders[row.id]"
                />
                <UButton
                  type="button"
                  icon="i-lucide-trash-2"
                  :aria-label="t('llm.removeHeader', { index: index + 1 })"
                  color="neutral"
                  variant="ghost"
                  :disabled="!mounted || saving"
                  @click="currentHeaders.splice(index, 1)"
                />
              </div>
              <UButton
                type="button"
                :label="t('llm.addHeader')"
                icon="i-lucide-plus"
                color="neutral"
                variant="outline"
                :disabled="!mounted || saving"
                @click="addHeader"
              />
            </fieldset>
            <UAlert
              :icon="secureSettings ? 'i-lucide-shield-check' : 'i-lucide-shield-alert'"
              color="neutral"
              variant="subtle"
              :title="secureSettings ? t('llm.protectedOS') : t('llm.browserWarning')"
              :description="secureSettings ? t('llm.storageOS') : t('llm.storageBrowser')"
            />
            <div class="flex flex-wrap items-center justify-between gap-3 w-full">
              <p v-if="error && !errorField" role="alert" class="w-full text-sm text-error">
                {{ error }}
              </p>
              <UButton
                type="button"
                :label="t('llm.forget')"
                color="error"
                variant="ghost"
                class="max-w-full"
                :ui="{ label: 'whitespace-normal overflow-visible' }"
                :disabled="
                  saving
                    || (!provider.includes('@')
                      && !saved[provider]?.name
                      && !saved[provider]?.apiKey
                      && !saved[provider]?.baseURL
                      && !Object.keys(saved[provider]?.headers ?? {}).length)
                "
                @click="save(true)"
              />
              <UButton
                :label="secureSettings ? t('llm.saveOS') : t('llm.saveBrowser')"
                type="submit"
                class="max-w-full"
                :ui="{ label: 'whitespace-normal overflow-visible' }"
                :loading="saving"
              />
            </div>
          </form>
        </li>
      </ul>
      <UButton
        type="button"
        icon="i-lucide-plus"
        :label="t('llm.addProvider')"
        :disabled="!mounted || saving"
        @click="adding = true"
      />
    </div>
    <UModal v-model:open="adding" :title="t('llm.addProvider')">
      <template #body>
        <form class="space-y-4" @submit.prevent="addProvider">
          <UFormField :label="t('llm.providerType')">
            <USelect
              v-model="newType"
              :items="[...LLM_PROVIDERS]"
              value-key="id"
              label-key="label"
              class="w-full"
            />
          </UFormField>
          <UFormField :label="t('llm.providerName')">
            <UInput
              v-model="newName"
              :maxlength="100"
              :placeholder="LLM_PROVIDERS.find(item => item.id === newType)?.label"
              class="w-full"
            />
          </UFormField>
          <div class="flex justify-end gap-2">
            <UButton
              type="button"
              :label="t('common.cancel')"
              color="neutral"
              variant="ghost"
              @click="adding = false"
            />
            <UButton type="submit" :label="t('llm.configureProvider')" />
          </div>
        </form>
      </template>
    </UModal>
  </section>
</template>
