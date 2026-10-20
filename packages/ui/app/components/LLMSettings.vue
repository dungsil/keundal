<script setup lang="ts">
import { LLM_PROVIDERS, defaultLLMSettings, providerSettingsSchema, type LLMProvider } from '#shared/utils/llm-settings'

defineProps<{ returnTo: string }>()

const { settings } = useLLMSettings()
const route = useRoute()
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

function loadDraft() {
  draft.value = JSON.parse(JSON.stringify(settings.value))
  for (const item of LLM_PROVIDERS)
    headerRows.value[item.id] = Object.entries(draft.value[item.id].headers ?? {}).map(([key, value]) => ({
      id: crypto.randomUUID(),
      key,
      value
    }))
}

onMounted(loadDraft)
watch(
  [() => route.query.provider, model],
  ([value]) => {
    provider.value =
      LLM_PROVIDERS.find((item) => item.id === value)?.id ??
      LLM_PROVIDERS.find((item) => model.value.startsWith(`${item.id}/`))?.id ??
      'anthropic'
  },
  { immediate: true }
)

onBeforeRouteLeave(() => !saving.value)

async function addHeader() {
  const id = crypto.randomUUID()
  headerRows.value[provider.value].push({ id, key: '', value: '' })
  await nextTick()
  document.getElementById(id)?.focus()
}

async function save(forget = false) {
  if (saving.value) return
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
        error.value = 'Enter a key for every request header value.'
        return
      }
      if (new Set(rows.map((row) => row.key.toLowerCase())).size !== rows.length) {
        provider.value = item.id
        error.value = 'Duplicate request header names'
        return
      }
      draft.value[item.id].headers = Object.fromEntries(rows.map((row) => [row.key, row.value]))
      const parsed = providerSettingsSchema.safeParse(draft.value[item.id])
      if (!parsed.success) {
        provider.value = item.id
        error.value = parsed.error.issues[0]!.message
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
      title: forget
        ? 'Provider settings removed'
        : desktop
          ? 'Settings saved in OS secret store'
          : 'Settings saved in this browser',
      icon: 'i-lucide-check',
      color: 'success'
    })
    loadDraft()
  } catch {
    error.value = desktop
      ? 'Could not save settings. Unlock your OS secret store and check its availability and size limits. No browser storage fallback is used.'
      : 'Could not save settings. Check that browser storage is available.'
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
        {{
          desktop
            ? 'Your settings are saved in your OS secret store. Requests go directly to the provider.'
            : 'Your keys stay in this browser. Requests go directly to the provider.'
        }}
      </p>
    </div>
    <form id="llm-settings" class="flex flex-col gap-5" @submit.prevent="save()">
      <UFormField label="Provider" name="provider">
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
        Models are loaded automatically from this provider after saving. Choose the active model in the chat composer.
      </p>
      <UFormField label="API key" name="apiKey">
        <UInput
          v-model="draft[provider].apiKey"
          type="password"
          autocomplete="off"
          autocapitalize="off"
          :spellcheck="false"
          placeholder="Enter your API key"
          class="w-full"
          :disabled="saving"
        />
      </UFormField>
      <UFormField
        label="API base URL (optional)"
        name="baseURL"
        description="Leave empty for the official endpoint. A custom endpoint receives your key and must support browser CORS."
      >
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
        <legend class="text-sm font-medium text-highlighted">Request headers (optional)</legend>
        <p class="text-sm text-muted">
          Custom headers override provider defaults for HTTP requests, including model discovery. Your endpoint must
          allow them via CORS; browser-forbidden headers cannot be set. WebSocket connections cannot use custom headers.
        </p>
        <div v-for="(row, index) in headerRows[provider]" :key="row.id" class="flex items-start gap-2">
          <UInput
            :id="row.id"
            v-model="row.key"
            :aria-label="`Header ${index + 1} key`"
            placeholder="Key"
            autocomplete="off"
            autocapitalize="off"
            :spellcheck="false"
            class="min-w-0 flex-1"
            :disabled="saving"
          />
          <UInput
            v-model="row.value"
            :aria-label="`Header ${index + 1} value`"
            placeholder="Value"
            autocomplete="off"
            autocapitalize="off"
            :spellcheck="false"
            class="min-w-0 flex-1"
            :disabled="saving"
          />
          <UButton
            type="button"
            icon="i-lucide-trash-2"
            :aria-label="`Remove header ${index + 1}`"
            color="neutral"
            variant="ghost"
            :disabled="saving"
            @click="headerRows[provider].splice(index, 1)"
          />
        </div>
        <UButton
          type="button"
          label="Add header"
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
        :title="desktop ? 'Protected by your OS secret store' : 'Browser storage is not a secure vault'"
        :description="
          desktop
            ? 'API keys, URLs and headers are saved in macOS Keychain, Windows Credential Manager or Linux Secret Service, not localStorage. Settings are available in app memory while in use and are not synced to your account.'
            : 'Keys and headers are stored unencrypted in localStorage. Scripts on this site and browser extensions may read them. Do not use a shared browser. Settings are not synced to your account.'
        "
      />
    </form>
    <div class="flex flex-wrap items-center justify-between gap-3 w-full">
      <p v-if="error" role="alert" class="w-full text-sm text-error">
        {{ error }}
      </p>
      <UButton
        label="Forget provider"
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
        <UButton label="취소" :to="returnTo" color="neutral" variant="ghost" :disabled="saving" />
        <UButton
          :label="desktop ? 'Save in OS secret store' : 'Save in this browser'"
          type="submit"
          form="llm-settings"
          :loading="saving"
        />
      </div>
    </div>
  </section>
</template>
