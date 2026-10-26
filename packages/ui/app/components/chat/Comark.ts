import { chatMarkdownOptions } from '../../utils/markdown'

export default defineMarkdownComponent({
  ...chatMarkdownOptions,
  name: 'ChatComark',
  class: '*:first:mt-0 *:last:mb-0'
})
