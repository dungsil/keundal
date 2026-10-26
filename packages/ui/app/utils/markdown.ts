import { defineComarkPlugin } from '@comark/nuxt/parse'
import security from '@comark/nuxt/plugins/security'
import shiki from '@comark/nuxt/plugins/shiki'
import { visit } from '@comark/nuxt/utils'
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
import githubDark from 'shiki/themes/github-dark-high-contrast.mjs'
import githubLight from 'shiki/themes/github-light-high-contrast.mjs'

const markdownAttributes = new Set([
  'class',
  'classname',
  'id',
  'title',
  'style',
  'href',
  'target',
  'rel',
  'alt',
  'width',
  'height',
  'start',
  'align',
  'colspan',
  'rowspan',
  'type',
  'disabled',
  'checked',
  'open',
  'code',
  'language',
  'filename',
  'highlights',
  'meta'
])

export const chatMarkdownOptions = {
  plugins: [
    shiki({
      registerDefaultThemes: false,
      themes: { light: githubLight, dark: githubDark },
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
    defineComarkPlugin(() => ({
      name: 'chat-image-links',
      post(state) {
        visit(
          state.tree,
          (node) => Array.isArray(node),
          (node) => {
            if (typeof node === 'string' || node[0] !== 'img') return
            const { src, alt } = node[1]
            node.splice(
              0,
              node.length,
              'a',
              { href: typeof src === 'string' ? src : '' },
              typeof alt === 'string' ? alt : 'Image'
            )
          }
        )
      }
    }))(),
    security({
      allowedTags: [
        'p',
        'br',
        'hr',
        'h1',
        'h2',
        'h3',
        'h4',
        'h5',
        'h6',
        'blockquote',
        'ul',
        'ol',
        'li',
        'strong',
        'em',
        's',
        'del',
        'a',
        'pre',
        'code',
        'span',
        'div',
        'table',
        'thead',
        'tbody',
        'tr',
        'th',
        'td',
        'input',
        'details',
        'summary',
        'sup',
        'sub',
        'kbd',
        'mark'
      ],
      allowedProtocols: ['http', 'https', 'mailto'],
      allowDataImages: false
    }),
    defineComarkPlugin(() => ({
      name: 'chat-static-attributes',
      post(state) {
        visit(
          state.tree,
          (node) => Array.isArray(node),
          (node) => {
            if (typeof node === 'string') return
            node[1] = Object.fromEntries(
              Object.entries(node[1]).flatMap(([key, value]) => {
                const name = key.toLowerCase()
                // Only inert Shiki styles survive, including styles on reused streaming nodes.
                if (name === 'style') {
                  if (typeof value !== 'string') return []
                  const styles = value
                    .split(';')
                    .filter((declaration) =>
                      [
                        /^\s*(?:color|background-color|--shiki-(?:light|dark)(?:-bg)?):\s*#[0-9a-f]{3,8}\s*$/i,
                        /^\s*(?:font-style|--shiki-(?:light|dark)-font-style):\s*(?:normal|italic|oblique)\s*$/i,
                        /^\s*(?:font-weight|--shiki-(?:light|dark)-font-weight):\s*(?:normal|bold|[1-9]00)\s*$/i,
                        /^\s*(?:text-decoration|--shiki-(?:light|dark)-text-decoration):\s*(?:none|underline|line-through)\s*$/i
                      ].some((pattern) => pattern.test(declaration))
                    )
                    .join(';')
                  return styles ? [[key, styles]] : []
                }
                if (node[0] === 'input' && [':disabled', ':checked'].includes(name) && value === 'true') {
                  return [[name.slice(1), true]]
                }
                // Nuxt prose components also consume props such as `to`, `as`, and `copy`.
                // Allow only static Markdown attributes, not arbitrary component props.
                const allowed = markdownAttributes.has(name) || name.startsWith('aria-') || name.startsWith('data-')
                if (!allowed) {
                  return []
                }
                return [[key, value]]
              })
            )
            if (node[0] === 'a') node[1].noPrefetch = true
          }
        )
      }
    }))()
  ]
}
