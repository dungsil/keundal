import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import { checkWorkspaceBoundaries } from '../check.mjs'

async function fixture(t: TestContext, files: Record<string, unknown>) {
  const root = await mkdtemp(join(tmpdir(), 'keundal-boundaries-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const manifests = {
    'apps/alpha/package.json': { name: '@fixture/alpha' },
    'apps/beta/package.json': { name: '@fixture/beta' },
    'packages/shared/package.json': { name: '@fixture/shared' }
  }
  for (const [file, content] of Object.entries({ ...manifests, ...files })) {
    await mkdir(join(root, file, '..'), { recursive: true })
    await writeFile(join(root, file), typeof content === 'string' ? content : JSON.stringify(content))
  }
  return root
}

test('앱은 공용 패키지와 자기 앱의 소스를 참조할 수 있다', async (t) => {
  const root = await fixture(t, {
    'apps/alpha/package.json': { name: '@fixture/alpha', dependencies: { '@fixture/shared': 'workspace:*' } },
    'apps/alpha/nuxt.config.ts': "export default { extends: ['@fixture/shared'] }",
    'apps/alpha/app.vue': '<script setup>import x from "./local"</script>',
    'packages/shared/index.ts': 'export const value = 1'
  })
  assert.deepEqual(await checkWorkspaceBoundaries(root), [])
})

test('모든 의존성 구역에서 앱 의존성과 별칭을 거부한다', async (t) => {
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const root = await fixture(t, {
      'apps/alpha/package.json': {
        name: '@fixture/alpha',
        [field]: { '@fixture/beta': 'workspace:*', alias: 'workspace:@fixture/beta@*' }
      }
    })
    assert.equal((await checkWorkspaceBoundaries(root)).length, 2)
  }
})

test('상대 경로와 Nuxt 상속, 동적 import, 재노출로 앱 경계를 우회할 수 없다', async (t) => {
  const root = await fixture(t, {
    'apps/alpha/nuxt.config.ts': "export default { extends: ['../beta'] }",
    'apps/alpha/app.vue': '<script setup>import x from "../beta/code"</script>',
    'packages/shared/index.ts': "export * from '../../apps/beta/code'; const x = import('@fixture/alpha/code')",
    'packages/shared/tsconfig.json': { compilerOptions: { paths: { '#other': ['../../apps/beta/*'] } } }
  })
  assert.equal((await checkWorkspaceBoundaries(root)).length, 5)
})

test('Vue script 태그의 대소문자가 달라도 다른 앱의 참조를 거부한다', async (t) => {
  for (const [opening, closing] of [
    ['script', 'script'],
    ['SCRIPT', 'SCRIPT'],
    ['ScRiPt', 'sCrIpT']
  ]) {
    const root = await fixture(t, {
      'apps/alpha/app.vue': `<${opening} setup>import x from "@fixture/beta/code"</${closing}>`
    })
    assert.deepEqual(await checkWorkspaceBoundaries(root), [
      `${join('apps', 'alpha', 'app.vue')}: @fixture/beta/code references app @fixture/beta`
    ])
  }
})

test('Vue script 닫는 태그에 공백이 있어도 각 스크립트의 앱 참조를 거부한다', async (t) => {
  for (const whitespace of [' ', '\t', '\n', '\r', '\f', ' \t\r\n\f ']) {
    const root = await fixture(t, {
      'apps/alpha/app.vue': [
        `<script>import x from "@fixture/beta/code"</script${whitespace}>`,
        '<template><div /></template>',
        `<ScRiPt setup>import y from "@fixture/beta/setup"</sCrIpT${whitespace}>`
      ].join('\n')
    })
    assert.deepEqual(await checkWorkspaceBoundaries(root), [
      `${join('apps', 'alpha', 'app.vue')}: @fixture/beta/code references app @fixture/beta`,
      `${join('apps', 'alpha', 'app.vue')}: @fixture/beta/setup references app @fixture/beta`
    ])
  }
})

test('Vue script 닫는 태그에 속성이나 슬래시가 있어도 앱 참조를 거부한다', async (t) => {
  for (const ending of [' foo="bar"', '/', ' /', ' foo="bar"/']) {
    const root = await fixture(t, {
      'apps/alpha/app.vue': `<script setup>import x from "@fixture/beta/code"</script${ending}>`
    })
    assert.deepEqual(await checkWorkspaceBoundaries(root), [
      `${join('apps', 'alpha', 'app.vue')}: @fixture/beta/code references app @fixture/beta`
    ])
  }
})

test('script와 이름이 비슷한 문자열 뒤의 앱 참조도 검사한다', async (t) => {
  for (const name of ['script-foo', 'script:foo', 'script.foo', 'script_foo', 'scripture']) {
    const root = await fixture(t, {
      'apps/alpha/app.vue': `<script setup>const marker = "</${name}>"; import x from "@fixture/beta/code";</script>`
    })
    assert.deepEqual(await checkWorkspaceBoundaries(root), [
      `${join('apps', 'alpha', 'app.vue')}: @fixture/beta/code references app @fixture/beta`
    ])
  }
})

test('패키지에서 앱을 참조하거나 스크립트로 다른 앱을 실행하면 실패한다', async (t) => {
  const root = await fixture(t, {
    'packages/shared/package.json': { name: '@fixture/shared', dependencies: { '@fixture/alpha': 'workspace:*' } },
    'apps/alpha/package.json': { name: '@fixture/alpha', scripts: { build: 'pnpm --filter @fixture/beta build' } }
  })
  assert.equal((await checkWorkspaceBoundaries(root)).length, 2)
})

test('file과 link, workspace 상대 경로로 앱 의존성을 선언하면 실패한다', async (t) => {
  for (const protocol of ['file:', 'link:', 'workspace:']) {
    const root = await fixture(t, {
      'apps/alpha/package.json': { name: '@fixture/alpha', dependencies: { alias: `${protocol}../beta` } }
    })
    assert.equal((await checkWorkspaceBoundaries(root)).length, 1)
  }
})

test('baseUrl과 상속한 paths 별칭으로 앱 경계를 우회할 수 없다', async (t) => {
  const root = await fixture(t, {
    'packages/shared/tsconfig.base.json': {
      compilerOptions: { baseUrl: '../..', paths: { '@other/*': ['apps/beta/*'] } }
    },
    'apps/alpha/tsconfig.json': { extends: '../../packages/shared/tsconfig.base.json' },
    'apps/alpha/index.ts': "import '@other/index'"
  })
  const errors = await checkWorkspaceBoundaries(root)
  assert.equal(errors.length, 2)
  assert.ok(errors.some((error) => error.startsWith(`${join('apps', 'alpha', 'tsconfig.json')}:`)))
})

test('계약과 공통 UI는 구현 패키지를 실행 의존성으로 가져올 수 없다', async (t) => {
  for (const [contract, provider] of [
    ['@keundal/chat-app', '@keundal/plugin-chat-local'],
    ['@keundal/ui', '@keundal/plugin-chat-browser'],
    ['@keundal/ui-chat', '@keundal/plugin-store-memory'],
    ['@keundal/llm', '@keundal/plugin-llm-openai'],
    ['@keundal/session', '@keundal/plugin-store-memory'],
    ['@keundal/generation', '@keundal/plugin-store-sqlite'],
    ['@keundal/skill', '@keundal/plugin-skill'],
    ['@keundal/compaction', '@keundal/plugin-agent-chat'],
    ['@keundal/trace', '@keundal/plugin-store-indexeddb'],
    ['@keundal/prompt', '@keundal/plugin-agent-chat'],
    ['@keundal/subagent', '@keundal/plugin-agent-chat'],
    ['@keundal/agent', '@keundal/agent-loop'],
    ['@keundal/tools', '@keundal/plugin-tool-fs'],
    ['@keundal/context', '@keundal/plugin-context-node'],
    ['@keundal/mcp', '@keundal/plugin-mcp-client'],
    ['@keundal/llm-settings', '@keundal/plugin-llm-openai'],
    ['@keundal/agent-loop', '@keundal/plugin-agent-chat']
  ]) {
    const root = await fixture(t, {
      'packages/shared/package.json': { name: contract, dependencies: { [provider!]: 'workspace:*' } },
      'packages/provider/package.json': { name: provider },
      'packages/shared/app/plugin.ts': `import '${provider}'`,
      'packages/shared/src/escape.ts': "export * from '../../provider/src/index'"
    })
    assert.equal((await checkWorkspaceBoundaries(root)).length, 3, contract)
  }
})

test('계약의 통합 테스트와 앱 조립 지점은 구현 패키지를 사용할 수 있다', async (t) => {
  const root = await fixture(t, {
    'packages/shared/package.json': {
      name: '@keundal/agent-host',
      devDependencies: { '@keundal/plugin-store-memory': 'workspace:*' }
    },
    'packages/shared/tests/integration.test.ts': "import store from '@keundal/plugin-store-memory'",
    'packages/loop/package.json': { name: '@keundal/agent-loop' },
    'packages/loop/src/index.ts': "export * from './config.js'",
    'apps/alpha/app/platform.ts': "import store from '@keundal/plugin-store-memory'"
  })
  assert.deepEqual(await checkWorkspaceBoundaries(root), [])
})

test('코어는 기능 계약을 다시 내보내거나 실행 의존성으로 가져올 수 없다', async (t) => {
  const root = await fixture(t, {
    'packages/shared/package.json': { name: '@keundal/core', dependencies: { '@keundal/llm': 'workspace:*' } },
    'packages/llm/package.json': { name: '@keundal/llm' },
    'packages/shared/src/index.ts': "export * from '@keundal/llm'",
    'packages/shared/src/escape.ts': "export * from '../../llm/src/index'",
    'packages/shared/tests/integration.test.ts': "import '@keundal/llm'"
  })
  const errors = await checkWorkspaceBoundaries(root)
  assert.equal(errors.length, 3)
  assert.ok(errors.every((error) => error.endsWith('couples core to a feature package')))
})
