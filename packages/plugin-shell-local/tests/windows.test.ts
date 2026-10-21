import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'

import { LocalShellService } from '@keundal/plugin-shell-local'
import { Context } from 'cordis'
import { afterEach, expect, test, vi } from 'vitest'

vi.mock('node:process', async (importOriginal) => {
  const actual = await importOriginal<{ default: NodeJS.Process }>()
  return { default: { ...actual.default, platform: 'win32' } }
})
vi.mock('node:child_process', () => ({ spawn: vi.fn() }))

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

async function setup() {
  const cwd = await mkdtemp(join(tmpdir(), 'keundal-windows-shell-'))
  vi.stubEnv('SystemRoot', 'C:\\Windows')
  vi.stubEnv('ComSpec', undefined)
  // Both search locations are attacker-controlled; no bare executable may reach spawn.
  vi.stubEnv('PATH', cwd)
  const spawnMock = vi.mocked(spawn)
  spawnMock.mockImplementation((file) => {
    const child = Object.assign(new EventEmitter(), {
      pid: 1234,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
      unref: vi.fn()
    })
    if (!String(file).endsWith('taskkill.exe')) queueMicrotask(() => child.emit('exit', 0, null))
    return child as unknown as ReturnType<typeof spawn>
  })
  return { cwd, spawnMock, cleanup: () => rm(cwd, { recursive: true, force: true }) }
}

for (const comspec of [undefined, 'D:\\System Tools\\cmd.exe', '\\\\server\\system\\cmd.exe']) {
  test(`ComSpec ${String(comspec)}에서 검색 경로를 거치지 않고 셸과 정리 도구를 실행한다`, async (t) => {
    const { cwd, spawnMock, cleanup } = await setup()
    t.onTestFinished(cleanup)
    vi.stubEnv('ComSpec', comspec)
    const service = new LocalShellService(new Context(), { cwd, killGraceMs: 1 })
    // Resolve helpers once, before subsequent environment changes or cleanup.
    vi.stubEnv('SystemRoot', cwd)
    const result = await service.execute({ command: 'echo hello' })
    expect(result.exitCode).toBe(0)
    expect(spawnMock.mock.calls[0]).toEqual([
      comspec ?? 'C:\\Windows\\System32\\cmd.exe',
      ['/d', '/s', '/c', 'echo hello'],
      { cwd, detached: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
    ])
    for (const call of spawnMock.mock.calls.slice(1)) {
      expect(call).toEqual([
        'C:\\Windows\\System32\\taskkill.exe',
        ['/PID', '1234', '/T', '/F'],
        { stdio: 'ignore', windowsHide: true }
      ])
    }
    expect(spawnMock).toHaveBeenCalledTimes(3)
  })
}

for (const name of ['SystemRoot', 'ComSpec']) {
  for (const value of ['', 'cmd.exe', 'C:relative', '\\root-relative', '/root-relative']) {
    test(`${name}의 불완전한 경로 ${JSON.stringify(value)}를 실행 전에 거부한다`, async (t) => {
      const { cwd, spawnMock, cleanup } = await setup()
      t.onTestFinished(cleanup)
      vi.stubEnv(name, value)
      expect(() => new LocalShellService(new Context(), { cwd })).toThrow('fully qualified')
      expect(spawnMock).not.toHaveBeenCalled()
    })
  }
}

test('SystemRoot가 없으면 실행 전에 거부한다', async (t) => {
  const { cwd, spawnMock, cleanup } = await setup()
  t.onTestFinished(cleanup)
  vi.stubEnv('SystemRoot', undefined)
  expect(() => new LocalShellService(new Context(), { cwd })).toThrow('SystemRoot')
  expect(spawnMock).not.toHaveBeenCalled()
})

test('명시한 셸은 ComSpec보다 우선하고 정리 도구는 시스템 경로를 사용한다', async (t) => {
  const { cwd, spawnMock, cleanup } = await setup()
  t.onTestFinished(cleanup)
  vi.stubEnv('ComSpec', 'untrusted.exe')
  const service = new LocalShellService(new Context(), { cwd, shell: 'configured-shell.exe', killGraceMs: 1 })
  await service.execute({ command: 'echo hello' })
  expect(spawnMock.mock.calls[0]?.[0]).toBe('configured-shell.exe')
  expect(spawnMock.mock.calls[1]?.[0]).toBe('C:\\Windows\\System32\\taskkill.exe')
})
