<script setup lang="ts">
const { selectedModel, models, loading, error, refresh } = useModels()
</script>

<template>
  <USelectMenu
    v-model="selectedModel"
    :items="models"
    :loading="loading"
    size="sm"
    :icon="models.find((m) => m.value === selectedModel)?.icon"
    color="neutral"
    variant="ghost"
    value-key="value"
    class="data-[state=open]:bg-elevated"
    :ui="{
      content: 'w-80 max-w-[calc(100vw-2rem)]',
      trailingIcon: 'group-data-[state=open]:rotate-180 transition-transform duration-200'
    }"
    @update:open="
      (value) => {
        if (value) refresh(false)
      }
    "
  >
    <template #content-bottom>
      <div class="border-t border-default p-2 space-y-2 max-w-80">
        <p v-if="error" role="alert" class="text-xs text-error break-words">
          {{ error }}
        </p>
        <p class="text-xs text-muted">
          Provider models are cached in this browser for 1 hour. Listed models must support this app's text, tools and
          token-counting APIs.
        </p>
        <UButton
          label="Refresh models"
          icon="i-lucide-refresh-cw"
          size="xs"
          color="neutral"
          variant="ghost"
          :loading="loading"
          @click.stop="refresh()"
        />
      </div>
    </template>
  </USelectMenu>
</template>
