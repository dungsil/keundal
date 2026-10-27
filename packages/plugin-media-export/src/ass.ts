import type { SubtitleSegment } from '@keundal/media'

export interface AssStyleOptions {
  readonly width?: number
  readonly height?: number
  readonly fontSize?: number
}

function formatTime(milliseconds: number): string {
  const total = Math.max(0, Math.round(milliseconds))
  const hours = Math.floor(total / 3_600_000)
  const minutes = Math.floor((total % 3_600_000) / 60_000)
  const seconds = Math.floor((total % 60_000) / 1_000)
  const centiseconds = Math.floor((total % 1_000) / 10)
  const pad = (value: number, size = 2) => String(value).padStart(size, '0')
  return `${hours}:${pad(minutes)}:${pad(seconds)}.${pad(centiseconds)}`
}

function escapeText(text: string): string {
  return text.replace(/[{}]/g, '').replace(/\r?\n/g, '\\N').trim()
}

/**
 * 구간을 0부터 시작하도록 옮긴 ASS 자막을 만듭니다.
 * `offsetMs`는 클립의 시작 시각입니다.
 */
export function buildAss(
  segments: readonly SubtitleSegment[],
  offsetMs: number,
  options: AssStyleOptions = {}
): string {
  const width = options.width ?? 1280
  const height = options.height ?? 720
  const fontSize = options.fontSize ?? Math.round(height / 18)
  const lines = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,Arial,${fontSize},&H00FFFFFF,&H000000FF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,2,0,2,20,20,28,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'
  ]
  for (const segment of segments) {
    const start = segment.startMs - offsetMs
    const end = segment.endMs - offsetMs
    if (end <= 0) continue
    const text = escapeText(segment.text)
    if (text.length === 0) continue
    lines.push(`Dialogue: 0,${formatTime(Math.max(0, start))},${formatTime(end)},Default,,0,0,0,,${text}`)
  }
  return `${lines.join('\n')}\n`
}
