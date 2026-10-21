import { strict as assert } from 'node:assert'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { test } from 'node:test'
import { fileURLToPath, URL } from 'node:url'

const script = fileURLToPath(new URL('../require-rust', import.meta.url))

function fixture(t, tools) {
  const directory = mkdtempSync(join(tmpdir(), 'keundal-rust-prerequisite-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  for (const [tool, status] of Object.entries(tools)) {
    writeFileSync(join(directory, tool), `#!/bin/bash\nexit ${status}\n`, { mode: 0o755 })
  }
  // No network/install commands are available in this PATH.
  return () => spawnSync('/bin/bash', [script], { env: { ...process.env, PATH: directory }, encoding: 'utf8' })
}

test('Rust가 없으면 설치 명령을 실행하지 않고 준비 방법을 안내한다', (t) => {
  const result = fixture(t, {})()
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Rust prerequisite unavailable: rustc/)
  assert.match(result.stderr, /Provision a trusted Rust toolchain/)
})

test('rustc만 있고 cargo가 없으면 실패한다', (t) => {
  const result = fixture(t, { rustc: 0 })()
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Rust prerequisite unavailable: cargo/)
})

test('실행할 수 없는 Rust 도구 체인은 거부한다', (t) => {
  const result = fixture(t, { rustc: 1, cargo: 0 })()
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Rust prerequisite unavailable: rustc/)
})

test('이미 준비된 Rust는 네트워크나 설치 명령 없이 반복 확인한다', (t) => {
  const run = fixture(t, { rustc: 0, cargo: 0 })
  assert.equal(run().status, 0)
  assert.equal(run().status, 0)
})

test('설정 스크립트와 Rust 검사 스크립트의 셸 문법이 유효하다', () => {
  execFileSync('/bin/bash', ['-n', fileURLToPath(new URL('../setup', import.meta.url))])
  execFileSync('/bin/bash', ['-n', script])
})
