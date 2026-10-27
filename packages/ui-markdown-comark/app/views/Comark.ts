import { computed, defineComponent, h, type PropType } from 'vue'
import { defineMarkdownComponent } from '@comark/vue'
import type { MarkdownSource } from '@keundal/ui/app/types/markdown.ts'
import SourceLink from '@keundal/ui/app/components/chat/SourceLink.vue'
import { chatMarkdownOptions } from '../lib/markdown'
import { withSources } from '../lib/source'

const Comark = defineMarkdownComponent({
  ...chatMarkdownOptions,
  name: 'ChatComark',
  components: {
    'source-link': SourceLink
  },
  class: '*:first:mt-0 *:last:mb-0'
})

export default defineComponent({
  props: {
    value: { type: String, required: true },
    streaming: Boolean,
    sources: { type: Array as PropType<readonly MarkdownSource[]>, default: () => [] }
  },
  setup(props) {
    const value = computed(() => withSources(props.value, props.sources))
    return () => h(Comark, { value: value.value, streaming: props.streaming })
  }
})
