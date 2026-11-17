import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, open, readdir, realpath, rename, unlink, utimes } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import path from 'node:path'

const SAMPLE_RATE = 44_100
const PACK_HEADER_BYTES = 12
const BYTES_PER_FRAME = 4 * 2 * 4
const DEFAULT_CACHE_BYTES = 4 * 1024 ** 3
// Change this namespace whenever the pack, canonical PCM, or pinned model changes.
const CACHE_VERSION = 'mgs1-htdemucs-8726e21a-pcm-v1'
const completedName = /^[a-f0-9]{64}-\d{5,8}\.pcm$/
const partialName = /^[a-f0-9]{64}-\d{5,8}-[a-f0-9-]{36}\.partial$/

export function parseStemCacheReference(fingerprint, frameText) {
  if (typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint)
    || typeof frameText !== 'string' || !/^\d{5,8}$/.test(frameText)) return null
  const frames = Number(frameText)
  return validStemFrames(frames) ? { key: `${fingerprint}-${frames}`, frames } : null
}

export function validStemFrames(frames) {
  return Number.isSafeInteger(frames) && frames >= 2 * SAMPLE_RATE && frames <= 360 * SAMPLE_RATE
}

function localStemCacheRoot() {
  const override = process.env.MAGIK_STEMS_CACHE_DIR
  if (override && path.isAbsolute(override)) return override
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA
    return path.join(local && path.isAbsolute(local) ? local : path.join(homedir(), 'AppData', 'Local'), 'MagikCueStudio', 'stems')
  }
  if (process.platform === 'darwin') return path.join(homedir(), 'Library', 'Caches', 'MagikCueStudio', 'stems')
  const xdg = process.env.XDG_CACHE_HOME
  return path.join(xdg && path.isAbsolute(xdg) ? xdg : path.join(homedir(), '.cache'), 'magik-cue-studio', 'stems')
}

function isWithin(directory, root) {
  const relative = path.relative(root, directory)
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function isOneDrivePath(directory) {
  if (directory.split(/[\\/]/).some(part => /^onedrive(?:\s*-.*)?$/i.test(part))) return true
  return [process.env.OneDrive, process.env.OneDriveCommercial, process.env.OneDriveConsumer]
    .some(root => root && path.isAbsolute(root) && isWithin(directory, root))
}

async function safeCacheDirectory(directory) {
  if (!path.isAbsolute(directory) || isOneDrivePath(directory)) return false
  for (let ancestor = directory; ; ancestor = path.dirname(ancestor)) {
    try {
      const actual = path.join(await realpath(ancestor), path.relative(ancestor, directory))
      // A redirected cache directory should not capture writes or evictions
      // intended for this exact local location.
      return path.relative(directory, actual) === '' && !isOneDrivePath(actual)
    } catch (error) {
      if (error?.code !== 'ENOENT' || path.dirname(ancestor) === ancestor) return false
    }
  }
}

export async function inspectStemPack(filename, frames) {
  if (!validStemFrames(frames)) return null
  const size = PACK_HEADER_BYTES + frames * BYTES_PER_FRAME
  try {
    const info = await lstat(filename)
    if (!info.isFile() || info.size !== size) return null
    const file = await open(filename, 'r')
    try {
      const header = Buffer.alloc(PACK_HEADER_BYTES)
      const { bytesRead } = await file.read(header, 0, header.length, 0)
      if (bytesRead !== header.length || header.toString('ascii', 0, 4) !== 'MGS1'
        || header.readUInt32LE(4) !== SAMPLE_RATE || header.readUInt32LE(8) !== frames) return null
      return { filename, size }
    } finally {
      await file.close()
    }
  } catch {
    return null
  }
}

async function prune(directory, keptName, keptSize, budget) {
  const entries = []
  const kept = await lstat(path.join(directory, keptName)).catch(() => null)
  if (!kept?.isFile()) return
  const staleBefore = Date.now() - 24 * 60 * 60 * 1000
  for (const name of await readdir(directory)) {
    if (name === keptName || (!completedName.test(name) && !partialName.test(name))) continue
    const filename = path.join(directory, name)
    const info = await lstat(filename).catch(() => null)
    if (!info?.isFile()) continue
    if (partialName.test(name)) {
      if (info.mtimeMs < staleBefore) await unlink(filename).catch(() => {})
      continue
    }
    entries.push({ filename, size: info.size, time: info.mtimeMs })
  }
  let used = entries.reduce((total, entry) => total + entry.size, keptSize)
  entries.sort((a, b) => a.time - b.time)
  for (const entry of entries) {
    if (used <= budget) break
    // A newer publisher may be trimming the same shared cache.
    if (entry.time > kept.mtimeMs) break
    try { await unlink(entry.filename); used -= entry.size } catch { /* A concurrent reader may hold the pack open. */ }
  }
}

export function createStemCache(root = localStemCacheRoot(), maxBytes = DEFAULT_CACHE_BYTES) {
  const directory = path.join(root, CACHE_VERSION)
  return {
    async find(reference) {
      if (!await safeCacheDirectory(directory)) return null
      const parent = await lstat(directory).catch(() => null)
      if (!parent?.isDirectory()) return null
      const cached = await inspectStemPack(path.join(directory, `${reference.key}.pcm`), reference.frames)
      if (cached) {
        const now = new Date()
        await utimes(cached.filename, now, now).catch(() => {})
      }
      return cached
    },
    async publish(reference, pack) {
      if (pack.size > maxBytes) return null
      const name = `${reference.key}.pcm`
      const filename = path.join(directory, name)
      const partial = path.join(directory, `${reference.key}-${randomUUID()}.partial`)
      let staged = false
      try {
        if (!await safeCacheDirectory(directory)) return null
        await mkdir(directory, { recursive: true, mode: 0o700 })
        if (!await safeCacheDirectory(directory) || !(await lstat(directory)).isDirectory()) return null
        await copyFile(pack.filename, partial, constants.COPYFILE_EXCL)
        staged = true
        await rename(partial, filename)
      } catch {
        if (staged) await unlink(partial).catch(() => {})
        // Keep the validated session pack usable when durable storage is unavailable.
        return null
      }
      await prune(directory, name, pack.size, maxBytes).catch(() => {})
      return { filename, size: pack.size }
    },
  }
}
