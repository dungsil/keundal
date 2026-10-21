/** Manual and generated titles share the same durable display contract. */
export function validateChatTitle(value: string): string {
  const title = value.trim()
  if (!title || title.length > 100) throw new Error('Title must contain 1–100 characters')
  return title
}
