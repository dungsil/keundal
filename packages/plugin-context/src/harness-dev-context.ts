import { appendContext } from '@keundal/context'
import type { ContextProvider } from '@keundal/context'
import type { RunAgentInput } from '@keundal/core'

export interface HarnessDevContextConfig {
  /** Absolute path to the actual Keundal checkout. */
  readonly checkoutPath: string
  /** URL advertised by the Web GUI serving this agent. */
  readonly webGuiUrl: string
}

const GUIDANCE =
  'The runtime context identifies the Keundal implementation checkout and Web GUI. The checkout path is not necessarily the current working directory; use pwd for the latter. "This page" refers to the named GUI, but no DOM, route, or screenshot is implicitly available.'

export function createHarnessDevContext(config: HarnessDevContextConfig): ContextProvider {
  if (config.checkoutPath.length === 0 || config.webGuiUrl.length === 0)
    throw new TypeError('checkoutPath and webGuiUrl are required')
  return (input: RunAgentInput) => {
    const guided = appendContext(input, 'harness-dev:guidance', GUIDANCE)
    const checkout = appendContext(
      guided,
      'harness-dev:checkout',
      `Current Keundal implementation checkout: ${JSON.stringify(config.checkoutPath)}.`
    )
    return appendContext(
      checkout,
      'harness-dev:web-gui',
      `Current Keundal Web GUI URL: ${JSON.stringify(config.webGuiUrl)}.`
    )
  }
}
