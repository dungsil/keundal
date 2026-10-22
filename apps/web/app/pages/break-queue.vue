<script setup lang="ts">
import type { ChatMessage } from '@keundal/chat/chat-message'
import { reactive } from 'vue'

definePageMeta({ layout: 'default' })

interface Row {
  group: string
  label: string
  queue: ChatMessage[]
  /** 컨테이너 너비를 바꿔 가며 확인할 때 지정합니다. */
  width?: string
  /** 좁은 flex 자식 안에서 줄어들 때의 표시를 확인합니다. */
  squeeze?: boolean
  paused?: boolean
  browserOnly?: boolean
}

let seq = 0

function msg(text: string): ChatMessage {
  return { id: `m${++seq}`, role: 'user', parts: [{ type: 'text', text }] }
}

function many(texts: string[]): ChatMessage[] {
  return texts.map(msg)
}

const longWord = 'Donaudampfschiffahrtselektrizitaetenhauptbetriebswerkbauunterbeamtengesellschaft'
const sentences
  = '내일 오전 회의 자료를 정리해 주세요. 참고자료는 공유 드라이브에 있습니다. '
    + '검토가 끝나면 요약본도 함께 보내 주세요.'
const arabic = 'من فضلك راجع ملف الميزانية قبل الاجتماع غداً وأرسل الملاحظات.'
const mixed = 'من فضلك افتح تقرير keundal-report-2026-final-v3.xlsx قبل الاجتماع.'
const vietnamese = 'Tiếng Việt có dấu: ậệộữ ẮẰẲẴẶ — độ cao dòng thử nghiệm.'

const baseline = many(['내일 회의 자료 좀 정리해 줄 수 있어?'])
const realistic = many([
  '내일 회의 자료 좀 정리해 줄 수 있어?',
  '그리고 참고자료도 같이 보내 줘',
  '회의는 오전 10시야'
])
const thirty = many(Array.from({ length: 30 }, (_, i) => `대기 중인 메시지 ${i + 1}`))

const fileOnly: ChatMessage[] = [
  { id: 'file-only', role: 'user', parts: [{ type: 'file', mediaType: 'image/png', url: 'data:,', filename: 'a.png' }] }
]
const textWithFile: ChatMessage[] = [
  {
    id: 'text-file',
    role: 'user',
    parts: [
      { type: 'text', text: '이 파일 요약해 줘' },
      { type: 'file', mediaType: 'image/png', url: 'data:,', filename: 'keundal-report-2026-final-v3.png' }
    ]
  }
]

const source: Row[] = [
  // Content length · 640px
  { group: 'Content length · 640px', label: '빈 문자열', queue: many(['']) },
  { group: 'Content length · 640px', label: '텍스트 파트 없음 (첨부만)', queue: fileOnly },
  { group: 'Content length · 640px', label: '한 단어', queue: many(['안녕']) },
  { group: 'Content length · 640px', label: '보통 길이', queue: baseline },
  { group: 'Content length · 640px', label: '여러 문장', queue: many([sentences]) },
  { group: 'Content length · 640px', label: '공백 없는 85자 문자열', queue: many([longWord]) },

  // Content shape · 640px
  { group: 'Content shape · 640px', label: '이모지 단독 + 섞인 텍스트', queue: many(['🎉🎉🎉', '좋아요 👍 정말 잘 됐어요 🚀']) },
  { group: 'Content shape · 640px', label: '텍스트 + 첨부 혼합', queue: textWithFile },
  { group: 'Content shape · 640px', label: 'RTL 아랍어', queue: many([arabic]) },
  { group: 'Content shape · 640px', label: '혼합 방향 (RTL 문장 + LTR 파일명)', queue: many([mixed]) },
  { group: 'Content shape · 640px', label: '발음 기호 / 높은 글자', queue: many([vietnamese]) },

  // Quantity · 640px
  { group: 'Quantity · 640px', label: '0개', queue: [] },
  { group: 'Quantity · 640px', label: '1개', queue: baseline },
  { group: 'Quantity · 640px', label: '3개 (실제 개수)', queue: realistic },
  { group: 'Quantity · 640px', label: '30개 (10배)', queue: thirty },

  // Container · 3개, 실제 개수
  { group: 'Container · 3개', label: '320px 컨테이너', queue: realistic, width: '320px' },
  { group: 'Container · 3개', label: '넓은 형제에게 밀리는 flex 자식', queue: realistic, squeeze: true },
  { group: 'Container · 3개', label: '1200px 컨테이너', queue: realistic, width: '1200px' },

  // State · 640px
  { group: 'State · 640px', label: 'paused', queue: realistic, paused: true },
  { group: 'State · 640px', label: 'paused + browserOnly', queue: realistic, paused: true, browserOnly: true },
  { group: 'State · 640px', label: 'browserOnly 단독', queue: realistic, browserOnly: true }
]

const rows = reactive(source)
const groups = [...new Set(source.map(row => row.group))]

function remove(row: Row, messageId: string) {
  row.queue = row.queue.filter(message => message.id !== messageId)
}

function resume(row: Row) {
  row.paused = false
}
</script>

<template>
  <div class="flex h-full flex-col gap-10 overflow-auto p-6">
    <section v-for="group in groups" :key="group" class="flex flex-col gap-8">
      <h2 class="text-sm font-semibold text-highlighted">
        {{ group }}
      </h2>
      <div
        v-for="row in rows.filter(item => item.group === group)"
        :key="row.label"
        role="group"
        :aria-label="row.label"
      >
        <p class="text-xs text-muted">
          {{ row.label }}
        </p>
        <div v-if="row.squeeze" class="mt-2 flex items-start gap-4">
          <div class="h-16 w-[420px] shrink-0 rounded border border-default" />
          <div>
            <ChatQueue
              :queue="row.queue"
              :paused="row.paused ?? false"
              :browser-only="row.browserOnly ?? false"
              @remove="remove(row, $event)"
              @resume="resume(row)"
            />
          </div>
        </div>
        <div v-else class="mt-2" :style="{ width: row.width ?? '640px', maxWidth: '100%' }">
          <ChatQueue
            :queue="row.queue"
            :paused="row.paused ?? false"
            :browser-only="row.browserOnly ?? false"
            @remove="remove(row, $event)"
            @resume="resume(row)"
          />
        </div>
      </div>
    </section>
  </div>
</template>
