<script setup lang="ts">
import { parseRunBudget, type RunBudget } from '@keundal/agent'
import { useMounted } from '@vueuse/core'
import type { Ref } from 'vue'

import { useText } from '../locale'

const props = defineProps<{
  runBudget: Ref<RunBudget | undefined>
  saveRunBudget: (value: RunBudget | undefined) => void
}>()
const { t } = useText()
const mounted = useMounted()
const toast = useToast()
const enabled = ref(false)
const maxTokens = ref<string | number>('')
const maxCost = ref<string | number>('')
const currency = ref('USD')
const duration = ref<string | number>('')
const unknownPricing = ref<'reject' | 'allow'>('reject')
const error = ref('')

onMounted(() => {
  const saved = props.runBudget.value
  enabled.value = saved !== undefined
  maxTokens.value = saved?.maxTokens ?? ''
  maxCost.value = saved?.maxCost?.amount ?? ''
  currency.value = saved?.maxCost?.currency ?? 'USD'
  duration.value = saved?.maxDurationMs === undefined ? '' : saved.maxDurationMs / 1000
  unknownPricing.value = saved?.unknownPricing ?? 'reject'
})

function save() {
  if (!mounted.value) return
  error.value = ''
  let budget: RunBudget | undefined
  if (enabled.value) {
    try {
      budget = parseRunBudget({
        ...(maxTokens.value === '' ? {} : { maxTokens: Number(maxTokens.value) }),
        ...(maxCost.value === '' ? {} : { maxCost: { amount: Number(maxCost.value), currency: currency.value } }),
        ...(duration.value === '' ? {} : { maxDurationMs: Math.round(Number(duration.value) * 1000) }),
        unknownPricing: unknownPricing.value
      })
    } catch {
      error.value = t('budget.invalid')
      return
    }
  }
  try {
    props.saveRunBudget(budget)
    toast.add({ title: t('budget.saved'), icon: 'i-lucide-check', color: 'success' })
  } catch {
    error.value = t('budget.saveFailed')
  }
}
</script>

<template>
  <section class="space-y-4" aria-labelledby="execution-budget-title">
    <h2 id="execution-budget-title" class="text-lg font-semibold text-highlighted">{{ t('budget.title') }}</h2>
    <form class="space-y-5" @submit.prevent="save">
      <USwitch v-model="enabled" :label="t('budget.enabled')" :disabled="!mounted" />
      <p class="text-sm text-muted">{{ t('budget.scope') }}</p>
      <fieldset v-if="enabled" :disabled="!mounted" class="min-w-0 space-y-4">
        <UFormField :label="t('budget.tokens')" name="maxTokens">
          <UInput v-model.number="maxTokens" type="number" :min="1" :max="Number.MAX_SAFE_INTEGER" :step="1" :placeholder="t('budget.noLimit')" class="w-full" />
        </UFormField>
        <div class="grid min-w-0 gap-4 sm:grid-cols-2">
          <UFormField :label="t('budget.cost')" name="maxCost">
            <UInput v-model.number="maxCost" type="number" :min="0" step="any" :placeholder="t('budget.noLimit')" class="w-full" />
          </UFormField>
          <UFormField :label="t('budget.currency')" name="currency">
            <UInput v-model="currency" :disabled="maxCost === ''" class="w-full" />
          </UFormField>
        </div>
        <UFormField :label="t('budget.duration')" name="maxDurationMs">
          <UInput v-model.number="duration" type="number" :min="0.001" :max="2147483.647" :step="0.001" :placeholder="t('budget.noLimit')" class="w-full" />
        </UFormField>
        <UFormField :label="t('budget.unknownPricing')" name="unknownPricing">
          <select v-model="unknownPricing" :disabled="maxCost === ''" :aria-label="t('budget.unknownPricing')" class="w-full rounded-md border border-default bg-default px-3 py-2 text-sm">
            <option value="reject">{{ t('budget.reject') }}</option>
            <option value="allow">{{ t('budget.allow') }}</option>
          </select>
        </UFormField>
        <p role="note" class="text-sm text-warning">{{ t('budget.warning') }}</p>
      </fieldset>
      <p v-if="error" role="alert" class="text-sm text-error">{{ error }}</p>
      <div class="flex justify-end">
        <UButton type="submit" :disabled="!mounted" :label="t('common.save')" />
      </div>
    </form>
  </section>
</template>
