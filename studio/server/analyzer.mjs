import { spawn } from 'node:child_process'
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createStemCache, inspectStemPack, parseStemCacheReference } from './stemCache.mjs'

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024
const EXTENSIONS = new Set(['.wav', '.mp3', '.m4a', '.flac', '.aiff', '.aif'])
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const STEM_CACHE_ROUTE = '/api/stems/cache/'

class RequestError extends Error {
  constructor(status, message) { super(message); this.status = status }
}

function validateLocalOrigin(req, cacheRead = false) {
  const protocol = req.socket.encrypted ? 'https:' : 'http:'
  let host
  try { host = new URL(`${protocol}//${req.headers.host}`) } catch { throw new RequestError(403, 'Local access only.') }
  const expectedOrigin = host.origin
  const port = Number(host.port || (protocol === 'https:' ? 443 : 80))
  const site = req.headers['sec-fetch-site']
  const origin = req.headers.origin
  const sameOrigin = origin === expectedOrigin
    || (cacheRead && origin === undefined && (site === 'same-origin' || req.headers['x-stem-cache'] === '1'))
  if (!LOOPBACK_HOSTS.has(host.hostname) || !LOOPBACK_ADDRESSES.has(req.socket.remoteAddress)
    || host.username || host.password || host.pathname !== '/' || host.search || host.hash
    || port !== req.socket.localPort || !sameOrigin || (site && site !== 'same-origin')) {
    throw new RequestError(403, 'Analysis is available only from this local Cue Studio window.')
  }
}

function validateRequest(req) {
  validateLocalOrigin(req)
  if (req.method !== 'POST') throw new RequestError(405, 'Use POST with the selected audio file.')
  if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') {
    throw new RequestError(415, 'Send the original audio bytes without HTTP compression.')
  }
  let name
  try { name = decodeURIComponent(req.headers['x-track-name'] || '') } catch { throw new RequestError(400, 'Invalid track filename.') }
  if (!name || Buffer.byteLength(name, 'utf8') > 255 || /[\\/:\x00-\x1f]/.test(name)) {
    throw new RequestError(400, 'Send the audio basename in X-Track-Name, not a filesystem path.')
  }
  if (!EXTENSIONS.has(path.extname(name).toLowerCase())) {
    throw new RequestError(415, 'Supported audio: WAV, MP3, M4A, FLAC, AIFF, and AIF.')
  }
  const length = Number(req.headers['content-length'])
  if (!Number.isSafeInteger(length) || length <= 0) throw new RequestError(411, 'Send a non-empty File with its content length.')
  if (length > MAX_UPLOAD_BYTES) throw new RequestError(413, 'Choose a file no larger than 100 MiB.')
  return { name, length }
}

function uploadStemReference(headers, length) {
  const fingerprint = headers['x-track-fingerprint']
  const timeline = headers['x-stem-timeline']
  if (fingerprint === undefined && timeline === undefined) return null
  const reference = parseStemCacheReference(fingerprint, timeline)
  if (!reference || length !== 44 + reference.frames * 4) {
    throw new RequestError(400, 'The track fingerprint or stem timeline is invalid.')
  }
  return reference
}

function validateStemInput(bytes, reference) {
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.readUInt32LE(4) !== bytes.length - 8
    || bytes.toString('ascii', 8, 16) !== 'WAVEfmt ' || bytes.readUInt32LE(16) !== 16
    || bytes.readUInt16LE(20) !== 1 || bytes.readUInt16LE(22) !== 2 || bytes.readUInt32LE(24) !== 44_100
    || bytes.readUInt32LE(28) !== 44_100 * 4 || bytes.readUInt16LE(32) !== 4 || bytes.readUInt16LE(34) !== 16
    || bytes.toString('ascii', 36, 40) !== 'data' || bytes.readUInt32LE(40) !== reference.frames * 4) {
    throw new RequestError(400, 'The submitted stem audio does not match its timeline.')
  }
}

function validateAlignment(result) {
  return Number.isFinite(result.snr_db) && result.snr_db >= 12 && Array.isArray(result.offset_samples)
    && result.offset_samples.length > 0 && result.offset_samples.length <= 3
    && result.offset_samples.every(offset => Number.isInteger(offset) && Math.abs(offset) <= 2)
}

function readBody(req, length) {
  return new Promise((resolve, reject) => {
    let chunks = [], received = 0, settled = false
    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      req.off('data', onData).off('end', onEnd).off('error', onError).off('aborted', onAbort)
      if (error) { chunks = []; req.resume(); reject(error) }
      else resolve(Buffer.concat(chunks, received))
    }
    const onData = (chunk) => {
      received += chunk.length
      if (received > length || received > MAX_UPLOAD_BYTES) finish(new RequestError(413, 'Audio upload exceeds its size limit.'))
      else chunks.push(chunk)
    }
    const onEnd = () => finish(received === length ? null : new RequestError(400, 'The audio upload was incomplete.'))
    const onError = () => finish(new RequestError(400, 'The audio upload could not be read.'))
    const onAbort = () => finish(new RequestError(400, 'The audio upload was cancelled.'))
    const timer = setTimeout(() => finish(new RequestError(408, 'The audio upload took too long.')), 30_000)
    req.on('data', onData).on('end', onEnd).on('error', onError).on('aborted', onAbort)
  })
}

function stopProcessTree(child) {
  if (!child.pid) return
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    killer.on('error', () => child.kill())
  } else {
    try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
  }
}

function runPython({ projectRoot, python, temporaryDirectory, inputPath, name, signal, timeoutMs, stemJob }) {
  return new Promise((resolve, reject) => {
    const args = stemJob
      ? ['magik_cue_genie.studio_stems', '--input', inputPath, '--output', stemJob.output,
          '--weights', stemJob.weights, '--device', stemJob.device]
      : ['magik_cue_genie.studio_bridge', '--input', inputPath, `--name=${name}`]
    const child = spawn(python, ['-B', '-m', ...args], {
      cwd: projectRoot, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env, PYTHONPATH: path.join(projectRoot, 'src'), PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8',
        TMP: temporaryDirectory, TEMP: temporaryDirectory, TMPDIR: temporaryDirectory,
      },
    })
    let stdout = [], bytes = 0, failure, settled = false
    const cancel = (error) => { if (!failure) { failure = error; stopProcessTree(child) } }
    const task = stemJob ? 'Stem separation' : 'Analysis'
    const abort = () => cancel(new RequestError(499, `${task} was cancelled.`))
    const timer = setTimeout(() => cancel(new RequestError(504, `${task} took too long. Try a shorter track.`)), timeoutMs)
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      if (error) reject(error)
      else resolve(value)
    }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length
      if (bytes > 4 * 1024 * 1024) cancel(new RequestError(500, 'Analysis returned too much diagnostic data.'))
      else stdout.push(chunk)
    })
    // Drain errors without exposing temporary paths or accumulating unbounded diagnostics.
    child.stderr.resume()
    child.on('error', () => finish(new RequestError(503, stemJob
      ? 'The optional stem runtime could not start. Check MAGIK_STEMS_PYTHON.'
      : 'Python could not start. Set MAGIK_PYTHON to a Python 3.11+ executable.')))
    child.on('close', (code) => {
      if (failure) return finish(failure)
      let result
      try { result = JSON.parse(Buffer.concat(stdout).toString('utf8')) } catch {
        return finish(new RequestError(500, stemJob
          ? 'The local stem runtime did not return a result. Check the Demucs and PyTorch setup.'
          : 'The local analyzer did not return a valid result. Python 3.11+ is required.'))
      }
      if (code !== 0 || result.error) return finish(new RequestError(422, result.error || 'This audio could not be analyzed.'))
      if (stemJob) return finish(null, result)
      if (result.sidecar?.schema_version !== 1) return finish(new RequestError(500, 'The analyzer returned an unsupported result.'))
      finish(null, result)
    })
  })
}

function respond(res, status, data) {
  if (res.destroyed || res.writableEnded) return
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
  res.end(JSON.stringify(data))
}

function respondStemCached(res, cacheStatus) {
  if (res.destroyed || res.writableEnded) return
  res.writeHead(204, { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Stem-Cache-Status': cacheStatus })
  res.end()
}

async function sendStemPack(res, pack, signal, cacheStatus) {
  if (res.destroyed || signal.aborted) return
  let file
  try {
    file = await open(pack.filename, 'r')
  } catch (error) {
    if (error?.code === 'ENOENT' && cacheStatus === 'hit') throw new RequestError(404, 'No saved stems for this track.')
    throw error
  }
  try {
    if (res.destroyed || signal.aborted) return
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': pack.size,
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Stem-Cache-Status': cacheStatus })
    await pipeline(file.createReadStream({ autoClose: false }), res, { signal })
  } finally {
    await file.close()
  }
}

export function createAnalysisMiddleware({ projectRoot, python = process.env.MAGIK_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),
  timeoutMs = 90_000, stemPython = process.env.MAGIK_STEMS_PYTHON, stemWeights = process.env.MAGIK_STEMS_WEIGHTS,
  stemDevice = process.env.MAGIK_STEMS_DEVICE === 'cuda' ? 'cuda' : 'cpu', stemTimeoutMs = 10 * 60_000,
  stemCacheDir, stemCacheMaxBytes }) {
  // The project may live in a synced folder. Keep track copies in OS temp.
  const temporaryRoot = path.resolve(tmpdir())
  const stemCache = createStemCache(stemCacheDir, stemCacheMaxBytes)
  let active = false
  let activeController
  const middleware = async (req, res, next) => {
    const [route, search] = req.url?.split('?') ?? []
    const cacheRead = route?.startsWith(STEM_CACHE_ROUTE)
    if (!cacheRead && route !== '/api/analyze' && route !== '/api/stems') return next()
    const separate = route === '/api/stems'
    let temporaryDirectory, acquired = false
    const controller = new AbortController()
    const disconnected = () => { if (!res.writableEnded) controller.abort() }
    const release = () => {
      if (!acquired) return
      active = false
      activeController = undefined
      acquired = false
    }
    const cleanup = async () => {
      // Delete only the exact fresh job directory created for this request.
      if (temporaryDirectory && path.dirname(temporaryDirectory) === temporaryRoot && path.basename(temporaryDirectory).startsWith('magik-studio-')) {
        await rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
        temporaryDirectory = undefined
      }
    }
    res.on('close', disconnected)
    try {
      if (cacheRead) {
        validateLocalOrigin(req, true)
        if (req.method !== 'GET' && req.method !== 'HEAD') throw new RequestError(405, 'Use GET to restore saved stems.')
        const frames = new URLSearchParams(search).getAll('frames')
        const reference = frames.length === 1 && parseStemCacheReference(route.slice(STEM_CACHE_ROUTE.length), frames[0])
        if (!reference) throw new RequestError(400, 'The track fingerprint or stem timeline is invalid.')
        const cached = await stemCache.find(reference)
        if (!cached) throw new RequestError(404, 'No saved stems for this track.')
        if (req.method === 'HEAD') respondStemCached(res, 'hit')
        else await sendStemPack(res, cached, controller.signal, 'hit')
        return
      }
      const { name, length } = validateRequest(req)
      if (separate && (path.extname(name).toLowerCase() !== '.wav' || length > 44 + 4 * 44_100 * 360)) {
        throw new RequestError(415, 'Choose a track up to 6 minutes for this stem preview.')
      }
      const reference = separate ? uploadStemReference(req.headers, length) : null
      const cacheOnly = separate && req.headers['x-stem-cache-only'] === '1'
      if (cacheOnly && !reference) throw new RequestError(400, 'Select a library track with a matching audio fingerprint.')
      if (reference) {
        const cached = await stemCache.find(reference)
        if (cached) {
          req.resume()
          if (cacheOnly) respondStemCached(res, 'hit')
          else await sendStemPack(res, cached, controller.signal, 'hit')
          return
        }
      }
      if (separate && (!stemPython || !stemWeights)) {
        throw new RequestError(503, 'Configure the optional local stem runtime in the Cue Studio server.')
      }
      if (active) throw new RequestError(409, 'Another track is being analyzed. Wait for it to finish and try again.')
      active = true
      acquired = true
      activeController = controller
      const bytes = await readBody(req, length)
      if (controller.signal.aborted) return
      if (reference) validateStemInput(bytes, reference)
      temporaryDirectory = await mkdtemp(path.join(temporaryRoot, 'magik-studio-'))
      const inputPath = path.join(temporaryDirectory, `input${path.extname(name).toLowerCase()}`)
      await writeFile(inputPath, bytes, { flag: 'wx', mode: 0o600 })
      const stemJob = separate ? {
        output: path.join(temporaryDirectory, 'stems.pcm'), weights: path.resolve(projectRoot, stemWeights), device: stemDevice,
      } : null
      const result = await runPython({ projectRoot, python: separate ? stemPython : python,
        temporaryDirectory, inputPath, name, signal: controller.signal, timeoutMs: separate ? stemTimeoutMs : timeoutMs, stemJob })
      if (stemJob) {
        if ((reference && result.frames !== reference.frames) || !validateAlignment(result)) {
          throw new RequestError(500, 'The stem audio failed its timeline or alignment validation.')
        }
        const pack = await inspectStemPack(stemJob.output, result.frames)
        if (!pack) throw new RequestError(500, 'The stem audio returned an invalid file.')
        if (controller.signal.aborted) return
        const cached = reference ? await stemCache.publish(reference, pack) : null
        if (cached) {
          await cleanup()
          release()
        }
        if (cacheOnly) {
          if (!cached) throw new RequestError(507, 'The local cache could not save these stems. Check disk space or permissions.')
          respondStemCached(res, 'stored')
        } else await sendStemPack(res, cached ?? pack, controller.signal, cached ? 'stored' : 'session-only')
      } else {
        await cleanup()
        respond(res, 200, result)
      }
    } catch (error) {
      req.resume()
      if (res.headersSent) res.destroy()
      else respond(res, error instanceof RequestError ? error.status : 500,
        { error: error instanceof RequestError ? error.message : 'The local worker could not prepare this track.' })
    } finally {
      res.off('close', disconnected)
      try {
        await cleanup()
      } catch {
        console.error('Cue Studio could not remove an analysis temporary directory.')
      } finally {
        release()
      }
    }
  }
  middleware.dispose = () => activeController?.abort()
  return middleware
}

export function localAnalyzerPlugin(projectRoot) {
  const install = (server) => {
    const middleware = createAnalysisMiddleware({ projectRoot })
    server.middlewares.use(middleware)
    server.httpServer?.once('close', middleware.dispose)
  }
  return { name: 'magik-local-analyzer', configureServer: install, configurePreviewServer: install }
}
