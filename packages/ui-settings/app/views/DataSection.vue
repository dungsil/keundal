<script setup lang="ts">
import { MAX_BACKUP_BYTES, openDataBackup, serializeDataBackup, type BackupPreferences, type DataBackup } from '@keundal/chat'
import { computed, nextTick, ref, shallowRef, watch } from 'vue'

import { useText } from '../locale'

const props = defineProps<{
  exportBackup: (appearance: Pick<BackupPreferences, 'locale' | 'colorMode'>) => Promise<DataBackup>
  restoreBackup: (value: unknown) => Promise<string[]>
}>()
const { t, locale, intlLocale, setLocale } = useText()
const colorMode = useColorMode()
const busy = ref<'export' | 'read' | 'restore'>()
const preview = shallowRef<DataBackup>()
const encrypt = ref(false)
const exportPassword = ref('')
const passwordConfirmation = ref('')
const restorePassword = ref('')
const encryptedFile = ref('')
const passwordInput = ref<HTMLInputElement>()
const confirmed = ref(false)
const error = ref('')
const status = ref('')
const restored = ref(false)
const skipped = ref<string[]>([])
const fileInput = ref<HTMLInputElement>()
const previewTitle = ref<HTMLHeadingElement>()
const errorPanel = ref<HTMLDivElement>()
const createdAt = computed(() => preview.value
  ? new Intl.DateTimeFormat(intlLocale.value, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(preview.value.createdAt))
  : '')

watch(error, async value => {
  if (!value) return
  await nextTick()
  errorPanel.value?.focus({ preventScroll: true })
  errorPanel.value?.scrollIntoView({ block: 'nearest', behavior: 'instant' })
})

async function download() {
  if (encrypt.value && (!exportPassword.value || exportPassword.value !== passwordConfirmation.value)) return
  busy.value = 'export'
  error.value = status.value = ''
  try {
    const backup = await props.exportBackup({
      locale: locale.value,
      colorMode: colorMode.preference === 'light' || colorMode.preference === 'dark' ? colorMode.preference : 'system'
    })
    const text = await serializeDataBackup(backup, encrypt.value ? exportPassword.value : undefined)
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `keundal-backup-${backup.createdAt.replace(/[:.]/g, '-')}.json`
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    exportPassword.value = passwordConfirmation.value = ''
    status.value = t('data.downloaded')
  } catch {
    error.value = t('data.exportFailed')
  } finally {
    busy.value = undefined
  }
}

async function selectFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  busy.value = 'read'
  error.value = status.value = ''
  preview.value = undefined
  encryptedFile.value = restorePassword.value = ''
  confirmed.value = false
  try {
    if (file.size > MAX_BACKUP_BYTES) throw new Error('File too large')
    const text = await file.text()
    if (JSON.parse(text)?.format === 'keundal-backup-encrypted') {
      encryptedFile.value = text
      return
    }
    preview.value = await openDataBackup(text)
    await nextTick()
    previewTitle.value?.focus({ preventScroll: true })
    previewTitle.value?.scrollIntoView({ block: 'start', behavior: 'instant' })
  } catch {
    error.value = t('data.invalid')
  } finally {
    input.value = ''
    busy.value = undefined
    if (encryptedFile.value) {
      await nextTick()
      passwordInput.value?.focus()
    }
  }
}

async function unlock() {
  if (!encryptedFile.value || !restorePassword.value || busy.value) return
  busy.value = 'read'
  error.value = status.value = ''
  try {
    preview.value = await openDataBackup(encryptedFile.value, restorePassword.value)
    encryptedFile.value = ''
    await nextTick()
    previewTitle.value?.focus({ preventScroll: true })
    previewTitle.value?.scrollIntoView({ block: 'start', behavior: 'instant' })
  } catch {
    error.value = t('data.unlockFailed')
  } finally {
    restorePassword.value = ''
    busy.value = undefined
  }
}

watch(encrypt, () => { exportPassword.value = passwordConfirmation.value = '' })

async function restore() {
  if (!preview.value || !confirmed.value || busy.value) return
  busy.value = 'restore'
  error.value = status.value = ''
  try {
    skipped.value = await props.restoreBackup(preview.value)
    setLocale(preview.value.settings.preferences.locale)
    colorMode.preference = preview.value.settings.preferences.colorMode
    restored.value = true
    preview.value = undefined
    status.value = t('data.success')
  } catch (failure) {
    const message = failure instanceof Error ? failure.message : ''
    error.value = t(message.includes('rollback was incomplete') ? 'data.rollbackFailed'
      : /already|collision/.test(message) ? 'data.collision' : 'data.restoreFailed')
  } finally {
    busy.value = undefined
  }
}

function cancel() {
  preview.value = undefined
  encryptedFile.value = restorePassword.value = ''
  confirmed.value = false
  error.value = ''
  fileInput.value?.focus()
}

function reload() { window.location.reload() }
</script>

<template>
  <section class="mb-8 space-y-6" aria-labelledby="data-settings-title" :aria-busy="!!busy">
    <h2 id="data-settings-title" class="text-lg font-semibold text-highlighted">{{ t('data.title') }}</h2>
    <UAlert color="warning" variant="subtle" icon="i-lucide-shield-alert" :description="t('data.security')" />
    <div v-if="!restored" class="space-y-6">
      <div class="space-y-3">
        <p class="text-sm text-muted">{{ t('data.exportDescription') }}</p>
        <UCheckbox v-model="encrypt" :disabled="!!busy" :label="t('data.encrypt')" />
        <div v-if="encrypt" class="space-y-3">
          <p id="backup-password-help" class="text-sm text-muted">{{ t('data.passwordHelp') }}</p>
          <div>
            <label for="backup-password" class="mb-2 block text-sm font-medium text-highlighted">{{ t('data.password') }}</label>
            <UInput id="backup-password" v-model="exportPassword" type="password" autocomplete="new-password" aria-describedby="backup-password-help" :disabled="!!busy" class="w-full" />
          </div>
          <div>
            <label for="backup-password-confirm" class="mb-2 block text-sm font-medium text-highlighted">{{ t('data.passwordConfirm') }}</label>
            <UInput id="backup-password-confirm" v-model="passwordConfirmation" type="password" autocomplete="new-password" :disabled="!!busy" class="w-full" />
          </div>
          <p v-if="passwordConfirmation && exportPassword !== passwordConfirmation" role="status" class="text-sm text-error">{{ t('data.passwordMismatch') }}</p>
        </div>
        <UButton :label="t('data.export')" icon="i-lucide-download" :loading="busy === 'export'" :disabled="!!busy || (encrypt && (!exportPassword || exportPassword !== passwordConfirmation))" @click="download" />
      </div>
      <div class="space-y-4 border-t border-default pt-6">
        <h3 class="font-medium text-highlighted">{{ t('data.restore') }}</h3>
        <p class="text-sm text-muted">{{ t('data.policy') }}</p>
        <div>
          <label for="backup-file" class="mb-2 block text-sm font-medium text-highlighted">{{ t('data.file') }}</label>
          <input id="backup-file" ref="fileInput" type="file" accept=".json,application/json" :disabled="!!busy"
            class="block w-full min-w-0 rounded-md border border-default p-2 text-sm text-muted file:mr-3 file:rounded file:border-0 file:bg-elevated file:px-3 file:py-1 file:text-default focus-visible:outline-2 focus-visible:outline-primary"
            @change="selectFile">
        </div>
        <form v-if="encryptedFile" class="space-y-3 rounded-lg border border-default p-4" @submit.prevent="unlock">
          <label for="restore-password" class="block text-sm font-medium text-highlighted">{{ t('data.restorePassword') }}</label>
          <input id="restore-password" ref="passwordInput" v-model="restorePassword" type="password" autocomplete="off" :disabled="!!busy"
            class="block w-full rounded-md border border-default bg-default px-3 py-2 text-sm text-default focus-visible:outline-2 focus-visible:outline-primary">
          <div class="flex flex-wrap gap-2">
            <UButton type="submit" :label="t('data.unlock')" :loading="busy === 'read'" :disabled="!!busy || !restorePassword" />
            <UButton :label="t('data.cancel')" color="neutral" variant="outline" :disabled="!!busy" @click="cancel" />
          </div>
        </form>
        <div v-if="preview" class="space-y-4 rounded-lg border border-default p-4">
          <h4 ref="previewTitle" tabindex="-1" class="scroll-mt-24 font-medium text-highlighted">{{ t('data.preview') }}</h4>
          <dl class="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <dt class="text-muted">{{ t('data.created') }}</dt><dd class="break-words text-right text-default">{{ createdAt }}</dd>
            <dt class="text-muted">{{ t('data.conversations') }}</dt><dd class="text-right tabular-nums">{{ preview.history.threads.length }}</dd>
            <dt class="text-muted">{{ t('data.runs') }}</dt><dd class="text-right tabular-nums">{{ preview.history.runs.length }}</dd>
            <dt class="text-muted">{{ t('data.presets') }}</dt><dd class="text-right tabular-nums">{{ preview.settings.promptPresets.presets.length }}</dd>
            <dt class="text-muted">{{ t('data.skills') }}</dt><dd class="text-right tabular-nums">{{ preview.settings.skills.skills.length }}</dd>
          </dl>
          <UCheckbox v-model="confirmed" :disabled="!!busy" :label="t('data.confirm')" />
          <div class="flex flex-wrap gap-2">
            <UButton :label="t('data.restore')" icon="i-lucide-upload" :loading="busy === 'restore'" :disabled="!confirmed || !!busy" @click="restore" />
            <UButton :label="t('data.cancel')" color="neutral" variant="outline" :disabled="!!busy" @click="cancel" />
          </div>
        </div>
      </div>
    </div>
    <div v-if="error" ref="errorPanel" tabindex="-1" class="scroll-mt-24 rounded-md focus-visible:outline-2 focus-visible:outline-primary">
      <UAlert role="alert" color="error" variant="subtle" icon="i-lucide-circle-alert" :description="error" />
    </div>
    <div role="status" aria-live="polite" class="space-y-3">
      <UAlert v-if="status" color="success" variant="subtle" icon="i-lucide-check" :title="status" :description="restored ? t('data.reloadDescription') : undefined" />
      <p v-if="restored && skipped.length" class="break-words text-sm text-muted">{{ t('data.skipped', { modules: skipped.join(', ') }) }}</p>
    </div>
    <UButton v-if="restored" :label="t('data.reload')" icon="i-lucide-refresh-cw" @click="reload" />
  </section>
</template>
