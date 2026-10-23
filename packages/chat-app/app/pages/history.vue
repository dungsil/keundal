<script setup lang="ts">
import { useRouter } from '#imports'
import { chatPath, historyQuery, historySort, searchChatHistory } from '../../shared/utils/chat-navigation'

const { t } = useLocale()
const route = useRoute()
const router = useRouter()
const { data: chats } = useNuxtData<UIChat[]>('chats')
const query = ref(historyQuery(route.query.q))
const sort = ref(historySort(route.query.sort))
const limit = ref(40)
watch(() => [route.query.q, route.query.sort], () => {
  query.value = historyQuery(route.query.q)
  sort.value = historySort(route.query.sort)
  limit.value = 40
})
const results = computed(() => searchChatHistory((chats.value ?? []).map(chat => ({
  ...chat, label: chat.label || t('chat.untitled')
})), historyQuery(route.query.q), historySort(route.query.sort)))
const sortOptions = computed(() => [
  { label: t('history.newest'), value: 'newest' },
  { label: t('history.oldest'), value: 'oldest' }
])
// Only explicit form submission writes search text to browser history.
function applySearch() {
  limit.value = 40
  void router.push({ path: '/history', query: {
    ...(query.value.trim() ? { q: query.value.trim() } : {}),
    ...(sort.value === 'oldest' ? { sort: 'oldest' } : {})
  } })
}
useHead(() => ({ title: t('history.title') }))
</script>

<template>
  <UDashboardPanel id="history" class="min-h-0">
    <template #header>
      <Navbar><template #title><h1 class="text-lg font-semibold">{{ t('history.title') }}</h1></template></Navbar>
    </template>
    <template #body>
      <UContainer class="w-full max-w-4xl pt-[calc(var(--ui-header-height)+1.5rem)] pb-6">
        <form class="flex flex-wrap gap-2 mb-6" role="search" @submit.prevent="applySearch">
          <UInput v-model="query" :aria-label="t('history.search')" :placeholder="t('history.search')" class="min-w-48 flex-1" data-testid="history-query" />
          <USelect v-model="sort" :items="sortOptions" :aria-label="t('history.sort')" />
          <UButton type="submit" :label="t('chat.search')" icon="i-lucide-search" />
        </form>
        <ul class="space-y-1" data-testid="history-results">
          <li v-for="chat in results.slice(0, limit)" :key="chat.id">
            <NuxtLink :to="chatPath(chat.id)" class="block rounded-md p-3 hover:bg-elevated focus-visible:outline-2 focus-visible:outline-primary">
              {{ chat.label }}
            </NuxtLink>
          </li>
        </ul>
        <p v-if="!results.length" role="status" class="text-muted">{{ t('history.empty') }}</p>
        <UButton v-if="results.length > limit" :label="t('history.loadMore')" variant="ghost" class="mt-3" @click="limit += 40" />
      </UContainer>
    </template>
  </UDashboardPanel>
</template>
