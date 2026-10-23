import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { test } from 'node:test'
import { URL } from 'node:url'

const installer = new URL('../install-rust', import.meta.url).pathname
function fixture(architecture, checksumStatus = '0', downloadStatus = '0') {
  const directory = mkdtempSync(join(tmpdir(), 'keundal-rust-test-'))
  const log = join(directory, 'executed')
  const executable = (name, content) => writeFileSync(join(directory, name), '#!/bin/bash\n' + content, { mode: 0o700 })
  executable('uname', `echo '${architecture}'`)
  executable(
    'curl',
    `printf '%s\\n' "$*" >> "$TEST_LOG"
while [[ "$1" != '-o' ]]; do shift; done
printf '#!/bin/bash\\nprintf "executed %%s\\\\n" "$*" >> "$TEST_LOG"\\n' > "$2"
exit "$DOWNLOAD_STATUS"`
  )
  executable('sha256sum', 'cat >> "$TEST_LOG"; exit "$CHECKSUM_STATUS"')
  const result = spawnSync('bash', [installer], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      TEST_LOG: log,
      CHECKSUM_STATUS: checksumStatus,
      DOWNLOAD_STATUS: downloadStatus
    }
  })
  const content = (() => {
    try {
      return readFileSync(log, 'utf8')
    } catch {
      return ''
    }
  })()
  rmSync(directory, { recursive: true, force: true })
  return { result, content }
}

test('설치 스크립트가 Bash 문법 검사를 통과한다', () => {
  execFileSync('bash', ['-n', installer])
})

for (const [architecture, target, digest] of [
  ['x86_64', 'x86_64-unknown-linux-gnu', '5be191e8c70a5007074254cb74d78dbfdd25cd5a61c27de7b8e5410122ec24f4'],
  ['aarch64', 'aarch64-unknown-linux-gnu', 'a9c168dbea81a84671c6b7a5c1795cb0eb699020110d107ddfca427bd797e697']
]) {
  test(`${architecture} 설치는 고정된 다운로드와 해시 검증 뒤에만 실행한다`, () => {
    const { result, content } = fixture(architecture)
    assert.equal(result.status, 0, result.stderr)
    assert.ok(content.includes(`/archive/1.29.2/${target}/rustup-init`))
    assert.ok(content.includes(digest))
    assert.ok(content.indexOf(digest) < content.indexOf('executed'))
    assert.ok(content.includes('executed -y --profile minimal --default-toolchain 1.99.1 --no-modify-path'))
    const path = content.match(/[a-f0-9]{64}  (.+)\/rustup-init/)[1]
    assert.throws(() => readFileSync(join(path, 'rustup-init')), { code: 'ENOENT' })
  })
}

test('변조된 다운로드는 체크섬 검증 실패 후 실행하지 않는다', () => {
  const { result, content } = fixture('x86_64', '1')
  assert.notEqual(result.status, 0)
  assert.ok(!content.includes('executed'))
})

test('다운로드 실패와 지원하지 않는 아키텍처에서는 실행하지 않는다', () => {
  for (const { result, content } of [fixture('x86_64', '0', '22'), fixture('riscv64')]) {
    assert.notEqual(result.status, 0)
    assert.ok(!content.includes('executed'))
  }
})
