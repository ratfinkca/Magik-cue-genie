import { DECK_STEMS } from "./stemPlayback"
import type { DeckStemBank } from "./stemPlayback"
import { LOCAL_BACKEND_REQUIRED, localBackendUrl, studioLocalBackendAvailable } from "./localBackend"

const stemRate = 44_100
export const MAX_STEM_SECONDS = 6 * 60
const maxStemFrames = 48_000 * MAX_STEM_SECONDS
const packMagic = 0x4d475331 // MGS1
const headerSize = 12
const trackFingerprint = /^[0-9a-f]{64}$/

function stemFrameCount(source: AudioBuffer) {
  return Math.round(source.duration * stemRate)
}

export function withinStemMemoryLimit(source: AudioBuffer) {
  return source.duration >= 2 && source.duration <= MAX_STEM_SECONDS && source.length <= maxStemFrames
}

async function separationInput(source: AudioBuffer, signal: AbortSignal) {
  const frames = stemFrameCount(source)
  // Capture the same decoded timeline the decks use, including codec delay and trimming.
  const context = new OfflineAudioContext(2, frames, stemRate)
  const input = context.createBufferSource()
  input.buffer = source
  input.connect(context.destination)
  input.start()
  const samples = await context.startRendering()
  signal.throwIfAborted()
  const data = new ArrayBuffer(44 + frames * 4)
  const header = new DataView(data)
  header.setUint32(0, 0x52494646) // RIFF
  header.setUint32(4, data.byteLength - 8, true)
  header.setUint32(8, 0x57415645) // WAVE
  header.setUint32(12, 0x666d7420) // fmt
  header.setUint32(16, 16, true)
  header.setUint16(20, 1, true)
  header.setUint16(22, 2, true)
  header.setUint32(24, stemRate, true)
  header.setUint32(28, stemRate * 4, true)
  header.setUint16(32, 4, true)
  header.setUint16(34, 16, true)
  header.setUint32(36, 0x64617461) // data
  header.setUint32(40, data.byteLength - 44, true)
  const left = samples.getChannelData(0)
  const right = samples.getChannelData(1)
  const pcm = new Int16Array(data, 44)
  const encode = (value: number) => Math.max(-32768, Math.min(32767, Math.round(value * 32768)))
  for (let at = 0; at < frames; at += 65_536) {
    for (let i = at; i < Math.min(at + 65_536, frames); i++) {
      pcm[i * 2] = encode(left[i])
      pcm[i * 2 + 1] = encode(right[i])
    }
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    signal.throwIfAborted()
  }
  return { frames, audio: new Blob([data], { type: "audio/wav" }) }
}

async function alignToTrack(buffer: AudioBuffer, source: AudioBuffer) {
  if (source.sampleRate === buffer.sampleRate && source.length === buffer.length) return buffer
  const context = new OfflineAudioContext(2, source.length, source.sampleRate)
  const layer = context.createBufferSource()
  layer.buffer = buffer
  layer.connect(context.destination)
  layer.start()
  return context.startRendering()
}

export async function readStemBank(context: BaseAudioContext, body: ReadableStream<Uint8Array>, frameCount: number,
  source: AudioBuffer, signal: AbortSignal): Promise<DeckStemBank> {
  const reader = body.getReader()
  const header = new Uint8Array(headerSize)
  const headerView = new DataView(header.buffer)
  const trailing = new Uint8Array(4)
  const trailingView = new DataView(trailing.buffer)
  const bank: Partial<DeckStemBank> = {}
  let headerBytes = 0
  let trailingBytes = 0
  let stem = 0
  let channel = 0
  let frame = 0
  let layer: AudioBuffer | undefined
  const mismatch = () => new Error("The stem audio does not match this deck timeline.")
  try {
    // Hold one incoming layer at a time to avoid a second, full-track response buffer.
    while (true) {
      signal.throwIfAborted()
      const { value, done } = await reader.read()
      if (done) break
      let offset = 0
      if (headerBytes < headerSize) {
        offset = Math.min(headerSize - headerBytes, value.byteLength)
        header.set(value.subarray(0, offset), headerBytes)
        headerBytes += offset
        if (headerBytes < headerSize) continue
        if (headerView.getUint32(0) !== packMagic || headerView.getUint32(4, true) !== stemRate
          || headerView.getUint32(8, true) !== frameCount) throw mismatch()
      }
      const data = new DataView(value.buffer, value.byteOffset, value.byteLength)
      while (offset < value.byteLength) {
        if (stem === DECK_STEMS.length) throw mismatch()
        layer ??= context.createBuffer(2, frameCount, stemRate)
        const samples = layer.getChannelData(channel)
        if (trailingBytes || value.byteLength - offset < 4) {
          const bytes = Math.min(4 - trailingBytes, value.byteLength - offset)
          trailing.set(value.subarray(offset, offset + bytes), trailingBytes)
          trailingBytes += bytes
          offset += bytes
          if (trailingBytes < 4) break
          samples[frame++] = trailingView.getFloat32(0, true)
          trailingBytes = 0
        } else {
          const end = frame + Math.min(frameCount - frame, Math.floor((value.byteLength - offset) / 4))
          for (; frame < end; frame++, offset += 4) samples[frame] = data.getFloat32(offset, true)
        }
        if (frame === frameCount) {
          frame = 0
          if (++channel === 2) {
            bank[DECK_STEMS[stem++]] = await alignToTrack(layer, source)
            signal.throwIfAborted()
            channel = 0
            layer = undefined
          }
        }
      }
    }
    if (stem !== DECK_STEMS.length) throw mismatch()
    return bank as DeckStemBank
  } catch (error) {
    void reader.cancel().catch(() => {})
    throw error
  } finally {
    reader.releaseLock()
  }
}

async function readResponseStemBank(context: BaseAudioContext, response: Response, frames: number, source: AudioBuffer, signal: AbortSignal) {
  if (!response.ok || !response.headers.get("content-type")?.includes("application/octet-stream")) {
    const payload = await response.json().catch(() => null)
    const error = typeof payload?.error === "string" ? payload.error : "Start the local Cue Studio server to separate stems."
    throw new Error(error)
  }
  if (!response.body) throw new Error("No stem audio returned from the local analyzer.")
  return readStemBank(context, response.body, frames, source, signal)
}

export async function readCachedDeckStems(context: BaseAudioContext, source: AudioBuffer, fingerprint: string | undefined, signal: AbortSignal) {
  if (!studioLocalBackendAvailable() || !fingerprint || !trackFingerprint.test(fingerprint) || !withinStemMemoryLimit(source)) return null
  const frames = stemFrameCount(source)
  const response = await requestStemCache(fingerprint, frames, "GET", signal)
  if (response.status === 404) return null
  return readResponseStemBank(context, response, frames, source, signal)
}

function requestStemCache(fingerprint: string, frames: number, method: "GET" | "HEAD", signal: AbortSignal) {
  const url = localBackendUrl(`api/stems/cache/${fingerprint}`)
  if (!url) throw new Error(LOCAL_BACKEND_REQUIRED)
  url.searchParams.set("frames", String(frames))
  return fetch(url, {
    method, credentials: "same-origin", redirect: "error", signal, cache: "no-store", headers: { "X-Stem-Cache": "1" },
  })
}

/** Concurrent requests for the same decoded track can share read-backed buffers. */
export function createStemCacheReader() {
  const pending = new Map<string, { count: number; controller: AbortController; read: Promise<DeckStemBank | null> }>()
  let queued = Promise.resolve()
  return (context: BaseAudioContext, source: AudioBuffer, fingerprint: string, signal: AbortSignal) => {
    signal.throwIfAborted()
    const key = `${fingerprint}/${source.sampleRate}/${source.length}`
    let read = pending.get(key)
    if (!read) {
      const controller = new AbortController()
      const promise = queued.then(() => {
        controller.signal.throwIfAborted()
        return readCachedDeckStems(context, source, fingerprint, controller.signal)
      }).finally(() => {
        if (pending.get(key)?.controller === controller) pending.delete(key)
      })
      queued = promise.then(() => {}, () => {})
      read = { count: 0, controller, read: promise }
      pending.set(key, read)
    }
    const request = read
    request.count++
    return new Promise<DeckStemBank | null>((resolve, reject) => {
      function finish() {
        signal.removeEventListener("abort", abort)
        if (--request.count === 0 && pending.get(key) === request) {
          pending.delete(key)
          request.controller.abort()
        }
      }
      function abort() { finish(); reject(signal.reason) }
      signal.addEventListener("abort", abort, { once: true })
      void request.read.then(bank => {
        if (!signal.aborted) { finish(); resolve(bank) }
      }, error => {
        if (!signal.aborted) { finish(); reject(error) }
      })
    })
  }
}

function checkStemLength(source: AudioBuffer) {
  if (!withinStemMemoryLimit(source)) {
    throw new Error("Choose a track between 2 seconds and 6 minutes. Playback rates above 48 kHz support shorter tracks.")
  }
}

async function requestSeparation(source: AudioBuffer, signal: AbortSignal, fingerprint?: string, cacheOnly = false) {
  const url = localBackendUrl("api/stems")
  if (!url) throw new Error(LOCAL_BACKEND_REQUIRED)
  const { audio, frames } = await separationInput(source, signal)
  const headers: Record<string, string> = { "Content-Type": "application/octet-stream", "X-Track-Name": "studio-stems.wav" }
  if (fingerprint && trackFingerprint.test(fingerprint)) {
    headers["X-Track-Fingerprint"] = fingerprint
    headers["X-Stem-Timeline"] = String(frames)
  }
  if (cacheOnly) headers["X-Stem-Cache-Only"] = "1"
  let response: Response
  try {
    response = await fetch(url, {
      method: "POST", credentials: "same-origin", redirect: "error", signal, headers, body: audio,
    })
  } catch (cause) {
    signal.throwIfAborted()
    throw new Error("Start the local Cue Studio server to separate stems.", { cause })
  }
  return { response, frames }
}

export async function fetchDeckStems(context: BaseAudioContext, source: AudioBuffer, signal: AbortSignal, fingerprint?: string) {
  checkStemLength(source)
  const { response, frames } = await requestSeparation(source, signal, fingerprint)
  return readResponseStemBank(context, response, frames, source, signal)
}

/** Prepare reusable stems without allocating or downloading four playback buffers. */
export async function prepareCachedDeckStems(source: AudioBuffer, fingerprint: string, signal: AbortSignal) {
  checkStemLength(source)
  if (!trackFingerprint.test(fingerprint)) throw new Error("Add this audio file to the local library first.")
  const frames = stemFrameCount(source)
  const cached = await requestStemCache(fingerprint, frames, "HEAD", signal)
  if (cached.status === 204 && cached.headers.get("X-Stem-Cache-Status") === "hit") return
  const { response } = await requestSeparation(source, signal, fingerprint, true)
  if (response.status === 204 && ["stored", "hit"].includes(response.headers.get("X-Stem-Cache-Status") ?? "")) return
  if (response.headers.get("content-type")?.includes("application/json")) {
    const payload = await response.json().catch(() => null)
    if (typeof payload?.error === "string") throw new Error(payload.error)
  } else await response.body?.cancel()
  throw new Error("The local Cue Studio server could not save the stems.")
}
