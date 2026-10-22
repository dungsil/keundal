<script setup lang="ts">
import { useMounted } from '@vueuse/core'
import type { McpClientConfig } from '@keundal/mcp'

const { t } = useLocale()
const { $mcpManager, $saveMcpSettings, $remoteAgent } = useNuxtApp()
const mounted = useMounted()
const desktop = useRuntimeConfig().public.chatCapabilities.secureSettings
const hosted = computed(() => mounted.value && Boolean($remoteAgent) && !desktop)
const servers = ref<McpClientConfig[]>([])
onMounted(() => {
  servers.value = $mcpManager.configuration
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

function reset() {
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
const scope = (value: string) => value.trim() === '*' ? '*' as const : value.split('\n').map(item => item.trim()).filter(Boolean)
async function apply(next: unknown) {
  saving.value = true
  error.value = ''
  success.value = false
  try {
    await $saveMcpSettings(next)
    servers.value = $mcpManager.configuration
    success.value = true
    reset()
  } catch {
    error.value = t('mcp.saveFailed')
  } finally {
    saving.value = false
  }
}
async function save() {
  try {
    const server = {
      serverName: name.value.trim(), transport: transport.value, timeoutMs: timeoutMs.value,
      permissions: { tools: scope(tools.value), resources: scope(resources.value) },
      ...(transport.value === 'stdio'
        ? { command: address.value, args: JSON.parse(args.value), env: JSON.parse(credentials.value), ...(cwd.value ? { cwd: cwd.value } : {}) }
        : { url: address.value, headers: JSON.parse(credentials.value), ...(allowInsecureHttp.value ? { allowInsecureHttp: true } : {}) })
    }
    const next = [...servers.value]
    if (editing.value === null) next.push(server as McpClientConfig)
    else next[editing.value] = server as McpClientConfig
    await apply(next)
  } catch {
    error.value = t('mcp.invalidJSON')
  }
}
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
        <li v-for="(server, index) in servers" :key="server.serverName" class="flex items-center gap-2">
          <span class="grow">{{ server.serverName }} <span class="text-sm text-muted">{{ server.transport }}</span></span>
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
