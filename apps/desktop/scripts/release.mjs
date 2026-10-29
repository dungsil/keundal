import { spawnSync } from 'node:child_process'
import { openAsBlob } from 'node:fs'
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

const repository = 'dungsil/keundal'
const endpoint = `https://github.com/${repository}/releases/latest/download/latest.json`
const platforms = {
  'linux-x64': { key: 'linux-x86_64', updater: '.AppImage', installer: '.deb' },
  'windows-x64': { key: 'windows-x86_64', updater: '.exe' },
  'macos-arm64': { key: 'darwin-aarch64', updater: '.app.tar.gz', installer: '.dmg' },
}
const commonCredentials = ['TAURI_UPDATER_PUBLIC_KEY', 'TAURI_SIGNING_PRIVATE_KEY', 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD']
const credentials = {
  'linux-x64': [],
  'windows-x64': ['WINDOWS_CERTIFICATE', 'WINDOWS_CERTIFICATE_PASSWORD'],
  'macos-arm64': ['APPLE_CERTIFICATE', 'APPLE_CERTIFICATE_PASSWORD', 'APPLE_SIGNING_IDENTITY', 'APPLE_ID', 'APPLE_PASSWORD', 'APPLE_TEAM_ID'],
}

function version(value) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value ?? '') || value.split('.').some((part) => Number(part) > 65535)) {
    throw new Error('Expected a stable version: MAJOR.MINOR.PATCH (each component <= 65535)')
  }
  return value
}

function platform(value) {
  if (!Object.hasOwn(platforms, value)) throw new Error('Unsupported release platform')
  return platforms[value]
}

function requireEnvironment(names) {
  const missing = names.filter((name) => !process.env[name]?.trim())
  if (missing.length) throw new Error(`Missing release credentials: ${missing.join(', ')}`)
}

async function files(directory) {
  const result = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isSymbolicLink()) throw new Error('Release assets must not be symbolic links')
    // A macOS .app is not a release asset; only its signed updater archive is.
    if (entry.isDirectory() && !entry.name.endsWith('.app')) result.push(...await files(path))
    else if (entry.isFile()) result.push(path)
  }
  return result
}

function selectAssets(paths, name, strict) {
  const spec = platform(name)
  const suffixes = [spec.updater, `${spec.updater}.sig`, ...(spec.installer ? [spec.installer] : [])]
  const selected = paths.filter((path) => suffixes.some((suffix) => path.endsWith(suffix)))
  if (strict && selected.length !== paths.length) throw new Error(`Unexpected assets for ${name}`)
  for (const suffix of suffixes) {
    if (selected.filter((path) => path.endsWith(suffix)).length !== 1) {
      throw new Error(`Expected exactly one ${suffix} asset for ${name}`)
    }
  }
  const updater = selected.find((path) => path.endsWith(spec.updater))
  if (!selected.includes(`${updater}.sig`)) throw new Error(`Missing matching signature for ${name}`)
  return { selected, updater }
}

async function manifest(releaseVersion, directory) {
  const result = { version: releaseVersion, platforms: {} }
  const assets = []
  const names = new Set(['latest.json'])
  for (const [name, spec] of Object.entries(platforms)) {
    const { selected, updater } = selectAssets(await files(join(directory, name)), name, true)
    for (const path of selected) {
      const filename = basename(path)
      if (names.has(filename)) throw new Error(`Duplicate release asset: ${filename}`)
      if ((await stat(path)).size === 0) throw new Error(`Empty release asset: ${filename}`)
      names.add(filename)
      assets.push(path)
    }
    const signature = (await readFile(`${updater}.sig`, 'utf8')).trim()
    if (!signature) throw new Error(`Empty signature for ${name}`)
    result.platforms[spec.key] = {
      signature,
      url: `https://github.com/${repository}/releases/download/desktop-v${releaseVersion}/${encodeURIComponent(basename(updater))}`,
    }
  }
  const unexpected = (await readdir(directory)).filter((name) => !Object.hasOwn(platforms, name) && name !== 'latest.json')
  if (unexpected.length) throw new Error('Unexpected release artifact directories')
  return { result, assets }
}

async function verify(releaseVersion, directory) {
  requireEnvironment(['TAURI_UPDATER_PUBLIC_KEY'])
  const validated = await manifest(releaseVersion, directory)
  const temporary = await mkdtemp(join(tmpdir(), 'keundal-signature-'))
  try {
    const publicKey = join(temporary, 'public.key')
    const signaturePath = join(temporary, 'signature.minisig')
    await writeFile(publicKey, Buffer.from(process.env.TAURI_UPDATER_PUBLIC_KEY.trim(), 'base64'))
    for (const path of validated.assets.filter((path) => path.endsWith('.sig'))) {
      const signature = Buffer.from((await readFile(path, 'utf8')).trim(), 'base64')
      await writeFile(signaturePath, signature)
      const check = spawnSync('minisign', ['-Vm', path.slice(0, -4), '-p', publicKey, '-x', signaturePath], { stdio: 'ignore', timeout: 60000 })
      if (check.status !== 0) throw new Error('Updater signature verification failed; check the public key and signed assets')
      const comment = signature.toString('utf8').split(/\r?\n/)[2]
      const versions = comment?.startsWith('trusted comment: ') ? comment.split('\t').filter((field) => field.startsWith('version:')) : []
      if (versions.length !== 1 || versions[0] !== `version:${releaseVersion}`) throw new Error('Signed updater version does not match the release version')
    }
    return validated
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

async function draft(releaseVersion, directory, commit) {
  requireEnvironment(['GH_TOKEN'])
  if (!/^[a-f0-9]{40}$/.test(commit ?? '')) throw new Error('Expected the full source commit SHA')
  const { result, assets } = await verify(releaseVersion, directory)
  const manifestPath = join(directory, 'latest.json')
  await writeFile(manifestPath, `${JSON.stringify(result, null, 2)}\n`)
  const headers = { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
  const base = `https://api.github.com/repos/${repository}/releases`
  const tag = `desktop-v${releaseVersion}`
  const existing = await fetch(`${base}/tags/${tag}`, { headers })
  if (existing.status !== 404) throw new Error(existing.ok ? 'Release already exists; refusing to modify it' : `Release lookup failed (${existing.status})`)
  // The tag endpoint only guarantees published releases. Also check every page for drafts.
  for (let page = 1; ; page++) {
    const response = await fetch(`${base}?per_page=100&page=${page}`, { headers })
    if (!response.ok) throw new Error(`Release list lookup failed (${response.status})`)
    const releases = await response.json()
    if (!Array.isArray(releases)) throw new Error('Invalid release list response')
    if (releases.some((release) => release.tag_name === tag)) throw new Error('Release already exists; refusing to modify it')
    if (releases.length < 100) break
  }
  // Refuse an existing tag at a different commit rather than label a different build as that tag.
  const tagRef = await fetch(`https://api.github.com/repos/${repository}/git/ref/tags/${tag}`, { headers })
  if (tagRef.status !== 404) {
    if (!tagRef.ok) throw new Error(`Tag lookup failed (${tagRef.status})`)
    const ref = await tagRef.json()
    if (ref.object?.type !== 'commit' || ref.object.sha !== commit) throw new Error('Existing tag does not directly reference the build commit')
  }
  const response = await fetch(base, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tag_name: tag, target_commitish: commit, name: `Keundal ${releaseVersion}`, draft: true, prerelease: false }),
  })
  if (!response.ok) throw new Error(`Draft creation failed (${response.status})`)
  const release = await response.json()
  if (release.draft !== true || !Number.isSafeInteger(release.id)) throw new Error('GitHub did not return a draft release')
  // Upload only to the newly created release ID; never look up or update a release by tag again.
  for (const path of [...assets, manifestPath]) {
    const upload = await fetch(`https://uploads.github.com/repos/${repository}/releases/${release.id}/assets?name=${encodeURIComponent(basename(path))}`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/octet-stream' }, body: await openAsBlob(path),
    })
    if (!upload.ok) throw new Error(`Draft asset upload failed (${upload.status}); the incomplete draft requires manual cleanup`)
  }
  console.log(`Created draft ${tag}; publication is a separate manual operation`)
}

async function main() {
  const [command, inputVersion, ...args] = process.argv.slice(2)
  const releaseVersion = version(inputVersion)
  switch (command) {
    case 'validate':
      requireEnvironment([...commonCredentials, ...Object.values(credentials).flat()])
      if (process.env.APPLE_SIGNING_IDENTITY.trim() === '-') throw new Error('Ad-hoc Apple signing is forbidden')
      console.log(`Validated desktop-v${releaseVersion}`)
      break
    case 'config': {
      const [name, output] = args
      platform(name)
      requireEnvironment([...commonCredentials, ...credentials[name]])
      if (name === 'macos-arm64' && process.env.APPLE_SIGNING_IDENTITY.trim() === '-') throw new Error('Ad-hoc Apple signing is forbidden')
      if (name === 'windows-x64') requireEnvironment(['WINDOWS_CERTIFICATE_THUMBPRINT'])
      const config = {
        version: releaseVersion,
        build: { beforeBuildCommand: '' },
        bundle: { active: true, createUpdaterArtifacts: true, targets: name === 'linux-x64' ? ['deb', 'appimage'] : name === 'windows-x64' ? ['nsis'] : ['app', 'dmg'] },
        plugins: { updater: { pubkey: process.env.TAURI_UPDATER_PUBLIC_KEY, endpoints: [endpoint], requireSignedVersion: true } },
      }
      if (name === 'windows-x64') config.bundle.windows = { certificateThumbprint: process.env.WINDOWS_CERTIFICATE_THUMBPRINT, digestAlgorithm: 'sha256', timestampUrl: 'http://timestamp.digicert.com', tsp: true }
      // Tauri re-signs the embedded Node executable with hardened runtime enabled.
      if (name === 'macos-arm64') config.bundle.macOS = { entitlements: 'Entitlements.plist' }
      await writeFile(output, `${JSON.stringify(config, null, 2)}\n`)
      break
    }
    case 'collect': {
      const [name, source, destination] = args
      const { selected } = selectAssets(await files(source), name, false)
      await mkdir(destination, { recursive: false })
      for (const path of selected) await cp(path, join(destination, basename(path)), { errorOnExist: true, force: false })
      // Verify signature pairing and nonempty files before uploading the matrix artifact.
      const { updater } = selectAssets(await files(destination), name, true)
      if (!(await readFile(`${updater}.sig`, 'utf8')).trim()) throw new Error(`Empty signature for ${name}`)
      break
    }
    case 'manifest': {
      const [directory] = args
      const { result } = await manifest(releaseVersion, directory)
      await writeFile(join(directory, 'latest.json'), `${JSON.stringify(result, null, 2)}\n`)
      break
    }
    case 'verify':
      await verify(releaseVersion, args[0])
      console.log(`Verified signed updater artifacts for desktop-v${releaseVersion}`)
      break
    case 'draft':
      await draft(releaseVersion, ...args)
      break
    default:
      throw new Error('Expected validate, config, collect, manifest, verify, or draft')
  }
}

try {
  await main()
} catch (error) {
  // Do not log provider response bodies, command arguments, or credential values.
  console.error(error.message)
  process.exitCode = 1
}
