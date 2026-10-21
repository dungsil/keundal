import type { invoke } from '@tauri-apps/api/core'
import { RemoteChatStore, type RemoteAgentInfo } from './remote-chat-store'
import { resolveModel, type ModelOption } from './models'

function selection(model: string, models: ModelOption[]) {
  const selected = resolveModel(model)
  const metadata = models.find(item => item.value === selected.value)
  const contextWindow = Math.min(128_000, metadata?.contextWindow ?? 128_000)
  return {
    provider: selected.provider,
    ...(selected.configuration !== selected.provider ? { configuration: selected.configuration } : {}),
    model: selected.id,
    contextWindow,
    maxOutputTokens: Math.min(4096, metadata?.maxOutputTokens ?? 4096, contextWindow - 1)
  }
}

class DesktopChatStore extends RemoteChatStore {
  private pending: Promise<void> = Promise.resolve()
  private needsRecovery = false
  private recovery: Promise<void> | undefined

  constructor(
    connection: RemoteAgentInfo,
    private readonly invokeNative: typeof invoke,
    private readonly getModels: () => ModelOption[],
    private selected: ReturnType<typeof selection>,
    request?: typeof fetch
  ) {
    super(connection, request)
  }

  get selectedModel() {
    return `${this.selected.configuration ?? this.selected.provider}/${this.selected.model}`
  }

  selectModel(model: string, restart = false): Promise<void> {
    return this.change(() => selection(model, this.getModels()), restart)
  }

  private change(getSelection: () => ReturnType<typeof selection>, restart: boolean) {
    const change = this.pending.then(async () => {
      const next = getSelection()
      if (!restart && JSON.stringify(next) === JSON.stringify(this.selected)) return
      await this.recovery?.catch(() => {})
      await this.stop()
      const connection = await this.invokeNative<RemoteAgentInfo>('sidecar_info', { selection: next, restart })
      this.reconnect(connection)
      this.selected = next
      this.needsRecovery = true
    })
    this.pending = change.catch(() => {})
    return change
  }

  reloadSettings() {
    return this.change(() => selection(`${this.selected.configuration ?? this.selected.provider}/${this.selected.model}`, this.getModels()), true)
  }

  override async* respond(...args: Parameters<RemoteChatStore['respond']>) {
    await this.selectModel(args[1].model)
    if (this.needsRecovery) await this.recover()
    yield* super.respond(...args)
  }

  override recover(): Promise<void> {
    this.recovery ??= super.recover().then(() => {
      this.needsRecovery = false
    }).finally(() => {
      this.recovery = undefined
    })
    return this.recovery
  }
}

/** Native IPC carries model metadata only; credentials are read from the OS secret store. */
export async function createDesktopChatStore(
  invokeNative: typeof invoke,
  getModels: () => ModelOption[],
  model?: string,
  request?: typeof fetch
) {
  let selected = model ? selection(model, getModels()) : undefined
  const connection = await invokeNative<RemoteAgentInfo>('sidecar_info', { selection: selected ?? null, restart: false })
  if (!selected) {
    const models = await new RemoteChatStore(connection, request).models()
    if (!models[0]) throw new Error('The local host did not provide a model')
    selected = selection(models[0].value, models)
  }
  return new DesktopChatStore(connection, invokeNative, getModels, selected, request)
}
