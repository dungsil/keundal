<script setup lang="ts">
import { computed, onBeforeUnmount, reactive } from 'vue'
import { getCitationUrl } from '../../../utils/url'

const props = defineProps<{
  sources: Source[]
}>()

const rows = computed(() => props.sources.map(source => ({
  url: source.url,
  title: source.title,
  domain: getDomain(source.url),
  href: getCitationUrl(source.url)
})))

/** 말줄임표로 잘린 행의 순번입니다. 잘린 행에만 전체 텍스트 툴팁을 켭니다. */
const truncated = reactive<Record<number, boolean>>({})
const tracked = new Map<number, HTMLElement>()
let observer: ResizeObserver | undefined

function measure(row: HTMLElement) {
  truncated[Number(row.dataset.index)] = [...row.querySelectorAll('span')].some(span => span.scrollWidth > span.clientWidth)
}

function track(row: unknown, index: number) {
  const previous = tracked.get(index)
  if (previous) observer?.unobserve(previous)
  if (!(row instanceof HTMLElement)) {
    tracked.delete(index)
    return
  }
  observer ??= new ResizeObserver(entries => entries.forEach(entry => measure(entry.target as HTMLElement)))
  tracked.set(index, row)
  observer.observe(row)
  measure(row)
}

onBeforeUnmount(() => observer?.disconnect())
</script>

<template>
  <div v-if="sources.length" class="p-1 border border-default rounded-md max-h-40 overflow-y-auto">
    <UTooltip
      v-for="(source, index) in rows"
      :key="source.url"
      :text="source.title ? `${source.title} · ${source.domain}` : source.domain"
      :disabled="!truncated[index]"
      :content="{ side: 'top' }"
    >
      <component
        :is="source.href ? 'a' : 'div'"
        :ref="(row: unknown) => track(row, index)"
        :data-index="index"
        v-bind="source.href ? { href: source.href, target: '_blank', rel: 'noopener noreferrer' } : {}"
        class="flex items-center gap-2 px-2 py-1 text-sm text-muted min-w-0 rounded-md"
        :class="source.href && 'hover:text-default hover:bg-elevated/50 transition-colors'"
      >
        <UIcon name="i-lucide-link" class="size-4 shrink-0" aria-hidden="true" />
        <span class="truncate">{{ source.title || source.domain }}</span>
        <span v-if="source.title" class="text-xs text-muted ms-auto shrink-0 max-w-[40%] truncate">{{ source.domain }}</span>
      </component>
    </UTooltip>
  </div>
</template>
