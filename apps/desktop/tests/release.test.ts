import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, type TestContext } from 'vitest'

const script = fileURLToPath(new URL('../scripts/release.mjs', import.meta.url))
const releaseVersion = '1.23.4'
const commit = 'a'.repeat(40)
const credentialNames = [
  'TAURI_UPDATER_PUBLIC_KEY', 'TAURI_SIGNING_PRIVATE_KEY', 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD',
  'WINDOWS_CERTIFICATE', 'WINDOWS_CERTIFICATE_PASSWORD', 'APPLE_CERTIFICATE',
  'APPLE_CERTIFICATE_PASSWORD', 'APPLE_SIGNING_IDENTITY', 'APPLE_ID', 'APPLE_PASSWORD', 'APPLE_TEAM_ID',
]
const environment = Object.fromEntries(credentialNames.map((name) => [name, `test-only-${name}`]))
environment.WINDOWS_CERTIFICATE_THUMBPRINT = 'B'.repeat(40)
// Explicitly overwrite credentials: tests never use the caller's real signing keys or GitHub token.
environment.GH_TOKEN = 'test-only-token'
const fixtureAssets = {
  'linux-x64': ['Keundal_1.23.4_amd64.AppImage', 'Keundal_1.23.4_amd64.deb'],
  'windows-x64': ['Keundal_1.23.4_x64-setup.exe'],
  'macos-arm64': ['Keundal.app.tar.gz', 'Keundal_1.23.4_aarch64.dmg'],
}

function run(args: string[], env: NodeJS.ProcessEnv = {}, preload?: string) {
  return spawnSync(process.execPath, [...(preload ? ['--import', preload] : []), script, ...args], {
    encoding: 'utf8', env: { ...process.env, ...environment, ...env },
  })
}

async function temporary(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'keundal-release-'))
  t.onTestFinished(() => rm(root, { recursive: true, force: true }))
  return root
}

async function fixture(t: TestContext, versioned = false) {
  const root = await temporary(t)
  const assets = join(root, 'assets')
  await mkdir(assets)
  for (const [name, filenames] of Object.entries(fixtureAssets)) {
    await mkdir(join(assets, name))
    for (const filename of filenames) await writeFile(join(assets, name, filename), `binary-${name}`)
    const signature = versioned
      ? Buffer.from(`untrusted comment: test\nunit-test-signature\ntrusted comment: timestamp:1\tfile:${filenames[0]}\tversion:${releaseVersion}\nunit-test-global-signature\n`).toString('base64')
      : `signature-content-${name}\n`
    await writeFile(join(assets, name, `${filenames[0]}.sig`), signature)
  }
  return { root, assets }
}

function success(result: ReturnType<typeof run>) {
  assert.equal(result.status, 0, result.stderr)
}

test('정상 버전과 모든 서명 자격 증명이 있으면 검증한다', () => {
  const result = run(['validate', releaseVersion])
  success(result)
  assert.match(result.stdout, /desktop-v1\.23\.4/)
})

test('접두사와 선행 0과 사전 배포와 명령 삽입이 있는 버전을 거부한다', async (t) => {
  const root = await temporary(t)
  for (const value of ['v1.2.3', '01.2.3', '1.2', '1.2.3-beta.1', '1.2.3+build', '1.2.3\n', '1.2.3; echo injected', '65536.0.0', '']) {
    const output = join(root, 'config.json')
    const result = run(['config', value, 'linux-x64', output])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /Expected a stable version/)
    assert.equal(existsSync(output), false)
  }
})

test.each(credentialNames)('%s 누락 시 값은 출력하지 않고 중단한다', (name) => {
  const result = run(['validate', releaseVersion], { [name]: '   ' })
  assert.equal(result.status, 1)
  assert.ok(result.stderr.includes(name))
  assert.ok(!`${result.stdout}${result.stderr}`.includes('test-only-'))
})

test('macOS 임시 서명 identity는 정식 릴리스에서 거부한다', () => {
  const result = run(['validate', releaseVersion], { APPLE_SIGNING_IDENTITY: '-' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Ad-hoc/)
})

test('플랫폼별 별도 설정에 버전과 공개 키와 고정 주소를 주입한다', async (t) => {
  const root = await temporary(t)
  for (const [name, targets] of [['linux-x64', ['deb', 'appimage']], ['windows-x64', ['nsis']], ['macos-arm64', ['app', 'dmg']]] as const) {
    const output = join(root, `${name}.json`)
    success(run(['config', '2.3.4', name, output]))
    const serialized = await readFile(output, 'utf8')
    const config = JSON.parse(serialized)
    assert.equal(config.version, '2.3.4')
    assert.equal(config.bundle.active, true)
    assert.equal(config.bundle.createUpdaterArtifacts, true)
    assert.deepEqual(config.bundle.targets, targets)
    assert.equal(config.build.beforeBuildCommand, '')
    assert.deepEqual(config.plugins.updater, {
      pubkey: environment.TAURI_UPDATER_PUBLIC_KEY,
      endpoints: ['https://github.com/dungsil/keundal/releases/latest/download/latest.json'],
      requireSignedVersion: true,
    })
    assert.ok(!serialized.includes(environment.TAURI_SIGNING_PRIVATE_KEY))
    assert.ok(!serialized.includes(environment.APPLE_PASSWORD))
    if (name === 'windows-x64') {
      assert.equal(config.bundle.windows.certificateThumbprint, environment.WINDOWS_CERTIFICATE_THUMBPRINT)
      assert.equal(config.bundle.windows.digestAlgorithm, 'sha256')
      assert.equal(config.bundle.windows.tsp, true)
    }
    if (name === 'macos-arm64') assert.equal(config.bundle.macOS.entitlements, 'Entitlements.plist')
  }
})

test('공개 키 또는 Windows 인증서 지문이 없으면 설정 파일을 만들지 않는다', async (t) => {
  const root = await temporary(t)
  for (const name of ['TAURI_UPDATER_PUBLIC_KEY', 'WINDOWS_CERTIFICATE_THUMBPRINT']) {
    const output = join(root, `${name}.json`)
    const result = run(['config', releaseVersion, 'windows-x64', output], { [name]: '' })
    assert.equal(result.status, 1)
    assert.equal(existsSync(output), false)
  }
})

test('세 플랫폼의 비대칭 업데이트 파일과 실제 서명 내용으로 manifest를 만든다', async (t) => {
  const { assets } = await fixture(t)
  const oldName = fixtureAssets['windows-x64'][0]
  const newName = 'Keundal setup #1.exe'
  await rename(join(assets, 'windows-x64', oldName), join(assets, 'windows-x64', newName))
  await rename(join(assets, 'windows-x64', `${oldName}.sig`), join(assets, 'windows-x64', `${newName}.sig`))
  success(run(['manifest', '7.8.9', assets]))
  const manifest = JSON.parse(await readFile(join(assets, 'latest.json'), 'utf8'))
  assert.equal(manifest.version, '7.8.9')
  assert.deepEqual(manifest.platforms, {
    'linux-x86_64': { signature: 'signature-content-linux-x64', url: 'https://github.com/dungsil/keundal/releases/download/desktop-v7.8.9/Keundal_1.23.4_amd64.AppImage' },
    'windows-x86_64': { signature: 'signature-content-windows-x64', url: 'https://github.com/dungsil/keundal/releases/download/desktop-v7.8.9/Keundal%20setup%20%231.exe' },
    'darwin-aarch64': { signature: 'signature-content-macos-arm64', url: 'https://github.com/dungsil/keundal/releases/download/desktop-v7.8.9/Keundal.app.tar.gz' },
  })
})

const missingTargets = Object.entries(fixtureAssets).flatMap(([name, filenames]) => [
  name, join(name, filenames[0]), join(name, `${filenames[0]}.sig`),
  ...(filenames[1] ? [join(name, filenames[1])] : [])
])

for (const target of missingTargets) {
  test(`${target} 누락 시 manifest를 만들지 않는다`, async (t) => {
    const { assets } = await fixture(t)
    await rm(join(assets, target), { recursive: true })
    assert.equal(run(['manifest', releaseVersion, assets]).status, 1)
    assert.equal(existsSync(join(assets, 'latest.json')), false)
  })
}

for (const kind of ['asset', 'signature', 'mismatch', 'empty', 'empty-binary', 'unknown']) {
  test(`${kind} 파일 조합을 거부한다`, async (t) => {
    const { assets } = await fixture(t)
    const directory = join(assets, 'linux-x64')
    if (kind === 'asset') await writeFile(join(directory, 'duplicate.AppImage'), 'duplicate')
    if (kind === 'signature') await writeFile(join(directory, 'duplicate.AppImage.sig'), 'duplicate')
    if (kind === 'mismatch') await rename(join(directory, `${fixtureAssets['linux-x64'][0]}.sig`), join(directory, 'other.AppImage.sig'))
    if (kind === 'empty') await writeFile(join(directory, `${fixtureAssets['linux-x64'][0]}.sig`), ' \n')
    if (kind === 'empty-binary') await writeFile(join(directory, fixtureAssets['linux-x64'][0]), '')
    if (kind === 'unknown') await writeFile(join(directory, 'unexpected.zip'), 'unexpected')
    assert.equal(run(['manifest', releaseVersion, assets]).status, 1)
    assert.equal(existsSync(join(assets, 'latest.json')), false)
  })
}

test('번들에서 업데이트 파일과 서명과 설치 파일만 모은다', async (t) => {
  const { root, assets } = await fixture(t)
  const source = join(assets, 'macos-arm64')
  const app = join(source, 'Keundal.app', 'Contents')
  await mkdir(app, { recursive: true })
  await writeFile(join(app, 'ignored.exe'), 'nested bundle executable')
  await writeFile(join(source, 'ignored.txt'), 'bundler intermediate')
  const destination = join(root, 'collected')
  success(run(['collect', releaseVersion, 'macos-arm64', source, destination]))
  assert.deepEqual((await readdir(destination)).sort(), [...fixtureAssets['macos-arm64'], 'Keundal.app.tar.gz.sig'].sort())
})

// Transport/unit tests replace fetch and the verifier subprocess; no test can contact GitHub.
async function mockGitHub(root: string, scenario: string) {
  const preload = join(root, 'mock-github.mjs')
  const log = join(root, 'requests.jsonl')
  await writeFile(preload, `
    import { appendFileSync } from 'node:fs'
    import childProcess from 'node:child_process'
    import { syncBuiltinESMExports } from 'node:module'
    const scenario = ${JSON.stringify(scenario)}
    const original = childProcess.spawnSync
    childProcess.spawnSync = (command, ...args) => command === 'minisign' ? { status: scenario === 'bad-signature' ? 1 : 0 } : original(command, ...args)
    syncBuiltinESMExports()
    globalThis.fetch = async (url, options = {}) => {
      const method = options.method ?? 'GET'
      const body = options.body instanceof Blob ? await options.body.text() : options.body
      appendFileSync(${JSON.stringify(log)}, JSON.stringify({ url, method, body }) + '\\n')
      const scenario = ${JSON.stringify(scenario)}
      if (scenario === 'lookup-failure') return Response.json({}, { status: 403 })
      if (url.includes('/releases/tags/desktop-v')) return Response.json({}, { status: scenario === 'published' ? 200 : 404 })
      if (url.includes('per_page=') && scenario === 'paged-draft') return Response.json(url.endsWith('page=1') ? Array.from({ length: 100 }, (_, i) => ({ tag_name: 'other-' + i })) : [{ tag_name: 'desktop-v1.23.4', draft: true }])
      if (url.includes('per_page=')) return Response.json(scenario === 'draft' ? [{ tag_name: 'desktop-v1.23.4', draft: true }] : [])
      if (url.includes('/git/ref/') && scenario === 'different-commit') return Response.json({ object: { type: 'commit', sha: 'b'.repeat(40) } })
      if (url.includes('/git/ref/')) return Response.json({}, { status: 404 })
      if (method === 'POST' && url === 'https://api.github.com/repos/dungsil/keundal/releases') return Response.json({ id: 123, draft: true })
      if (url.startsWith('https://uploads.github.com/repos/dungsil/keundal/releases/123/assets?')) return Response.json({}, { status: scenario === 'upload-failure' ? 500 : 201 })
      throw new Error('Unexpected mocked GitHub request')
    }
  `)
  return { preload, log }
}

test('기존 공개 릴리스와 기존 draft에는 쓰기 요청을 보내지 않는다', async (t) => {
  for (const scenario of ['published', 'draft', 'paged-draft']) {
    const { root, assets } = await fixture(t, true)
    const { preload, log } = await mockGitHub(root, scenario)
    const result = run(['draft', releaseVersion, assets, commit], {}, preload)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /Release already exists/)
    const requests = (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    assert.ok(requests.every((request) => request.method === 'GET'))
  }
})

test('조회 권한 오류와 다른 commit의 태그가 있으면 쓰기 요청 없이 중단한다', async (t) => {
  for (const scenario of ['lookup-failure', 'different-commit']) {
    const { root, assets } = await fixture(t, true)
    const { preload, log } = await mockGitHub(root, scenario)
    const result = run(['draft', releaseVersion, assets, commit], {}, preload)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /lookup failed|build commit/)
    const requests = (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    assert.ok(requests.every((request) => request.method === 'GET'))
  }
})

test('플랫폼 파일이 불완전하면 GitHub에 연결하기 전에 draft 생성을 거부한다', async (t) => {
  const { root, assets } = await fixture(t)
  const { preload, log } = await mockGitHub(root, 'new')
  await rm(join(assets, 'macos-arm64'), { recursive: true })
  assert.equal(run(['draft', releaseVersion, assets, commit], {}, preload).status, 1)
  assert.equal(existsSync(log), false)
})

test('검증한 버전과 commit으로 draft만 만들고 모든 파일을 새 ID에 업로드한다', async (t) => {
  const { root, assets } = await fixture(t, true)
  const { preload, log } = await mockGitHub(root, 'new')
  success(run(['draft', releaseVersion, assets, commit], {}, preload))
  const requests = (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
  const mutations = requests.filter((request) => request.method !== 'GET')
  assert.deepEqual(JSON.parse(mutations[0].body), {
    tag_name: 'desktop-v1.23.4', target_commitish: commit, name: 'Keundal 1.23.4', draft: true, prerelease: false,
  })
  const uploads = mutations.slice(1)
  assert.equal(uploads.length, 9)
  assert.ok(uploads.every((request) => request.url.startsWith('https://uploads.github.com/repos/dungsil/keundal/releases/123/assets?name=') && request.method === 'POST'))
  const manifest = uploads.find((request) => request.url.endsWith('name=latest.json'))
  assert.equal(JSON.parse(manifest.body).version, releaseVersion)
  assert.equal(uploads.find((request) => request.url.endsWith('.AppImage.sig')).body, await readFile(join(assets, 'linux-x64', `${fixtureAssets['linux-x64'][0]}.sig`), 'utf8'))
})

test('업로드 실패 시 draft를 게시하거나 수정하거나 자동 재시도하지 않는다', async (t) => {
  const { root, assets } = await fixture(t, true)
  const { preload, log } = await mockGitHub(root, 'upload-failure')
  const result = run(['draft', releaseVersion, assets, commit], {}, preload)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /incomplete draft requires manual cleanup/)
  const requests = (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
  assert.equal(requests.filter((request) => request.method === 'POST').length, 2)
  assert.equal(requests.some((request) => ['PATCH', 'DELETE'].includes(request.method)), false)
})

test('서명 검증 실패와 서명된 버전 불일치 시 GitHub에 연결하지 않는다', async (t) => {
  for (const scenario of ['bad-signature', 'wrong-version']) {
    const { root, assets } = await fixture(t, true)
    const { preload, log } = await mockGitHub(root, scenario)
    const result = run(['draft', scenario === 'wrong-version' ? '1.23.5' : releaseVersion, assets, commit], {}, preload)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /signature verification failed|Signed updater version/)
    assert.equal(existsSync(log), false)
  }
})
