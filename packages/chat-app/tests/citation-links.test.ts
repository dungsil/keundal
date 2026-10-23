import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import * as Vue from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import { renderToString } from 'vue/server-renderer'
import ts from 'typescript'
import * as urls from '../app/utils/url'
import { getSources, sourceToInlineMdc } from '../app/utils/tool'

// Compile the actual SFCs, including their attribute inheritance and templates.
function component(path: string): Vue.Component {
  const { descriptor } = parse(readFileSync(new URL(path, import.meta.url), 'utf8'))
  const script = compileScript(descriptor, { id: 'citation-test', inlineTemplate: true })
  const code = ts.transpileModule(script.content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const exports = {} as { default: Vue.Component }
  const require = (name: string) => name === 'vue' ? Vue : urls
  new Function('require', 'exports', 'computed', 'getDomain', 'getFaviconUrl', code)(
    require, exports, Vue.computed, urls.getDomain, urls.getFaviconUrl
  )
  return exports.default
}

const SourceLink = component('../app/components/chat/SourceLink.vue')
const Sources = component('../app/components/chat/tool/Sources.vue')

function render(component: Vue.Component, props: Record<string, unknown>) {
  const app = Vue.createSSRApp(component, props)
  Object.assign(app.config.globalProperties, urls)
  app.component('UButton', Vue.defineComponent({
    props: ['to', 'label'],
    setup: props => () => Vue.h('a', { href: props.to }, props.label)
  }))
  return renderToString(app)
}

const unsafe = [
  'javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'java\tscript:alert(1)',
  '\n javascript:alert(1)', 'data:text/html,<script>alert(1)</script>',
  'vbscript:msgbox(1)', 'file:///etc/passwd', '//example.com', '/relative',
  'not a URL" to="javascript:alert(1)'
]

describe('인용 링크의 URL 검증', () => {
  test.each(unsafe)('안전하지 않은 %s URL은 링크로 렌더링하지 않는다', async (url) => {
    expect(urls.getCitationUrl(url)).toBeUndefined()
    expect(sourceToInlineMdc(url)).toBe('')
    const inline = await render(SourceLink, { url, label: '출처', favicon: '' })
    expect(inline).toContain('<span class="break-words">출처</span>')
    expect(inline).not.toContain('<a')
    const list = await render(Sources, { sources: [{ url, title: '출처' }] })
    expect(list).not.toContain('href=')
    expect(list).toContain('출처')
  })

  test('모델이 추가한 탐색 속성은 검증된 목적지를 덮어쓰지 않는다', async () => {
    const html = await render(SourceLink, {
      url: 'https://example.com/source', label: '출처', favicon: '',
      href: 'javascript:alert(1)', to: 'javascript:alert(2)', onclick: 'alert(3)'
    })
    expect(html).toContain('href="https://example.com/source"')
    expect(html).not.toContain('javascript:')
    expect(html).not.toContain('onclick')
  })

  test.each(['https://example.com/source?q=1#section', 'http://example.com/source'])('정상 %s 인용은 유지한다', async (url) => {
    expect(urls.getCitationUrl(url)).toBe(url)
    expect(sourceToInlineMdc(url)).toContain(`url="${url}"`)
    expect(await render(SourceLink, { url, label: '출처', favicon: '' })).toContain(`href="${url}"`)
    expect(await render(Sources, { sources: [{ url, title: '출처' }] })).toContain(`href="${url}"`)
  })

  test('모든 공급자의 도구 출처에 동일한 렌더링 검증을 적용한다', async () => {
    for (const output of [
      [{ url: 'javascript:alert(1)' }, { url: 'https://example.com/' }],
      { sources: [{ url: 'javascript:alert(1)' }, { url: 'https://example.com/' }] },
      { groundingChunks: [{ web: { uri: 'javascript:alert(1)' } }, { web: { uri: 'https://example.com/' } }] },
      { groundingMetadata: { groundingChunks: [{ web: { uri: 'javascript:alert(1)' } }, { web: { uri: 'https://example.com/' } }] } }
    ]) {
      const sources = getSources({ type: 'tool-web_search', toolCallId: 'search', state: 'output-available', input: {}, output })
      const html = await render(Sources, { sources })
      expect(html).not.toContain('href="javascript:')
      expect(html).toContain('href="https://example.com/"')
    }
  })
})
