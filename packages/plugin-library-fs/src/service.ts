import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path'

import type { ExecutionOptions } from '@keundal/core'
import {
  MediaLibraryService,
  type CreateLibraryRequest,
  type ImportMediaRequest,
  type MediaItem,
  type MediaItemOrigin,
  type MediaItemStorage,
  type MediaLibrary,
  type OpenLibraryRequest,
  type RelocateMediaRequest,
  type RemoveMediaRequest,
  type SaveSubtitleRequest,
  type SubtitleTrack
} from '@keundal/media'
import type { Context } from 'cordis'

const LIBRARY_MANIFEST = 'library.json'
const ITEM_MANIFEST = 'item.json'
const TRASH_DIRECTORY = '.trash'
const LIBRARY_VERSION = 1

export interface FsMediaLibraryConfig {
  /** 지정하면 자료库 경로가 이 디렉터리 안에 있어야 합니다. */
  readonly root?: string
}

interface LibraryManifest {
  readonly version: number
  readonly name: string
  readonly createdAt: string
  readonly updatedAt: string
}

interface ItemManifest {
  readonly version: number
  readonly id: string
  readonly title: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly storage: MediaItemStorage
  readonly origin: MediaItemOrigin
  /** 복사 항목은 자료库 기준 상대 경로이고, 연결 항목은 절대 경로입니다. */
  readonly videoPath: string
  readonly subtitleTracks: readonly SubtitleTrack[]
}

function requireText(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.includes('\0')) {
    throw new TypeError(`${name} must be a non-empty string`)
  }
  return value
}

function requireTimestamp(value: unknown, name: string): string {
  const text = requireText(value, name)
  if (Number.isNaN(Date.parse(text))) throw new TypeError(`${name} must be an ISO timestamp`)
  return text
}

function parseLibraryManifest(source: string, path: string): LibraryManifest {
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch {
    throw new Error(`${path} is not a valid library manifest`)
  }
  if (typeof value !== 'object' || value === null) throw new Error(`${path} is not a valid library manifest`)
  const manifest = value as Record<string, unknown>
  const version = manifest.version
  if (typeof version !== 'number' || !Number.isSafeInteger(version)) {
    throw new Error(`${path} has an invalid version`)
  }
  if (version > LIBRARY_VERSION) {
    throw new Error(`${path} was created by a newer version of the application`)
  }
  return {
    version,
    name: requireText(manifest.name, 'name'),
    createdAt: requireTimestamp(manifest.createdAt, 'createdAt'),
    updatedAt: requireTimestamp(manifest.updatedAt, 'updatedAt')
  }
}

function parseSegments(value: unknown): SubtitleTrack['segments'] {
  if (!Array.isArray(value)) throw new TypeError('subtitle segments must be an array')
  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) throw new TypeError(`segment ${index} is invalid`)
    const segment = entry as Record<string, unknown>
    const startMs = segment.startMs
    const endMs = segment.endMs
    if (typeof startMs !== 'number' || typeof endMs !== 'number' || endMs < startMs) {
      throw new TypeError(`segment ${index} has an invalid time range`)
    }
    return {
      startMs,
      endMs,
      text: requireText(segment.text, `segment ${index} text`),
      speaker: typeof segment.speaker === 'string' ? segment.speaker : null
    }
  })
}

function parseTracks(value: unknown): readonly SubtitleTrack[] {
  if (!Array.isArray(value)) throw new TypeError('subtitleTracks must be an array')
  const seen = new Set<string>()
  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) throw new TypeError(`track ${index} is invalid`)
    const track = entry as Record<string, unknown>
    const id = requireText(track.id, `track ${index} id`)
    if (seen.has(id)) throw new TypeError(`track ${id} is duplicated`)
    seen.add(id)
    if (track.kind !== 'original' && track.kind !== 'translation') {
      throw new TypeError(`track ${id} has an invalid kind`)
    }
    return {
      id,
      kind: track.kind,
      language: requireText(track.language, `track ${id} language`),
      segments: parseSegments(track.segments)
    }
  })
}

function parseOrigin(value: unknown): MediaItemOrigin {
  if (typeof value !== 'object' || value === null) throw new TypeError('origin is invalid')
  const origin = value as Record<string, unknown>
  if (origin.kind === 'downloaded') {
    return { kind: 'downloaded', url: requireText(origin.url, 'origin url') }
  }
  if (origin.kind === 'local') {
    return { kind: 'local', path: requireText(origin.path, 'origin path') }
  }
  throw new TypeError('origin kind is invalid')
}

function parseItemManifest(source: string, path: string): ItemManifest {
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch {
    throw new Error(`${path} is not a valid item manifest`)
  }
  if (typeof value !== 'object' || value === null) throw new Error(`${path} is not a valid item manifest`)
  const manifest = value as Record<string, unknown>
  const version = manifest.version
  if (typeof version !== 'number' || !Number.isSafeInteger(version)) {
    throw new Error(`${path} has an invalid version`)
  }
  if (version > LIBRARY_VERSION) {
    throw new Error(`${path} was created by a newer version of the application`)
  }
  const storage = manifest.storage
  if (storage !== 'copy' && storage !== 'link') throw new TypeError(`${path} has an invalid storage`)
  return {
    version,
    id: requireText(manifest.id, 'id'),
    title: requireText(manifest.title, 'title'),
    createdAt: requireTimestamp(manifest.createdAt, 'createdAt'),
    updatedAt: requireTimestamp(manifest.updatedAt, 'updatedAt'),
    storage,
    origin: parseOrigin(manifest.origin),
    videoPath: requireText(manifest.videoPath, 'videoPath'),
    subtitleTracks: parseTracks(manifest.subtitleTracks)
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

async function readManifest<T>(path: string, parse: (source: string, path: string) => T): Promise<T> {
  return parse(await readFile(path, 'utf8'), path)
}

export class FsMediaLibraryService extends MediaLibraryService {
  private readonly root: string | undefined

  constructor(ctx: Context, config: FsMediaLibraryConfig = {}) {
    super(ctx)
    if (config.root !== undefined && requireText(config.root, 'root').length === 0) {
      throw new TypeError('root must be a non-empty string')
    }
    this.root = config.root === undefined ? undefined : resolve(config.root)
  }

  async create(request: CreateLibraryRequest, options: ExecutionOptions = {}): Promise<MediaLibrary> {
    options.signal?.throwIfAborted()
    const path = this.path(request.path)
    if (await isDirectory(path)) {
      const entries = await readdir(path)
      if (entries.length > 0) throw new Error(`${path} already exists and is not an empty directory`)
    } else if (await isFile(path)) {
      throw new Error(`${path} is a file`)
    }
    await mkdir(path, { recursive: true })
    const now = new Date().toISOString()
    const manifest: LibraryManifest = {
      version: LIBRARY_VERSION,
      name: request.name === undefined ? basename(path) : requireText(request.name, 'name'),
      createdAt: now,
      updatedAt: now
    }
    await writeFile(join(path, LIBRARY_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    return this.library(path, manifest)
  }

  async open(request: OpenLibraryRequest, options: ExecutionOptions = {}): Promise<MediaLibrary> {
    options.signal?.throwIfAborted()
    const path = this.path(request.path)
    if (!(await isDirectory(path))) throw new Error(`${path} is not a library directory`)
    const manifest = await readManifest(join(path, LIBRARY_MANIFEST), parseLibraryManifest)
    return this.library(path, manifest)
  }

  async list(libraryPath: string, options: ExecutionOptions = {}): Promise<readonly MediaItem[]> {
    options.signal?.throwIfAborted()
    const path = this.path(libraryPath)
    await this.open({ path }, options)
    const entries = await readdir(path, { withFileTypes: true })
    const items: MediaItem[] = []
    for (const entry of entries) {
      options.signal?.throwIfAborted()
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      items.push(await this.read(path, entry.name, options))
    }
    return items.sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  }

  async read(libraryPath: string, itemId: string, options: ExecutionOptions = {}): Promise<MediaItem> {
    options.signal?.throwIfAborted()
    const path = this.path(libraryPath)
    const directory = join(path, requireText(itemId, 'itemId'))
    const manifest = await readManifest(join(directory, ITEM_MANIFEST), parseItemManifest)
    const videoPath = this.videoPath(directory, manifest.videoPath)
    return {
      id: manifest.id,
      title: manifest.title,
      createdAt: manifest.createdAt,
      updatedAt: manifest.updatedAt,
      storage: manifest.storage,
      origin: manifest.origin,
      video: { path: videoPath, present: await isFile(videoPath) },
      subtitleTracks: manifest.subtitleTracks
    }
  }

  async import(request: ImportMediaRequest, options: ExecutionOptions = {}): Promise<readonly MediaItem[]> {
    options.signal?.throwIfAborted()
    const libraryPath = this.path(request.libraryPath)
    if (!Array.isArray(request.entries)) throw new TypeError('entries must be an array')
    await this.open({ path: libraryPath }, options)
    const imported: MediaItem[] = []
    for (const entry of request.entries) {
      options.signal?.throwIfAborted()
      const source = resolve(requireText(entry.filePath, 'filePath'))
      if (!(await isFile(source))) throw new Error(`${source} is not a file`)
      if (entry.storage !== 'copy' && entry.storage !== 'link') {
        throw new TypeError('storage must be copy or link')
      }
      const id = randomUUID()
      const directory = join(libraryPath, id)
      await mkdir(directory, { recursive: true })
      let videoPath: string
      if (entry.storage === 'copy') {
        const fileName = basename(source)
        await copyFile(source, join(directory, fileName))
        videoPath = fileName
      } else {
        videoPath = source
      }
      const now = new Date().toISOString()
      const manifest: ItemManifest = {
        version: LIBRARY_VERSION,
        id,
        title: entry.title === undefined ? basename(source, extname(source)) : requireText(entry.title, 'title'),
        createdAt: now,
        updatedAt: now,
        storage: entry.storage,
        origin: { kind: 'local', path: source },
        videoPath,
        subtitleTracks: []
      }
      await this.writeItem(directory, manifest)
      imported.push(await this.read(libraryPath, id, options))
    }
    return imported
  }

  async remove(request: RemoveMediaRequest, options: ExecutionOptions = {}): Promise<void> {
    options.signal?.throwIfAborted()
    const libraryPath = this.path(request.libraryPath)
    const itemId = requireText(request.itemId, 'itemId')
    const directory = join(libraryPath, itemId)
    if (!(await isDirectory(directory))) throw new Error(`${directory} is not an item directory`)
    if (request.permanent) {
      await rm(directory, { recursive: true, force: true })
      return
    }
    const trash = join(libraryPath, TRASH_DIRECTORY)
    await mkdir(trash, { recursive: true })
    let target = join(trash, itemId)
    if (await isDirectory(target)) target = join(trash, `${itemId}-${Date.now()}`)
    await rename(directory, target)
  }

  async relocate(request: RelocateMediaRequest, options: ExecutionOptions = {}): Promise<MediaItem> {
    options.signal?.throwIfAborted()
    const libraryPath = this.path(request.libraryPath)
    const itemId = requireText(request.itemId, 'itemId')
    const directory = join(libraryPath, itemId)
    const manifest = await readManifest(join(directory, ITEM_MANIFEST), parseItemManifest)
    const source = resolve(requireText(request.filePath, 'filePath'))
    if (!(await isFile(source))) throw new Error(`${source} is not a file`)
    let videoPath: string
    if (manifest.storage === 'copy') {
      const fileName = basename(source)
      await copyFile(source, join(directory, fileName))
      videoPath = fileName
    } else {
      videoPath = source
    }
    const updated: ItemManifest = {
      ...manifest,
      videoPath,
      origin: manifest.origin.kind === 'local' ? { kind: 'local', path: source } : manifest.origin,
      updatedAt: new Date().toISOString()
    }
    await this.writeItem(directory, updated)
    return this.read(libraryPath, itemId, options)
  }

  async saveSubtitle(request: SaveSubtitleRequest, options: ExecutionOptions = {}): Promise<void> {
    options.signal?.throwIfAborted()
    const libraryPath = this.path(request.libraryPath)
    const itemId = requireText(request.itemId, 'itemId')
    const directory = join(libraryPath, itemId)
    const manifest = await readManifest(join(directory, ITEM_MANIFEST), parseItemManifest)
    const track = parseTracks([request.track])[0]!
    const subtitleTracks = [...manifest.subtitleTracks.filter((existing) => existing.id !== track.id), track]
    await this.writeItem(directory, { ...manifest, subtitleTracks, updatedAt: new Date().toISOString() })
  }

  private path(value: string): string {
    const path = resolve(requireText(value, 'library path'))
    if (this.root !== undefined) {
      const delta = relative(this.root, path)
      if (delta === '' || delta.startsWith('..') || isAbsolute(delta)) {
        throw new Error(`${path} is outside the configured root`)
      }
    }
    return path
  }

  private videoPath(directory: string, videoPath: string): string {
    return isAbsolute(videoPath) ? videoPath : join(directory, videoPath)
  }

  private library(path: string, manifest: LibraryManifest): MediaLibrary {
    return {
      path,
      name: manifest.name,
      createdAt: manifest.createdAt,
      updatedAt: manifest.updatedAt
    }
  }

  private async writeItem(directory: string, manifest: ItemManifest): Promise<void> {
    await writeFile(join(directory, ITEM_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  }
}
