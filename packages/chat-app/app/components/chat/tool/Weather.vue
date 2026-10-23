<script setup lang="ts">
import type { WeatherUIToolInvocation } from '@keundal/chat/tools/weather'

const { t } = useLocale()

const props = defineProps<{
  invocation: WeatherUIToolInvocation
}>()

const color = computed(() => {
  if (props.invocation.state === 'output-available') {
    return 'bg-gradient-to-br from-sky-800 via-blue-800 to-indigo-900 text-white'
  }
  return 'bg-muted text-default'
})

const icon = computed(() => {
  return (
    {
      'input-available': 'i-lucide-cloud-sun',
      'output-error': 'i-lucide-triangle-alert'
    }[props.invocation.state as string] || 'i-lucide-loader-circle'
  )
})

const message = computed(() => {
  return (
    {
      'input-available': t('weather.loading'),
      'output-error': t('weather.failed')
    }[props.invocation.state as string] || t('weather.loading')
  )
})
</script>

<template>
  <div class="rounded-xl px-5 py-4 my-5" :class="color">
    <template v-if="invocation.state === 'output-available'">
      <div class="flex items-start justify-between gap-3 mb-3">
        <div class="flex items-baseline shrink-0">
          <span class="text-4xl font-bold">{{ invocation.output.temperature }}°</span>
          <span class="text-base text-white/80">C</span>
        </div>
        <div class="text-right min-w-0">
          <div class="text-base font-medium mb-1 wrap-anywhere">
            {{ invocation.output.location }}
          </div>
          <div class="text-xs text-white/70">
            {{ t('weather.range', { high: invocation.output.temperatureHigh, low: invocation.output.temperatureLow }) }}
          </div>
        </div>
      </div>

      <div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 mb-4">
        <div class="flex items-center gap-2 min-w-0">
          <UIcon :name="invocation.output.condition.icon" class="size-6 shrink-0 text-white" />
          <div class="text-sm font-medium min-w-0 wrap-anywhere">
            {{ invocation.output.condition.text }}
          </div>
        </div>

        <div class="flex gap-3 text-xs shrink-0 whitespace-nowrap ml-auto">
          <div v-if="invocation.output.humidity != null" class="flex items-center gap-1">
            <UIcon name="i-lucide-droplets" class="size-3 text-blue-200" />
            <span>{{ invocation.output.humidity }}%</span>
          </div>
          <div v-if="invocation.output.windSpeed != null" class="flex items-center gap-1">
            <UIcon name="i-lucide-wind" class="size-3 text-blue-200" />
            <span>{{ invocation.output.windSpeed }} km/h</span>
          </div>
        </div>
      </div>

      <div v-if="invocation.output.dailyForecast.length > 0" class="flex items-center justify-between gap-2 overflow-x-auto">
        <div
          v-for="(forecast, index) in invocation.output.dailyForecast"
          :key="index"
          class="flex flex-col items-center gap-1.5 shrink-0 max-w-20"
        >
          <div class="text-xs text-white/70 font-medium text-center wrap-anywhere max-w-full">
            {{ forecast.day }}
          </div>

          <UIcon :name="forecast.condition.icon" class="size-5 text-white" />
          <div class="text-xs font-medium">
            <div>{{ forecast.high }}°</div>
            <div class="text-white/70">
              {{ forecast.low }}°
            </div>
          </div>
        </div>
      </div>

      <div v-else class="flex items-center justify-center py-3">
        <div class="text-xs">
          {{ t('weather.noForecast') }}
        </div>
      </div>
    </template>

    <div v-else class="flex items-center justify-center h-44">
      <div class="text-center">
        <UIcon
          :name="icon"
          class="size-8 mx-auto mb-2"
          :class="[
            invocation.state === 'input-streaming' && 'animate-spin motion-reduce:animate-none',
            invocation.state === 'output-error' && 'text-error'
          ]"
        />
        <div class="text-sm">
          {{ message }}
        </div>
      </div>
    </div>
  </div>
</template>
