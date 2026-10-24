<script setup lang="ts">
import { useMounted } from '@vueuse/core'
import type { McpClientConfig, McpProbeResult, McpRequestOptions } from '@keundal/mcp'

import { useText } from '../locale'

const props = defineProps<{
  capabilities: { secureSettings: boolean }
  /** The agent runs on a remote host, which owns the MCP configuration. */
  remoteAgent: boolean
  /** The saved servers. */
  configuration: () => McpClientConfig[]
  /** Save the servers and restart the connection's tools. */
  saveSettings: (next: unknown) => Promise<void>
  /** The platform can check an unsaved server. */
  canProbe: () => boolean
  probe: (server: unknown, options?: McpRequestOptions) => Promise<McpProbeResult>
}>()

const { t } = useText()
const mounted = useMounted()
const desktop = props.capabilities.secureSettings
const hosted = computed(() => mounted.value && props.remoteAgent && !desktop)
const servers = ref<McpClientConfig[]>([])
onMounted(() => {
  servers.value = props.configuration()
})
const editing = ref<number | null>(null)
const name = ref('')
const transport = ref('streamable-http')
const address = ref('')
const allowInsecureHttp = ref(false)
const args = ref('[]')
const credentials = ref('{}')
const tools = ref('')
const resources = ref('')
const cwd = ref('')
const error = ref('')
const saving = ref(false)
const success = ref(false)
const timeoutMs = ref<number>(60000)
const transportItems = computed(() => desktop ? ['streamable-http', 'stdio'] : ['streamable-http'])

const checking = ref(false)
const checkResult = ref<McpProbeResult | null>(null)
const checkError = ref('')
const checkDetail = ref('')
let checkAbort: AbortController | undefined
const cancelButton = useTemplateRef<{ $el: HTMLElement }>('cancelButton')
// The platform exists only in the browser, so the button stays disabled until the component is mounted.
const canCheck = computed(() => mounted.value && props.canProbe() && transport.value !== 'stdio')

function cancelCheck() {
  checkAbort?.abort()
  checkAbort = undefined
  checking.value = false
}
function clearCheck() {
  cancelCheck()
  checkResult.value = null
  checkError.value = ''
  checkDetail.value = ''
}
function reset() {
  clearCheck()
  editing.value = null
  name.value = ''
  address.value = ''
  allowInsecureHttp.value = false
  args.value = '[]'
  credentials.value = '{}'
  tools.value = ''
  resources.value = ''
  cwd.value = ''
  timeoutMs.value = 60000
}
function edit(server: McpClientConfig, index: number) {
  clearCheck()
  editing.value = index
  name.value = server.serverName
  transport.value = server.transport
  allowInsecureHttp.value = server.transport === 'streamable-http' && server.allowInsecureHttp === true
  address.value = server.transport === 'stdio' ? server.command : server.url
  args.value = JSON.stringify(server.transport === 'stdio' ? server.args ?? [] : [])
  credentials.value = JSON.stringify(server.transport === 'stdio' ? server.env ?? {} : server.headers ?? {})
  tools.value = server.permissions?.tools === '*' ? '*' : server.permissions?.tools?.join('\n') ?? ''
  resources.value = server.permissions?.resources === '*' ? '*' : server.permissions?.resources?.join('\n') ?? ''
  cwd.value = server.transport === 'stdio' ? server.cwd ?? '' : ''
  timeoutMs.value = server.timeoutMs ?? 60000
}
watch(transport, () => {
  credentials.value = '{}'
  allowInsecureHttp.value = false
}, { flush: 'sync' })
// A result describes the connection values it was made with, so any change to them discards it.
watch([transport, address, credentials, allowInsecureHttp, args, cwd, timeoutMs], clearCheck)
onBeforeUnmount(cancelCheck)
const scope = (value: string) => value.trim() === '*' ? '*' as const : value.split('\n').map(item => item.trim()).filter(Boolean)
// Controls disable while a request runs, which drops keyboard focus to the page; give it back when the request ends.
function holdFocus() {
  const origin = document.activeElement
  return async () => {
    await nextTick()
    if (origin instanceof HTMLElement && origin.isConnected && document.activeElement === document.body) origin.focus()
  }
}
async function apply(next: unknown) {
  const restoreFocus = holdFocus()
  saving.value = true
  error.value = ''
  success.value = false
  try {
    await props.saveSettings(next)
    servers.value = props.configuration()
    success.value = true
    reset()
  } catch {
    error.value = t('mcp.saveFailed')
  } finally {
    saving.value = false
    void restoreFocus()
  }
}
function buildServer(serverName: string) {
  return {
    serverName, transport: transport.value, timeoutMs: timeoutMs.value,
    permissions: { tools: scope(tools.value), resources: scope(resources.value) },
    ...(transport.value === 'stdio'
      ? { command: address.value, args: JSON.parse(args.value), env: JSON.parse(credentials.value), ...(cwd.value ? { cwd: cwd.value } : {}) }
      : { url: address.value, headers: JSON.parse(credentials.value), ...(allowInsecureHttp.value ? { allowInsecureHttp: true } : {}) })
  }
}
async function save() {
  try {
    const server = buildServer(name.value.trim())
    const next = [...servers.value]
    if (editing.value === null) next.push(server as McpClientConfig)
    else next[editing.value] = server as McpClientConfig
    await apply(next)
  } catch {
    error.value = t('mcp.invalidJSON')
  }
}
async function check() {
  cancelCheck()
  checkResult.value = null
  checkError.value = ''
  checkDetail.value = ''
  let server: unknown
  try {
    server = buildServer(name.value.trim() || 'check')
  } catch {
    checkError.value = t('mcp.invalidJSON')
    return
  }
  const restoreFocus = holdFocus()
  const controller = new AbortController()
  checkAbort = controller
  checking.value = true
  // The check button disables while it runs, so Cancel check is the control that still applies.
  void nextTick().then(() => cancelButton.value?.$el.focus())
  try {
    const result = await props.probe(server, { signal: controller.signal })
    if (!controller.signal.aborted) checkResult.value = result
  } catch (cause) {
    if (controller.signal.aborted) return
    if (cause instanceof DOMException && cause.name === 'TimeoutError') {
      checkError.value = t('mcp.checkTimeout', { ms: timeoutMs.value })
    } else {
      checkError.value = t('mcp.checkFailed')
      checkDetail.value = cause instanceof Error ? cause.message.slice(0, 200) : ''
    }
  } finally {
    if (checkAbort === controller) cancelCheck()
    void restoreFocus()
  }
}
const allowedTools = computed(() => scope(tools.value))
const isAllowed = (toolName: string) => allowedTools.value === '*' || allowedTools.value.includes(toolName)
function toggleTool(toolName: string, on: boolean) {
  const current = allowedTools.value
  const names = current === '*' ? (checkResult.value?.tools ?? []).map(tool => tool.name) : [...current]
  const next = on ? (names.includes(toolName) ? names : [...names, toolName]) : names.filter(item => item !== toolName)
  tools.value = next.join('\n')
}
const unknownAllowed = computed(() => {
  const current = allowedTools.value
  if (current === '*' || !checkResult.value) return []
  const known = new Set(checkResult.value.tools.map(tool => tool.name))
  return current.filter(item => !known.has(item))
})
</script>

<template>
  <section class="mb-8 space-y-4" aria-labelledby="mcp-settings-title">
    <h2 id="mcp-settings-title" class="text-lg font-semibold text-highlighted">
      MCP
    </h2>
    <p class="text-sm text-muted">
      {{ t(hosted ? 'mcp.hosted' : desktop ? 'mcp.desktopDescription' : 'mcp.webDescription') }}
    </p>
    <template v-if="!hosted">
      <ul class="space-y-2">
        <li v-for="(server, index) in servers" :key="server.serverName" class="flex flex-wrap items-center gap-2">
          <span class="min-w-0 grow [overflow-wrap:anywhere]">{{ server.serverName }} <span class="text-sm text-muted">{{ server.transport }}</span></span>
          <UButton
            :label="t('mcp.edit')"
            :aria-label="`${t('mcp.edit')} ${server.serverName}`"
            color="neutral"
            variant="soft"
            :disabled="saving"
            @click="edit(server, index)"
          />
          <UButton
            :label="t('mcp.remove')"
            :aria-label="`${t('mcp.remove')} ${server.serverName}`"
            color="error"
            variant="soft"
            :disabled="saving"
            @click="apply(servers.filter((_, i) => i !== index))"
          />
        </li>
      </ul>
      <form class="space-y-4" @submit.prevent="save">
        <UFormField :label="t('mcp.name')" name="serverName" required>
          <UInput
            v-model="name"
            required
            pattern="[A-Za-z0-9_-]{1,32}"
            class="w-full"
            :disabled="saving"
          />
        </UFormField>
        <UFormField :label="t('mcp.transport')" name="transport">
          <USelect v-model="transport" :items="transportItems" :disabled="saving" />
        </UFormField>
        <UFormField :label="t(transport === 'stdio' ? 'mcp.command' : 'mcp.url')" name="address" required>
          <UInput
            v-model="address"
            required
            class="w-full"
            :disabled="saving"
          />
        </UFormField>
        <UCheckbox
          v-if="transport === 'streamable-http'"
          v-model="allowInsecureHttp"
          :label="t('mcp.allowInsecureHttp')"
          :description="t('mcp.allowInsecureHttpDescription')"
          :disabled="saving"
        />
        <template v-if="transport === 'stdio'">
          <UFormField :label="t('mcp.args')" name="args">
            <UTextarea v-model="args" class="w-full" :disabled="saving" />
          </UFormField>
          <UFormField :label="t('mcp.cwd')" name="cwd">
            <UInput v-model="cwd" class="w-full" :disabled="saving" />
          </UFormField>
        </template>
        <UFormField :label="t(transport === 'stdio' ? 'mcp.env' : 'mcp.headers')" name="credentials">
          <UTextarea
            v-model="credentials"
            class="w-full"
            :disabled="saving"
            autocomplete="off"
          />
        </UFormField>
        <UFormField :label="t('mcp.tools')" name="tools" :description="t('mcp.permissions')">
          <UTextarea v-model="tools" class="w-full" :disabled="saving" />
        </UFormField>
        <UFormField :label="t('mcp.resources')" name="resources" :description="t('mcp.permissions')">
          <UTextarea v-model="resources" class="w-full" :disabled="saving" />
        </UFormField>
        <UFormField :label="t('mcp.timeout')" name="timeoutMs">
          <UInput
            v-model.number="timeoutMs"
            type="number"
            :min="1"
            required
            :disabled="saving"
          />
        </UFormField>
        <div class="space-y-3" aria-live="polite">
          <p class="text-sm text-muted">
            {{ t('mcp.checkDescription') }}
          </p>
          <p v-if="desktop" class="text-sm text-muted">
            {{ t('mcp.checkDesktopLimit') }}
          </p>
          <p v-if="transport === 'stdio'" class="text-sm text-muted">
            {{ t('mcp.checkStdioUnsupported') }}
          </p>
          <div class="flex gap-2">
            <UButton
              :label="t('mcp.check')"
              color="neutral"
              variant="soft"
              :loading="checking"
              :disabled="!canCheck || saving"
              @click="check"
            />
            <UButton
              v-if="checking"
              ref="cancelButton"
              :label="t('mcp.checkCancel')"
              color="neutral"
              variant="ghost"
              @click="cancelCheck"
            />
          </div>
          <UAlert
            v-if="checkError"
            color="warning"
            :title="checkError"
            :description="checkDetail ? t('mcp.checkDetail', { message: checkDetail }) : undefined"
            :ui="{ description: '[overflow-wrap:anywhere]' }"
            role="alert"
          />
          <div v-if="checkResult" class="space-y-2">
            <p class="text-sm text-muted">
              {{ t(checkResult.resources.supported ? 'mcp.checkResources' : 'mcp.checkNoResources', { count: checkResult.resources.count }) }}
            </p>
            <p v-if="!checkResult.tools.length" class="text-sm">
              {{ t('mcp.checkNoTools') }}
            </p>
            <fieldset v-else class="min-w-0 space-y-2">
              <legend class="text-sm font-medium">
                {{ t('mcp.checkTools', { count: checkResult.tools.length }) }}
              </legend>
              <p class="text-sm text-muted">
                {{ t(allowedTools === '*' ? 'mcp.checkAllowAll' : 'mcp.checkPick') }}
              </p>
              <ul class="max-h-64 space-y-2 overflow-y-auto [overflow-wrap:anywhere]">
                <li v-for="tool in checkResult.tools" :key="tool.name">
                  <UCheckbox
                    :model-value="isAllowed(tool.name)"
                    :label="tool.name"
                    :disabled="saving"
                    @update:model-value="toggleTool(tool.name, $event === true)"
                  >
                    <template v-if="tool.description" #description>
                      <span dir="auto" class="block">{{ tool.description.slice(0, 160) }}</span>
                    </template>
                  </UCheckbox>
                </li>
              </ul>
            </fieldset>
            <p v-if="unknownAllowed.length" class="text-sm text-warning">
              {{ t('mcp.checkUnknown', { names: unknownAllowed.join(', ') }) }}
            </p>
          </div>
        </div>
        <UAlert v-if="error" color="error" :title="error" role="alert" />
        <UAlert v-if="success" color="success" :title="t('mcp.saved')" role="status" />
        <div class="flex gap-2">
          <UButton type="submit" :label="t(editing === null ? 'mcp.add' : 'mcp.save')" :loading="saving" />
          <UButton
            v-if="editing !== null"
            :label="t('mcp.cancel')"
            color="neutral"
            :disabled="saving"
            @click="reset"
          />
        </div>
      </form>
    </template>
  </section>
</template>
