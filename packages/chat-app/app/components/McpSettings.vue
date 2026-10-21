<script setup lang="ts">
import type { McpClientConfig } from '@keundal/mcp/browser'

const { t } = useLocale()
const { $mcpManager, $saveMcpSettings, $remoteAgent } = useNuxtApp()
const desktop = useRuntimeConfig().public.desktop
const hosted = $remoteAgent && !desktop
const servers = ref($mcpManager.configuration)
const editing = ref<number | null>(null)
const name = ref('')
const transport = ref('streamable-http')
const address = ref('')
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
        : { url: address.value, headers: JSON.parse(credentials.value) })
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
            color="neutral"
            variant="soft"
            :disabled="saving"
            @click="edit(server, index)"
          />
          <UButton
            :label="t('mcp.remove')"
            color="error"
            variant="soft"
            :disabled="saving"
            @click="apply(servers.filter((_, i) => i !== index))"
          />
        </li>
      </ul>
      <form class="space-y-4" @submit.prevent="save">
        <UFormField :label="t('mcp.name')" required>
          <UInput
            v-model="name"
            required
            pattern="[A-Za-z0-9_-]{1,32}"
            class="w-full"
            :disabled="saving"
          />
        </UFormField>
        <UFormField :label="t('mcp.transport')">
          <USelect v-model="transport" :items="transportItems" :disabled="saving" />
        </UFormField>
        <UFormField :label="t(transport === 'stdio' ? 'mcp.command' : 'mcp.url')" required>
          <UInput
            v-model="address"
            required
            class="w-full"
            :disabled="saving"
          />
        </UFormField>
        <template v-if="transport === 'stdio'">
          <UFormField :label="t('mcp.args')">
            <UTextarea v-model="args" class="w-full" :disabled="saving" />
          </UFormField>
          <UFormField :label="t('mcp.cwd')">
            <UInput v-model="cwd" class="w-full" :disabled="saving" />
          </UFormField>
        </template>
        <UFormField :label="t(transport === 'stdio' ? 'mcp.env' : 'mcp.headers')">
          <UTextarea
            v-model="credentials"
            class="w-full"
            :disabled="saving"
            autocomplete="off"
          />
        </UFormField>
        <UFormField :label="t('mcp.tools')" :description="t('mcp.permissions')">
          <UTextarea v-model="tools" class="w-full" :disabled="saving" />
        </UFormField>
        <UFormField :label="t('mcp.resources')" :description="t('mcp.permissions')">
          <UTextarea v-model="resources" class="w-full" :disabled="saving" />
        </UFormField>
        <UFormField :label="t('mcp.timeout')">
          <UInput
            v-model.number="timeoutMs"
            type="number"
            :min="1"
            required
            :disabled="saving"
          />
        </UFormField>
        <UAlert v-if="error" color="error" :title="error" />
        <UAlert v-if="success" color="success" :title="t('mcp.saved')" />
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
