import { chatMarkdownOptions } from '../../utils/markdown'
import SourceLink from './SourceLink.vue'

export default defineMarkdownComponent({
  ...chatMarkdownOptions,
  name: 'ChatComark',
  components: {
    'source-link': SourceLink
  },
  class: '*:first:mt-0 *:last:mb-0'
})
