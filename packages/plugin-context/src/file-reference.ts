import { appendContext, type ContextProvider } from '@keundal/context'

export const FILE_REFERENCE_PROMPT =
  'Tokens prefixed with @ are paths the user explicitly referenced. Relative paths resolve from the workspace root; absolute paths identify files or directories on the host. A trailing slash marks a directory: list it when its contents matter. Anything else is a file: use the read tool when its contents are needed, and do not claim to have inspected it before reading. @"..." quotes a path containing spaces.'

export function createFileReferenceContext(references?: { invalidate(): void }): ContextProvider {
  return (input, options) => {
    options.signal?.throwIfAborted()
    if (options.step > 1) references?.invalidate()
    if (!input.tools.some((tool) => tool.name === 'read' || tool.name === 'read_file')) return input
    return appendContext(input, 'file-reference:guidance', FILE_REFERENCE_PROMPT)
  }
}
