import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const portable = resolve(process.argv[2])
const work = await mkdtemp(join(tmpdir(), 'keundal-portable-smoke-'))
const runtime = join(portable, process.platform === 'win32' ? 'keundal-host.exe' : 'keundal-host')
const token = 'portable-smoke-test-token'
const model = 'portable-smoke-model'
const message = { id: 'smoke-message', role: 'user', content: 'portable persistence check' }
let host
let app

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit')
  if (process.platform === 'win32') {
    // Terminate the sidecar and WebView processes before removing their working directory.
    const result = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      encoding: 'utf8',
      timeout: 10_000
    })
    if (result.error) throw result.error
    assert.equal(result.status, 0, `Failed to stop process tree:\n${result.stdout}\n${result.stderr}`)
  } else {
    child.kill()
  }
  await exited
}

async function startHost() {
  const child = spawn(runtime, [join(portable, 'sidecar/main.js')], {
    cwd: work,
    env: {
      ...process.env,
      NODE_PATH: '',
      NODE_OPTIONS: '',
      KEUNDAL_HOST: '127.0.0.1',
      PORT: '0',
      KEUNDAL_SIDECAR: '1',
      KEUNDAL_PARENT_PID: String(process.pid),
      KEUNDAL_PROVIDER: 'openai',
      OPENAI_API_KEY: 'test-only-no-provider-request',
      KEUNDAL_MODEL: model,
      KEUNDAL_API_TOKEN: token,
      KEUNDAL_SQLITE_PATH: join(work, 'smoke.sqlite')
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  host = child
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', data => (stdout += data))
  child.stderr.on('data', data => (stderr += data))
  let spawnError
  child.on('error', error => (spawnError = error))
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError
    assert.equal(child.exitCode, null, `Host exited before readiness:\n${stdout}\n${stderr}`)
    const ready = stdout
      .split(/\r?\n/)
      .slice(0, -1)
      .find(line => line.startsWith('{') && line.includes('keundal-sidecar'))
    if (ready) {
      const { url } = JSON.parse(ready)
      assert.equal(new URL(url).hostname, '127.0.0.1')
      return url
    }
    await delay(100)
  }
  throw new Error(`Host readiness timed out:\n${stdout}\n${stderr}`)
}

async function request(url, path, options = {}) {
  const response = await fetch(`${url}${path}`, {
    ...options,
    headers: { 'authorization': `Bearer ${token}`, 'content-type': 'application/json' },
    signal: AbortSignal.timeout(5_000)
  })
  assert.equal(response.status, 200, `${path}: ${await response.clone().text()}`)
  return response.json()
}

async function debugPort() {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address()
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return port
}

async function verifyChatScreen(port) {
  const deadline = Date.now() + 30_000
  let socket
  let lastScreen = ''
  let discovery = ''
  try {
    while (Date.now() < deadline && !socket) {
      const pages = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(2_000)
      }).then(response => response.json()).catch((error) => {
        discovery = String(error)
        return []
      })
      if (pages.length) discovery = JSON.stringify(pages.map(({ type, url }) => ({ type, url })))
      const page = pages.find(page => ['page', 'webview'].includes(page.type) && /^(?:https?:\/\/tauri\.localhost|tauri:\/\/localhost)/.test(page.url))
      if (page?.webSocketDebuggerUrl) {
        socket = new WebSocket(page.webSocketDebuggerUrl)
        await once(socket, 'open', { signal: AbortSignal.timeout(5_000) })
      } else {
        await delay(200)
      }
    }
    assert.ok(socket, `Desktop WebView debugging endpoint did not become ready: ${discovery}`)
    let id = 0
    while (Date.now() < deadline) {
      const reply = once(socket, 'message', { signal: AbortSignal.timeout(5_000) })
      socket.send(JSON.stringify({
        id: ++id,
        method: 'Runtime.evaluate',
        params: {
          expression: `JSON.stringify({ ready: !!document.querySelector('#home textarea'), text: document.body?.innerText ?? '' })`,
          returnByValue: true
        }
      }))
      const [event] = await reply
      const result = JSON.parse(event.data)
      assert.equal(result.id, id)
      assert.ok(!result.error && !result.result?.exceptionDetails, JSON.stringify(result))
      const screen = JSON.parse(result.result.result.value)
      lastScreen = screen.text
      assert.doesNotMatch(lastScreen, /Illegal invocation|not allowed by ACL|Failed to fetch/)
      if (screen.ready) {
        console.log('PASS: desktop WebView renders the chat input after sidecar initialization')
        return
      }
      await delay(200)
    }
    throw new Error(`Desktop chat screen did not become ready:\n${lastScreen}`)
  } finally {
    socket?.close()
  }
}

try {
  const url = await startHost()
  const denied = await fetch(`${url}/threads`, { signal: AbortSignal.timeout(5_000) })
  assert.equal(denied.status, 401)
  await denied.text()
  assert.deepEqual(await request(url, '/threads'), [])
  const models = await request(url, '/models')
  assert.ok(models.models.some(entry => entry.id === model))
  await request(url, '/threads/portable-smoke', {
    method: 'PUT',
    body: JSON.stringify({ expectedRevision: 0, messages: [message], state: {} })
  })
  await stop(host)
  const restarted = await startHost()
  const snapshot = await request(restarted, '/threads/portable-smoke')
  assert.deepEqual(snapshot.messages, [message])
  console.log('PASS: packaged host starts outside the repository; auth, models and SQLite restart work')

  if (process.platform === 'win32') {
    const port = await debugPort()
    app = spawn(join(portable, 'keundal-desktop.exe'), [], {
      cwd: work,
      stdio: 'inherit',
      env: {
        ...process.env,
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
        WEBVIEW2_USER_DATA_FOLDER: join(work, 'webview-data')
      }
    })
    let appError
    app.on('error', error => (appError = error))
    let ready = false
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      if (appError) throw appError
      assert.equal(app.exitCode, null, 'Desktop exited before creating its window')
      const window = spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `$p = Get-Process -Id ${app.pid} -ErrorAction Stop; if ($p.MainWindowHandle -eq 0 -or -not $p.Responding) { exit 1 }`
        ],
        { encoding: 'utf8', timeout: 10_000 }
      )
      if (window.status === 0) {
        ready = true
        break
      }
      await delay(500)
    }
    assert.ok(ready, 'Desktop did not create a responding native window')
    await delay(3_000)
    assert.equal(app.exitCode, null, 'Desktop exited after creating its window')
    await verifyChatScreen(port)
    console.log('PASS: extracted Windows desktop EXE creates a responding window and stays running')
  }
} finally {
  await stop(app)
  await stop(host)
  await rm(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
}
