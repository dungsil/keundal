import security from '@comark/nuxt/plugins/security'
import { defineComarkPlugin } from '@comark/nuxt/parse'
import { visit } from '@comark/nuxt/utils'
import shiki from '@comark/nuxt/plugins/shiki'
import c from '@shikijs/langs/c'
import cpp from '@shikijs/langs/cpp'
import css from '@shikijs/langs/css'
import diff from '@shikijs/langs/diff'
import dockerfile from '@shikijs/langs/dockerfile'
import go from '@shikijs/langs/go'
import graphql from '@shikijs/langs/graphql'
import html from '@shikijs/langs/html'
import java from '@shikijs/langs/java'
import kotlin from '@shikijs/langs/kotlin'
import php from '@shikijs/langs/php'
import python from '@shikijs/langs/python'
import ruby from '@shikijs/langs/ruby'
import rust from '@shikijs/langs/rust'
import sql from '@shikijs/langs/sql'
import swift from '@shikijs/langs/swift'
import toml from '@shikijs/langs/toml'
import xml from '@shikijs/langs/xml'

const markdownAttributes = new Set([
  'class', 'classname', 'id', 'title', 'style',
  'href', 'target', 'rel', 'src', 'alt', 'width', 'height',
  'start', 'align', 'colspan', 'rowspan',
  'type', 'disabled', 'checked', 'open',
  'code', 'language', 'filename', 'highlights', 'meta'
])
const sourceAttributes = new Set(['url', 'favicon', 'label'])

export const chatMarkdownOptions = {
  plugins: [
    shiki({
      languages: [
        html,
        css,
        python,
        sql,
        go,
        rust,
        java,
        c,
        cpp,
        ruby,
        php,
        swift,
        kotlin,
        diff,
        dockerfile,
        xml,
        toml,
        graphql
      ]
    }),
    security({
      allowedTags: [
        'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
        'blockquote', 'ul', 'ol', 'li', 'strong', 'em', 's', 'del',
        'a', 'img', 'pre', 'code', 'span', 'div',
        'table', 'thead', 'tbody', 'tr', 'th', 'td',
        'input', 'details', 'summary', 'sup', 'sub', 'kbd', 'mark',
        'source-link'
      ],
      allowedProtocols: ['http', 'https', 'mailto'],
      allowDataImages: false
    }),
    defineComarkPlugin(() => ({
      name: 'chat-static-attributes',
      post(state) {
        visit(state.tree, node => Array.isArray(node), (node) => {
          if (typeof node === 'string') return
          node[1] = Object.fromEntries(Object.entries(node[1]).flatMap(([key, value]) => {
            const name = key.toLowerCase()
            if (node[0] === 'input' && [':disabled', ':checked'].includes(name) && value === 'true') {
              return [[name.slice(1), true]]
            }
            // Nuxt prose components also consume props such as `to`, `as`, and `copy`.
            // Allow only static Markdown attributes, not arbitrary component props.
            const allowed = node[0] === 'source-link'
              ? sourceAttributes.has(name)
              : markdownAttributes.has(name) || name.startsWith('aria-') || name.startsWith('data-')
            if (!allowed) {
              return []
            }
            return [[key, value]]
          }))
        })
      }
    }))()
  ]
}
