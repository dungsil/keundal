<script setup lang="ts">
import { useMounted } from '@vueuse/core'
import {
  LLM_PROVIDERS,
  defaultLLMSettings,
  configuredProviders,
  registeredProviders,
  providerSettingsSchema,
  type LLMProvider
} from '@keundal/chat/llm-settings'

const { t } = useLocale()

const { settings } = useLLMSettings()
const mounted = useMounted()
const route = useRoute()
const { model } = useModels()
const { $chatStore, $saveLLMSettings } = useNuxtApp()
const secureSettings = useRuntimeConfig().public.chatCapabilities.secureSettings
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
  openai: []
})
const error = ref('')
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
  draft.value = JSON.parse(JSON.stringify(settings.value))
  visibleIds.value = registeredProviders(settings.value).map(item => item.id)
  for (const item of configuredProviders(draft.value))
    headerRows.value[item.id] = Object.entries(draft.value[item.id]!.headers ?? {}).map(([key, value]) => ({
      id: crypto.randomUUID(),
      key,
      value
    }))
}

onMounted(loadDraft)
watch(
  [() => route.query.provider, model, mounted],
  ([value, , ready]) => {
    if (!ready) return
    provider.value
      = registeredProviders(settings.value).find(item => item.id === value)?.id
        ?? registeredProviders(settings.value).find(item => model.value.startsWith(`${item.id}/`))?.id
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
  const next = JSON.parse(JSON.stringify(settings.value))
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
        return
      }
      if (new Set(rows.map(row => row.key.toLowerCase())).size !== rows.length) {
        provider.value = item.id
        error.value = t('llm.duplicateHeaders')
        return
      }
      draft.value[item.id]!.headers = Object.fromEntries(rows.map(row => [row.key, row.value]))
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
  <section class="space-y-6" aria-labelledby="llm-settings-title">
    <div class="space-y-2">
      <h2 id="llm-settings-title" class="text-lg font-semibold text-highlighted">
        LLM
      </h2>
      <p class="text-sm text-muted">
        {{ secureSettings ? t('llm.descriptionOS') : t('llm.descriptionBrowser') }}
      </p>
    </div>
    <div class="space-y-3">
      <p v-if="!providers.length" class="text-sm text-muted">
        {{ t('llm.noProviders') }}
      </p>
      <ul v-else class="space-y-2" :aria-label="t('llm.registeredProviders')">
        <li v-for="item in providers" :key="item.id">
          <button
            type="button"
            class="flex w-full items-center justify-between rounded-lg border p-4 text-left"
            :class="provider === item.id ? 'border-primary bg-primary/5' : 'border-default'"
            :aria-expanded="provider === item.id"
            :disabled="!mounted || saving"
            @click="provider = provider === item.id ? '' : item.id"
          >
            <span>
              <span class="block font-medium text-highlighted">{{ item.label }}</span>
              <span class="block text-sm text-muted">{{ LLM_PROVIDERS.find(preset => preset.id === item.providerType)?.label }}</span>
            </span>
            <UIcon name="i-lucide-chevron-down" :class="provider === item.id ? 'rotate-180' : ''" />
          </button>
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
    <form
      v-if="current"
      id="llm-settings"
      class="flex flex-col gap-5"
      @submit.prevent="save()"
    >
      <h3 class="font-semibold text-highlighted">
        {{ current.label }}
      </h3>
      <UFormField :label="t('llm.providerName')" name="providerName">
        <UInput
          v-model="currentDraft.name"
          :placeholder="current.label"
          :maxlength="100"
          :disabled="!mounted || saving"
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
          :disabled="!mounted || saving"
        />
      </UFormField>
      <UFormField :label="t('llm.baseURL')" name="baseURL" :description="t('llm.baseURLDescription')">
        <UInput
          v-model="currentDraft.baseURL"
          :placeholder="current.baseURL"
          type="url"
          autocomplete="off"
          class="w-full"
          :disabled="!mounted || saving"
        />
      </UFormField>
      <fieldset class="space-y-3">
        <legend class="text-sm font-medium text-highlighted">
          {{ t('llm.headers') }}
        </legend>
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
            :disabled="!mounted || saving"
          />
          <UInput
            v-model="row.value"
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
    </form>
    <div class="flex flex-wrap items-center justify-between gap-3 w-full">
      <p v-if="error" role="alert" class="w-full text-sm text-error">
        {{ error }}
      </p>
      <UButton
        v-if="current"
        :label="t('llm.forget')"
        color="error"
        variant="ghost"
        :disabled="
          saving
            || (!provider.includes('@')
              && !settings[provider]?.name
              && !settings[provider]?.apiKey
              && !settings[provider]?.baseURL
              && !Object.keys(settings[provider]?.headers ?? {}).length)
        "
        @click="save(true)"
      />
      <UButton
        v-if="current"
        :label="secureSettings ? t('llm.saveOS') : t('llm.saveBrowser')"
        type="submit"
        form="llm-settings"
        :loading="saving"
      />
    </div>
  </section>
</template>
