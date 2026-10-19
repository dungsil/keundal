<script setup lang="ts">
import { LLM_PROVIDERS, defaultLLMSettings, providerSettingsSchema, type LLMProvider } from '#shared/utils/llm-settings'

defineProps<{ collapsed?: boolean }>()

const { settings, open, requestedProvider } = useLLMSettings()
const { model } = useModels()
const { $chatStore } = useNuxtApp()
const toast = useToast()
const provider = ref<LLMProvider>('anthropic')
const draft = ref(defaultLLMSettings())
const headerText = ref({ anthropic: '', google: '', openai: '' })
const error = ref('')
const saving = ref(false)
const current = computed(() => LLM_PROVIDERS.find(item => item.id === provider.value)!)

watch(open, (value) => {
  error.value = ''
  if (value) {
    draft.value = JSON.parse(JSON.stringify(settings.value))
    for (const item of LLM_PROVIDERS) headerText.value[item.id] = Object.keys(draft.value[item.id].headers ?? {}).length ? JSON.stringify(draft.value[item.id].headers, null, 2) : ''
    provider.value = requestedProvider.value ?? LLM_PROVIDERS.find(item => model.value.startsWith(`${item.id}/`))?.id ?? 'anthropic'
    requestedProvider.value = null
  } else {
    // Do not retain an extra copy of credentials after closing the form.
    draft.value = defaultLLMSettings()
    headerText.value = { anthropic: '', google: '', openai: '' }
  }
})

async function save(forget = false) {
  error.value = ''
  const next = JSON.parse(JSON.stringify(settings.value))
  if (forget) next[provider.value] = { apiKey: '', baseURL: '' }
  else {
    for (const item of LLM_PROVIDERS) {
      try {
        draft.value[item.id].headers = JSON.parse(headerText.value[item.id] || '{}')
      } catch {
        provider.value = item.id
        error.value = 'Request headers must be a JSON object with string values.'
        return
      }
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
    localStorage.setItem('keundal:llm-settings', JSON.stringify(next))
    settings.value = next
    toast.add({ title: forget ? 'Provider settings removed' : 'Settings saved in this browser', icon: 'i-lucide-check', color: 'success' })
    open.value = false
  } catch {
    error.value = 'Could not save settings. Check that browser storage is available.'
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <UModal
    v-model:open="open"
    title="LLM settings"
    description="Your keys stay in this browser. Requests go directly to the provider."
    :dismissible="!saving"
    :close="!saving"
  >
    <UButton
      :label="collapsed ? '' : 'LLM settings'"
      icon="i-lucide-settings-2"
      color="neutral"
      variant="ghost"
      class="w-full"
      aria-label="LLM settings"
    />

    <template #body>
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
        <UFormField label="API base URL (optional)" name="baseURL" description="Leave empty for the official endpoint. A custom endpoint receives your key and must support browser CORS.">
          <UInput
            v-model="draft[provider].baseURL"
            :placeholder="current.baseURL"
            type="url"
            autocomplete="off"
            class="w-full"
            :disabled="saving"
          />
        </UFormField>
        <UFormField label="Request headers (JSON, optional)" name="headers" description="Custom headers override provider defaults for HTTP requests, including model discovery. Your endpoint must allow them via CORS; browser-forbidden headers cannot be set. WebSocket connections cannot use custom headers.">
          <UTextarea
            v-model="headerText[provider]"
            :placeholder="'{\n  &quot;X-API-Version&quot;: &quot;2026-10-01&quot;\n}'"
            autocomplete="off"
            autocapitalize="off"
            :spellcheck="false"
            :rows="3"
            class="w-full font-mono"
            :disabled="saving"
          />
        </UFormField>
        <UAlert
          icon="i-lucide-shield-alert"
          color="neutral"
          variant="subtle"
          title="Browser storage is not a secure vault"
          description="Keys and headers are stored unencrypted in localStorage. Scripts on this site and browser extensions may read them. Do not use a shared browser. Settings are not synced to your account."
        />
      </form>
    </template>

    <template #footer>
      <div class="flex flex-wrap items-center justify-between gap-3 w-full">
        <p v-if="error" role="alert" class="w-full text-sm text-error">
          {{ error }}
        </p>
        <UButton
          label="Forget provider"
          color="error"
          variant="ghost"
          :disabled="saving || (!settings[provider]?.apiKey && !settings[provider]?.baseURL && !Object.keys(settings[provider]?.headers ?? {}).length)"
          @click="save(true)"
        />
        <div class="flex gap-2">
          <UButton
            label="Cancel"
            color="neutral"
            variant="ghost"
            :disabled="saving"
            @click="open = false"
          />
          <UButton
            label="Save in this browser"
            type="submit"
            form="llm-settings"
            :loading="saving"
          />
        </div>
      </div>
    </template>
  </UModal>
</template>
