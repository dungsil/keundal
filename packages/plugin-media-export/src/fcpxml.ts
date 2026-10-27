import type { MediaClip } from '@keundal/media'

export interface FcpxmlInput {
  readonly title: string
  readonly sourceUrl: string
  readonly clips: readonly MediaClip[]
  /** 초당 프레임 수입니다. 기본값은 25입니다. */
  readonly frameRate?: number
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** 밀리초를 FCPXML 시간 표기로 바꿉니다. */
export function fcpxmlTime(milliseconds: number): string {
  return `${(Math.max(0, milliseconds) / 1_000).toFixed(3)}s`
}

/**
 * 원본 파일 하나와 클립 구간 목록으로 FCPXML 1.9 문서를 만듭니다.
 * 클립은 원본의 같은 자산을 가리키고 시작 시각만 다릅니다.
 */
export function buildFcpxml(input: FcpxmlInput): string {
  const frameRate = input.frameRate ?? 25
  const formatName = `FFVideoFormat${frameRate}p`
  const frameDuration = `1/${frameRate}s`
  const total = input.clips.reduce((sum, clip) => sum + Math.max(0, clip.endMs - clip.startMs), 0)
  const clips = input.clips
    .map((clip, index) => {
      const duration = Math.max(0, clip.endMs - clip.startMs)
      const offset = input.clips
        .slice(0, index)
        .reduce((sum, previous) => sum + Math.max(0, previous.endMs - previous.startMs), 0)
      return `        <asset-clip name="${escapeXml(clip.name)}" offset="${fcpxmlTime(offset)}" duration="${fcpxmlTime(duration)}" start="${fcpxmlTime(clip.startMs)}" format="r1" ref="r2"/>`
    })
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.9">
  <resources>
    <format id="r1" name="${formatName}" frameDuration="${frameDuration}"/>
    <asset id="r2" name="${escapeXml(input.title)}" start="0s" hasVideo="1" hasAudio="1" format="r1" src="${escapeXml(input.sourceUrl)}"/>
  </resources>
  <library>
    <event name="${escapeXml(input.title)}">
      <project name="${escapeXml(input.title)}">
        <sequence format="r1" duration="${fcpxmlTime(total)}" tcStart="0s">
          <spine>
${clips}
          </spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>
`
}
