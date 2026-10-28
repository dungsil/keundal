import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import {
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { LinuxSandboxProvider } from '@keundal/plugin-sandbox-linux'
import type { SandboxProcessRequest } from '@keundal/sandbox'
import { describe, expect, test, type TestContext } from 'vitest'

function setup(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'keundal-sandbox-')))
  const workspace = join(root, 'workspace')
  mkdirSync(workspace)
  t.onTestFinished(() => rmSync(root, { recursive: true, force: true }))
  const request: SandboxProcessRequest = {
    executable: process.execPath,
    args: [],
    policy: { workspace },
    environment: {},
    mounts: []
  }
  const provider = new LinuxSandboxProvider()
  const run = (code: string, changes: Partial<SandboxProcessRequest> = {}) =>
    collect(provider.start({ ...request, ...changes, args: ['--input-type=module', '--eval', code] }))
  return { root, workspace, request, provider, run }
}

function collect(child: ChildProcessWithoutNullStreams): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (data) => {
      stdout += data
    })
    child.stderr.setEncoding('utf8').on('data', (data) => {
      stderr += data
    })
    child.on('error', reject)
    child.on('close', (code, signal) => {
      if (code === 0) resolve(stdout)
      else reject(new Error(`Sandbox failed: code=${code}, signal=${signal}, stderr=${stderr}`))
    })
    child.stdin.end()
  })
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return
    await delay(25)
  }
  throw new Error('Timed out waiting for sandbox process')
}

describe.skipIf(process.platform !== 'linux')('LinuxSandboxProvider 실제 격리', () => {
  test('작업공간과 읽기·쓰기 권한의 기존 하드링크와 호스트 Unix 소켓을 거부한다', async (t) => {
    const { root, workspace, request, provider } = setup(t)
    const secret = join(root, 'secret')
    const grant = join(root, 'grant')
    mkdirSync(grant)
    writeFileSync(secret, 'outside-secret')
    for (const path of [workspace, grant]) {
      const alias = join(path, 'alias')
      linkSync(secret, alias)
      const policy = path === workspace ? request.policy : { ...request.policy, readOnlyPaths: [path] }
      expect(() => provider.start({ ...request, policy })).toThrow(/hardlink/)
      if (path === grant) {
        expect(() => provider.start({ ...request, policy: { ...request.policy, writablePaths: [path] } })).toThrow(
          /hardlink/
        )
      }
      rmSync(alias)
      const socket = createServer().listen(alias)
      await once(socket, 'listening')
      try {
        expect(() => provider.start({ ...request, policy })).toThrow(/special file/)
        if (path === grant) {
          expect(() => provider.start({ ...request, policy: { ...request.policy, writablePaths: [path] } })).toThrow(
            /special file/
          )
        }
      } finally {
        await new Promise<void>((resolve) => socket.close(() => resolve()))
      }
    }
    expect(readFileSync(secret, 'utf8')).toBe('outside-secret')
  })

  test('신뢰한 호스트 코드와 정책을 포함하거나 그 안에 있는 쓰기 권한을 거부한다', (t) => {
    const { root, workspace, request, provider } = setup(t)
    const policyFile = join(workspace, 'policy.json')
    writeFileSync(policyFile, '{}')
    expect(() => provider.start({ ...request, protectedPaths: [policyFile] })).toThrow(/trusted parent/)
    expect(() => provider.start({ ...request, protectedPaths: [root] })).toThrow(/trusted parent/)
    const trusted = join(root, 'trusted')
    mkdirSync(trusted)
    expect(() =>
      provider.start({
        ...request,
        protectedPaths: [trusted],
        policy: {
          ...request.policy,
          writablePaths: [trusted]
        }
      })
    ).toThrow(/trusted parent/)
  })

  test('workspace 쓰기는 허용하고 외부 파일·상위 경로·심볼릭 링크 읽기와 쓰기를 차단한다', async (t) => {
    const { root, workspace, run } = setup(t)
    const secret = join(root, 'secret')
    writeFileSync(secret, 'outside-secret')
    symlinkSync(secret, join(workspace, 'escape'))
    const result = JSON.parse(
      await run(`
      import fs from 'node:fs';
      const denied = [];
      for (const path of ${JSON.stringify([secret, '../secret', 'escape'])}) {
        for (const operation of ['read', 'write']) {
          try {
            if (operation === 'read') fs.readFileSync(path);
            else fs.writeFileSync(path, 'stolen', { flag: 'r+' });
            denied.push(false);
          } catch { denied.push(true); }
        }
      }
      fs.writeFileSync('allowed', 'workspace-ok');
      console.log(JSON.stringify({ denied, content: fs.readFileSync('allowed', 'utf8'), cwd: process.cwd() }));
    `)
    )
    expect(result).toEqual({ denied: [true, true, true, true, true, true], content: 'workspace-ok', cwd: workspace })
    expect(readFileSync(secret, 'utf8')).toBe('outside-secret')
    expect(readFileSync(join(workspace, 'allowed'), 'utf8')).toBe('workspace-ok')
    // Private /tmp can contain a same-named shadow file, but never modifies the host secret.
    await run(`import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(secret)}, 'private-shadow')`)
    expect(readFileSync(secret, 'utf8')).toBe('outside-secret')
  })

  test('명시한 읽기 전용 파일의 심볼릭 링크는 대상 파일만 노출하고 이웃 파일은 숨긴다', async (t) => {
    const { root, workspace, request, run } = setup(t)
    const dependency = join(root, 'dependency')
    const neighbor = join(root, 'neighbor')
    writeFileSync(dependency, 'dependency')
    writeFileSync(neighbor, 'private')
    const alias = join(workspace, 'dependency-link')
    symlinkSync(dependency, alias)
    const result = JSON.parse(
      await run(
        `
      import fs from 'node:fs';
      let writeDenied = false;
      try { fs.writeFileSync(${JSON.stringify(dependency)}, 'bad'); } catch { writeDenied = true; }
      console.log(JSON.stringify({ value: fs.readFileSync('dependency-link', 'utf8'), writeDenied,
        neighbor: fs.existsSync(${JSON.stringify(neighbor)}) }));
    `,
        { policy: { ...request.policy, readOnlyPaths: [alias] } }
      )
    )
    expect(result).toEqual({ value: 'dependency', writeDenied: true, neighbor: false })
    expect(readFileSync(dependency, 'utf8')).toBe('dependency')
  })

  test('추가 쓰기 경로와 읽기 전용 worker·Unix socket 브리지를 연결하고 교체를 차단한다', async (t) => {
    const { root, request, run } = setup(t)
    const writable = join(root, 'writable')
    mkdirSync(writable)
    const worker = join(root, 'worker.mjs')
    writeFileSync(worker, 'export const value = "worker"')
    const mounts: SandboxProcessRequest['mounts'][number][] = [
      { source: worker, target: '/run/keundal/worker.mjs', writable: false }
    ]
    for (const name of ['api', 'network']) {
      const source = join(root, `${name}.sock`)
      const server = createServer((socket) => socket.end(name))
      await new Promise<void>((resolve) => server.listen(source, resolve))
      t.onTestFinished(
        () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
      )
      mounts.push({ source, target: `/run/keundal/${name}.sock`, writable: false })
    }
    const result = JSON.parse(
      await run(
        `
      import fs from 'node:fs'; import net from 'node:net';
      import { value } from '/run/keundal/worker.mjs';
      fs.writeFileSync(${JSON.stringify(join(writable, 'file'))}, 'extra');
      const sockets = [];
      const denied = [];
      for (const name of ['api', 'network']) {
        const path = '/run/keundal/' + name + '.sock';
        sockets.push(await new Promise((resolve, reject) => {
          let result = ''; const socket = net.connect(path);
          socket.setEncoding('utf8').on('data', data => { result += data });
          socket.on('end', () => resolve(result)); socket.on('error', reject);
        }));
        for (const operation of [() => fs.unlinkSync(path), () => fs.renameSync('/run/keundal/worker.mjs', path)]) {
          try { operation(); denied.push(false); } catch { denied.push(true); }
        }
      }
      try { fs.writeFileSync('/run/keundal/worker.mjs', 'bad'); denied.push(false); } catch { denied.push(true); }
      console.log(JSON.stringify({ value, sockets, denied }));
    `,
        {
          policy: { ...request.policy, writablePaths: [writable] },
          mounts
        }
      )
    )
    expect(result).toEqual({ value: 'worker', sockets: ['api', 'network'], denied: [true, true, true, true, true] })
    expect(readFileSync(join(writable, 'file'), 'utf8')).toBe('extra')
  })

  test('마운트 원본 descriptor를 애플리케이션에 남기지 않는다', async (t) => {
    const { root, request, run } = setup(t)
    const dependency = join(root, 'dependency')
    mkdirSync(dependency)
    const result = JSON.parse(
      await run(
        `
      import fs from 'node:fs';
      console.log(JSON.stringify(fs.readdirSync('/proc/self/fd').flatMap(fd => {
        try { return [fs.readlinkSync('/proc/self/fd/' + fd)] } catch { return [] }
      })));
    `,
        { policy: { ...request.policy, readOnlyPaths: [dependency] } }
      )
    ) as string[]
    expect(result).not.toContain(dependency)
    expect(result).not.toContain(request.policy.workspace)
    for (const path of ['/usr', '/usr/bin', '/usr/lib', '/usr/lib64', realpathSync(process.execPath)]) {
      expect(result).not.toContain(path)
    }
  })

  test('상위 읽기 전용 마운트 아래에서도 workspace는 쓰기 가능하다', async (t) => {
    const { root, request, workspace, run } = setup(t)
    await run(`import fs from 'node:fs'; fs.writeFileSync('file', 'ok')`, {
      policy: { ...request.policy, readOnlyPaths: [root] }
    })
    expect(readFileSync(join(workspace, 'file'), 'utf8')).toBe('ok')
  })

  test('모든 필수 namespace와 프로세스·네트워크를 격리하고 capability와 추가 user namespace를 차단한다', async (t) => {
    const { run } = setup(t)
    const server = createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    t.onTestFinished(
      () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    )
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing server address')
    const result = JSON.parse(
      await run(`
      import fs from 'node:fs'; import net from 'node:net'; import { spawnSync } from 'node:child_process';
      const networkDenied = await new Promise(resolve => {
        const socket = net.connect({ host: '127.0.0.1', port: ${address.port} });
        socket.on('connect', () => { socket.destroy(); resolve(false); });
        socket.on('error', () => resolve(true));
        socket.setTimeout(1000, () => { socket.destroy(); resolve(true); });
      });
      console.log(JSON.stringify({ namespaces: Object.fromEntries(
        ['user', 'mnt', 'pid', 'ipc', 'net', 'uts'].map(name => [name, fs.readlinkSync('/proc/self/ns/' + name)])),
        hostPidVisible: fs.existsSync('/proc/${process.pid}/cmdline'), networkDenied,
        caps: fs.readFileSync('/proc/self/status', 'utf8').match(/CapEff:\\s*(\\w+)/)[1],
        usernsExit: spawnSync('/usr/bin/unshare', ['--user', '/usr/bin/true']).status }));
    `)
    )
    for (const name of ['user', 'mnt', 'pid', 'ipc', 'net', 'uts']) {
      expect(result.namespaces[name]).not.toBe(readlinkSync(`/proc/self/ns/${name}`))
    }
    expect(result.hostPidVisible).toBe(false)
    expect(result.networkDenied).toBe(true)
    expect(result.caps).toBe('0000000000000000')
    expect(result.usernsExit).toBeTypeOf('number')
    expect(result.usernsExit).toBeGreaterThan(0)
  })

  test('호스트 환경과 loader 설정을 상속하지 않고 지정한 환경과 안전한 HOME·PATH만 전달한다', async (t) => {
    const { run, workspace } = setup(t)
    const oldSecret = process.env.KEUNDAL_TEST_SECRET
    const oldLoader = process.env.LD_PRELOAD
    process.env.KEUNDAL_TEST_SECRET = 'not-for-child'
    process.env.LD_PRELOAD = '/missing/host-injection.so'
    try {
      const result = JSON.parse(
        await run('console.log(JSON.stringify(process.env))', {
          environment: { EXPLICIT: 'yes', FLAG: '--bind', HOME: '/host-home', PATH: '/host-path' }
        })
      )
      expect(result).toEqual({ EXPLICIT: 'yes', FLAG: '--bind', HOME: '/tmp', PATH: '/usr/bin:/bin', PWD: workspace })
    } finally {
      if (oldSecret === undefined) delete process.env.KEUNDAL_TEST_SECRET
      else process.env.KEUNDAL_TEST_SECRET = oldSecret
      if (oldLoader === undefined) delete process.env.LD_PRELOAD
      else process.env.LD_PRELOAD = oldLoader
    }
  })

  test('bwrap이 없으면 애플리케이션을 실행하지 않고 오류를 전달한다', async (t) => {
    const { root, workspace, request } = setup(t)
    const child = new LinuxSandboxProvider({ executable: join(root, 'missing-bwrap') }).start({
      ...request,
      args: ['--eval', `require('node:fs').writeFileSync(${JSON.stringify(join(workspace, 'escaped'))}, 'bad')`]
    })
    await expect(collect(child)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(() => readFileSync(join(workspace, 'escaped'))).toThrow()
  })

  test('루트·보호 경로·상위 탐색·광범위 심볼릭 링크 권한과 브리지 우회를 거부한다', (t) => {
    const { root, request, provider } = setup(t)
    const alias = join(root, 'root-link')
    symlinkSync('/', alias)
    for (const path of ['/', '/home', '/etc', '/usr', '/proc', '/dev', '/run', '/tmp', alias, `${root}/../etc`]) {
      expect(() => provider.start({ ...request, policy: { ...request.policy, readOnlyPaths: [path] } })).toThrow()
      expect(() => provider.start({ ...request, policy: { ...request.policy, writablePaths: [path] } })).toThrow()
      expect(() => provider.start({ ...request, policy: { workspace: path } })).toThrow()
    }
    expect(() => provider.start({ ...request, mounts: [{ source: root, target: '/proc', writable: true }] })).toThrow()
    const worker = join(root, 'worker.mjs')
    writeFileSync(worker, '')
    for (const target of ['/run/keundal', '/run/keundal/extra', '/run/keundal/../api.sock']) {
      expect(() => provider.start({ ...request, mounts: [{ source: worker, target, writable: false }] })).toThrow()
    }
    const mount = { source: worker, target: '/run/keundal/worker.mjs', writable: false }
    expect(() => provider.start({ ...request, mounts: [{ ...mount, writable: true }] })).toThrow()
    expect(() => provider.start({ ...request, mounts: [mount, mount] })).toThrow()
    expect(() => provider.start({ ...request, mounts: [{ ...mount, source: root }] })).toThrow()
    expect(() => provider.start({ ...request, mounts: [{ ...mount, target: '/run/keundal/api.sock' }] })).toThrow()
    expect(() => new LinuxSandboxProvider({ executable: 'bwrap' })).toThrow()
  })

  for (const killParent of [false, true]) {
    test(
      killParent
        ? '호스트 부모 프로세스가 죽으면 setsid 자손까지 종료한다'
        : 'bwrap을 종료하면 setsid 자손까지 종료한다',
      async (t) => {
        const { workspace, request, provider } = setup(t)
        const heartbeat = join(workspace, 'heartbeat')
        const code = `
        import { spawn } from 'node:child_process';
        spawn(process.execPath, ['--eval', "setInterval(() => require('node:fs').appendFileSync(process.env.HEARTBEAT, '.'), 20)"],
          { detached: true, stdio: 'ignore' }).unref();
        setInterval(() => {}, 1000);
      `
        const runningRequest = {
          ...request,
          environment: { HEARTBEAT: heartbeat },
          args: ['--input-type=module', '--eval', code]
        }
        const child = killParent
          ? spawn(
              process.execPath,
              [
                '--input-type=module',
                '--eval',
                `
            const { LinuxSandboxProvider } = await import(process.env.PROVIDER_URL);
            const child = new LinuxSandboxProvider().start(JSON.parse(process.env.SANDBOX_REQUEST));
            child.stderr.pipe(process.stderr);
            child.on('error', error => { console.error(error); process.exit(1); });
            setInterval(() => {}, 1000);
          `
              ],
              {
                stdio: 'pipe',
                env: {
                  PROVIDER_URL: new URL('../dist/index.js', import.meta.url).href,
                  SANDBOX_REQUEST: JSON.stringify(runningRequest)
                }
              }
            )
          : provider.start(runningRequest)
        let stderr = ''
        child.stderr.on('data', (data) => {
          stderr += data
        })
        t.onTestFinished(() => {
          child.kill('SIGKILL')
        })
        await waitFor(() => {
          if (child.exitCode !== null) throw new Error(`Sandbox exited early: ${stderr}`)
          try {
            return readFileSync(heartbeat).length >= 3
          } catch {
            return false
          }
        })
        const closed = once(child, 'close')
        child.kill('SIGKILL')
        await closed
        await delay(100)
        const finalSize = readFileSync(heartbeat).length
        await delay(200)
        expect(readFileSync(heartbeat).length).toBe(finalSize)
      }
    )
  }
})
