import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import localShellPlugin, { LocalShellService, type LocalShellConfig } from '@keundal/plugin-shell-local'
import { Context } from 'cordis'
import { expect, test, type TestContext } from 'vitest'

async function setup(t: TestContext, config: Partial<LocalShellConfig> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'keundal-shell-'))
  const cwd = join(dir, 'root')
  await mkdir(cwd)
  const ctx = new Context()
  const provider = await ctx.plugin(localShellPlugin, { cwd, killGraceMs: 50, ...config })
  t.onTestFinished(async () => {
    await provider.dispose()
    await rm(dir, { recursive: true, force: true })
  })
  return { ctx, cwd, dir, provider }
}

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
const node = (code: string, ...args: string[]) =>
  [quote(process.execPath), '-e', quote(code), '--', ...args.map(quote)].join(' ')

test.skipIf(process.platform === 'win32')('stdout과 stderr를 수집하고 비정상 종료 코드를 보존한다', async (t) => {
  const { ctx } = await setup(t)
  expect(ctx.shell).toBeInstanceOf(LocalShellService)
  const result = await ctx.shell.execute({ command: 'printf hello; printf error >&2; exit 7' })
  expect(result).toEqual({
    stdout: 'hello',
    stderr: 'error',
    exitCode: 7,
    signal: null,
    timedOut: false,
    aborted: false,
    truncated: false
  })
})

test.skipIf(process.platform === 'win32')(
  '작업 디렉터리를 정규화하고 외부 경로와 심볼릭 링크를 거부한다',
  async (t) => {
    const { ctx, cwd, dir } = await setup(t)
    await mkdir(join(cwd, 'sub'))
    await symlink(dir, join(cwd, 'escape'))
    expect((await ctx.shell.execute({ command: 'pwd', cwd: 'sub/..' })).stdout.trim()).toBe(cwd)
    for (const target of ['..', dir, 'escape']) {
      await expect(ctx.shell.execute({ command: 'true', cwd: target })).rejects.toThrow('outside')
    }
  }
)

test.skipIf(process.platform === 'win32')('각 출력의 바이트 한도를 지키고 남은 출력을 계속 소비한다', async (t) => {
  const { ctx } = await setup(t, { maxOutputBytes: 5 })
  const result = await ctx.shell.execute({
    command: node("process.stdout.write('가'.repeat(100000)); process.stderr.write('x'.repeat(100000))")
  })
  expect(result.stdout).toBe('가')
  expect(result.stderr).toBe('xxxxx')
  expect(result.truncated).toBe(true)
  expect(result.exitCode).toBe(0)
  const invalidUtf8 = await ctx.shell.execute({ command: node('process.stdout.write(Buffer.alloc(5, 255))') })
  expect(Buffer.byteLength(invalidUtf8.stdout)).toBeLessThanOrEqual(5)
  expect(invalidUtf8.truncated).toBe(true)
})

test('잘못된 설정과 요청 및 실행 전 취소를 거부한다', async (t) => {
  const { ctx, cwd } = await setup(t, { timeoutMs: 500 })
  for (const config of [
    { cwd: '' },
    { cwd, timeoutMs: 0 },
    { cwd, shell: '' },
    { cwd, maxOutputBytes: -1 },
    { cwd, killGraceMs: NaN }
  ]) {
    expect(() => new LocalShellService(new Context(), config)).toThrow()
  }
  for (const request of [
    { command: '' },
    { command: 'true', timeoutMs: 501 },
    { command: 'true', timeoutMs: NaN },
    { command: 'true', cwd: '' }
  ]) {
    await expect(ctx.shell.execute(request)).rejects.toThrow()
  }
  await expect(
    ctx.shell.execute({ command: 'true' }, { signal: AbortSignal.abort(new Error('before spawn')) })
  ).rejects.toThrow('before spawn')
})

async function waitPid(path: string) {
  for (let i = 0; i < 300; i++) {
    let text: string | undefined
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (text?.endsWith('\n')) {
      const pid = Number(text)
      if (!/^[1-9]\d*\n$/.test(text) || !Number.isSafeInteger(pid) || pid <= 1) {
        throw new Error('invalid child pid')
      }
      return pid
    }
    await delay(10)
  }
  throw new Error('child did not start')
}

test('PID 파일이 비어 있거나 일부만 기록되면 완성된 PID를 기다린다', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'keundal-pid-'))
  t.onTestFinished(() => rm(dir, { recursive: true, force: true }))
  const marker = join(dir, 'pid')
  await writeFile(marker, '')
  let resolved = false
  const pending = waitPid(marker).then((pid) => {
    resolved = true
    return pid
  })
  await delay(30)
  expect(resolved).toBe(false)
  await writeFile(marker, '123')
  await delay(30)
  expect(resolved).toBe(false)
  await writeFile(marker, '12345\n')
  expect(await pending).toBe(12345)
})

test.for(['0\n', '1\n', '-1\n', '1.5\n', 'NaN\n', '9007199254740992\n'])(
  '종료 대상이 될 수 없는 PID %s를 거부한다',
  async (contents, t) => {
    const dir = await mkdtemp(join(tmpdir(), 'keundal-pid-'))
    t.onTestFinished(() => rm(dir, { recursive: true, force: true }))
    const marker = join(dir, 'pid')
    await writeFile(marker, contents)
    await expect(waitPid(marker)).rejects.toThrow('invalid child pid')
  }
)

async function assertDead(pid: number) {
  for (let i = 0; i < 100; i++) {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
      if (stat.split(' ')[2] === 'Z') return
    } catch {
      return
    }
    await delay(10)
  }
  throw new Error(`descendant ${pid} still alive`)
}

for (const mode of ['timeout', 'cancel', 'dispose', 'exit'] as const) {
  test.skipIf(process.platform !== 'linux')(
    `${mode} 이후 TERM을 무시하는 자손을 종료하고 상속된 파이프를 정리한다`,
    async (t) => {
      const { ctx, cwd, provider } = await setup(t, { timeoutMs: 3000 })
      const marker = join(cwd, 'pid \'"$`\n한글')
      const child = node(
        "process.on('SIGTERM',()=>{}); const fs=require('fs'); fs.writeFileSync(process.argv[1]+'.tmp', process.pid+'\\n'); fs.renameSync(process.argv[1]+'.tmp', process.argv[1]); setInterval(()=>{},1000)",
        marker
      )
      const controller = new AbortController()
      const command =
        mode === 'exit' ? `${child} & while [ ! -f ${quote(marker)} ]; do sleep 0.01; done; exit 0` : `${child} & wait`
      const pending = ctx.shell.execute(
        { command, ...(mode === 'timeout' ? { timeoutMs: 700 } : {}) },
        { signal: controller.signal }
      )
      const retained = ctx.shell
      const pid = await waitPid(marker)
      t.onTestFinished(() => {
        if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error('invalid child pid')
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          /* already exited */
        }
      })
      if (mode === 'cancel') controller.abort()
      if (mode === 'dispose') await provider.dispose()
      const result = await pending
      expect(result.timedOut).toBe(mode === 'timeout')
      expect(result.aborted).toBe(mode === 'cancel' || mode === 'dispose')
      await assertDead(pid)
      if (mode === 'dispose') await expect(retained.execute({ command: 'true' })).rejects.toThrow('disposed')
    }
  )
}

test.skipIf(process.platform === 'win32')('설정한 실행 파일의 시작 오류를 예외로 전달한다', async (t) => {
  const { ctx } = await setup(t, { shell: '/does/not/exist' })
  await expect(ctx.shell.execute({ command: 'true' })).rejects.toThrow()
})
