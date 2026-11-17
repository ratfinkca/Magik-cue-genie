import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createAnalysisMiddleware } from './analyzer.mjs'

const projectRoot = fileURLToPath(new URL('../..', import.meta.url))

function pulseWav() {
  const rate = 8_000, frames = rate * 12
  const bytes = Buffer.alloc(44 + frames * 2)
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8)
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28)
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34)
  bytes.write('data', 36); bytes.writeUInt32LE(frames * 2, 40)
  for (let index = 0; index < frames; index++) {
    const sample = index % (rate / 2) < rate / 10 ? Math.sin(2 * Math.PI * 440 * index / rate) * 0.8 : 0
    bytes.writeInt16LE(Math.round(sample * 32767), 44 + index * 2)
  }
  return bytes
}

async function serve(t, options = {}) {
  const middleware = createAnalysisMiddleware({ projectRoot, ...options })
  const server = http.createServer((req, res) => middleware(req, res, () => { res.writeHead(404); res.end() }))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    middleware.dispose()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  })
  return { server, origin: `http://127.0.0.1:${server.address().port}` }
}

async function upload(origin, name, bytes, headers = {}) {
  return fetch(`${origin}/api/analyze`, {
    method: 'POST', headers: { Origin: origin, 'X-Track-Name': encodeURIComponent(name), ...headers }, body: bytes,
  })
}

test('runs the real analyzer on synthetic PCM and preserves Unicode filename and supported beat times', async t => {
  const { origin } = await serve(t)
  const bytes = pulseWav(), original = Buffer.from(bytes)
  const response = await upload(origin, 'Étude 120.wav', bytes)
  assert.equal(response.status, 200)
  const data = await response.json()
  assert.equal(data.sidecar.schema_version, 1)
  assert.equal(data.sidecar.source_file, 'Étude 120.wav')
  assert.equal(data.sidecar.analysis.duration_seconds, 12)
  assert.equal(data.sidecar.analysis.estimated_bpm, 120)
  const grid = data.sidecar.analysis.studio_beatgrid
  assert.equal(grid.status, 'estimated')
  assert.equal(grid.meter, null)
  assert.equal(grid.downbeat_verified, false)
  assert.ok(grid.beat_times_seconds.length >= 20)
  assert.ok(data.sidecar.cues.every(cue => cue.metadata.requires_review))
  assert.deepEqual(bytes, original)
})

test('rejects foreign origins, missing origins, traversal names and unsupported formats before analysis', async t => {
  const { origin } = await serve(t)
  const bytes = pulseWav()
  assert.equal((await upload(origin, 'track.wav', bytes, { Origin: 'https://example.org' })).status, 403)
  assert.equal((await upload(origin, 'track.wav', bytes, { Origin: '' })).status, 403)
  assert.equal((await upload(origin, '../track.wav', bytes)).status, 400)
  assert.equal((await upload(origin, 'C:\\Music\\track.wav', bytes)).status, 400)
  assert.equal((await upload(origin, 'track.exe', bytes)).status, 415)
})

test('returns a useful decoding error instead of a placeholder success', async t => {
  const { origin } = await serve(t)
  const response = await upload(origin, 'broken.wav', Buffer.from('not audio'))
  assert.equal(response.status, 422)
  const result = await response.json()
  assert.match(result.error, /WAV/)
  assert.equal(result.sidecar, undefined)
})

test('accepts a filename beginning with a dash as data, never as a Python option', async t => {
  const { origin } = await serve(t)
  const response = await upload(origin, '--track.wav', pulseWav())
  assert.equal(response.status, 200)
  assert.equal((await response.json()).sidecar.source_file, '--track.wav')
})

test('allows only one active upload or analysis', async t => {
  const { server, origin } = await serve(t)
  const arrived = once(server, 'request')
  const pending = http.request(`${origin}/api/analyze`, {
    method: 'POST', headers: { Origin: origin, 'X-Track-Name': 'track.wav', 'Content-Length': 100 },
  })
  pending.on('error', () => {})
  pending.write(Buffer.from('RIFF'))
  await arrived
  const response = await upload(origin, 'second.wav', pulseWav())
  assert.equal(response.status, 409)
  pending.destroy()
})

test('missing Python returns an actionable service error', async t => {
  const { origin } = await serve(t, { python: 'magik-python-executable-does-not-exist' })
  const response = await upload(origin, 'track.wav', pulseWav())
  assert.equal(response.status, 503)
  assert.match((await response.json()).error, /MAGIK_PYTHON/)
})

test('stem jobs reuse the local-only guard and report optional runtime setup', async t => {
  const { origin } = await serve(t, { stemPython: '', stemWeights: '' })
  const route = `${origin}/api/stems`
  const headers = { Origin: origin, 'X-Track-Name': 'studio-stems.wav' }
  const body = pulseWav()
  assert.equal((await fetch(route, { method: 'POST', headers: { ...headers, Origin: 'https://example.org' }, body })).status, 403)
  const response = await fetch(route, { method: 'POST', headers, body })
  assert.equal(response.status, 503)
  assert.match((await response.json()).error, /optional local stem runtime/)
})

async function fakeStemWorker(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'magik-stem-test-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }))
  const moduleDir = path.join(root, 'src', 'magik_cue_genie')
  await mkdir(moduleDir, { recursive: true })
  await writeFile(path.join(moduleDir, 'studio_stems.py'), `
import json
from pathlib import Path
import struct
import sys
import wave
with wave.open(sys.argv[sys.argv.index('--input') + 1], 'rb') as pcm:
    frames = pcm.getnframes()
output = Path(sys.argv[sys.argv.index('--output') + 1])
with output.open('xb') as pack:
    pack.write(struct.pack('<4sII', b'MGS1', 44100, frames))
    pack.write(bytes(frames * 32))
print(json.dumps(dict(frames=frames, snr_db=26., offset_samples=[0, 0, 0])))
`)
  return { projectRoot: root, stemCacheDir: path.join(root, 'stem-cache'), stemWeights: root,
    stemPython: process.env.MAGIK_PYTHON || (process.platform === 'win32' ? 'python' : 'python3') }
}

const stemFrames = 2 * 44_100
const stemPackBytes = 12 + stemFrames * 32

function stemWav() {
  const bytes = pulseWav().subarray(0, 44)
  const wave = Buffer.concat([bytes, Buffer.alloc(stemFrames * 4)])
  wave.writeUInt32LE(wave.length - 8, 4)
  wave.writeUInt16LE(2, 22)
  wave.writeUInt32LE(44_100, 24)
  wave.writeUInt32LE(44_100 * 4, 28)
  wave.writeUInt16LE(4, 32)
  wave.writeUInt32LE(stemFrames * 4, 40)
  return wave
}

function sendStemJob(origin, id = 'a'.repeat(64), frames = stemFrames, extraHeaders = {}) {
  return fetch(`${origin}/api/stems`, { method: 'POST', body: stemWav(),
    headers: { Origin: origin, 'X-Track-Name': 'studio-stems.wav',
      'X-Track-Fingerprint': id, 'X-Stem-Timeline': String(frames), ...extraHeaders } })
}

function loadCachedStems(origin, id = 'a'.repeat(64), frames = stemFrames, headers = { 'X-Stem-Cache': '1' }) {
  return fetch(`${origin}/api/stems/cache/${id}?frames=${frames}`, { headers })
}

test('publishes a validated stem cache and restores its exact timeline without a model process', async t => {
  const options = await fakeStemWorker(t)
  const { origin } = await serve(t, options)
  assert.equal((await loadCachedStems(origin)).status, 404)
  assert.equal((await sendStemJob(origin, 'x'.repeat(64))).status, 400)
  assert.equal((await sendStemJob(origin, 'a'.repeat(64), stemFrames + 1)).status, 400)
  const prepared = await sendStemJob(origin)
  assert.equal(prepared.status, 200)
  assert.equal(prepared.headers.get('X-Stem-Cache-Status'), 'stored')
  assert.equal(Number(prepared.headers.get('Content-Length')), stemPackBytes)
  const expected = Buffer.from(await prepared.arrayBuffer())
  assert.equal(expected.toString('ascii', 0, 4), 'MGS1')

  const recovered = await serve(t, { ...options, stemPython: '', stemWeights: '' })
  const cached = await loadCachedStems(recovered.origin, undefined, undefined, { 'Sec-Fetch-Site': 'same-origin' })
  assert.equal(cached.status, 200)
  assert.equal(cached.headers.get('Cache-Control'), 'no-store')
  assert.equal(cached.headers.get('X-Stem-Cache-Status'), 'hit')
  assert.deepEqual(Buffer.from(await cached.arrayBuffer()), expected)
  assert.equal((await loadCachedStems(recovered.origin, undefined, stemFrames + 1)).status, 404)
  assert.equal((await loadCachedStems(recovered.origin, undefined, undefined, {})).status, 403)
  assert.equal((await loadCachedStems(recovered.origin, undefined, undefined,
    { 'Sec-Fetch-Site': 'cross-site', 'X-Stem-Cache': '1' })).status, 403)
  assert.equal((await loadCachedStems(recovered.origin, undefined, undefined, { Origin: 'https://example.org' })).status, 403)

  const [namespace] = await readdir(options.stemCacheDir)
  const folder = path.join(options.stemCacheDir, namespace)
  const [entry] = await readdir(folder)
  await writeFile(path.join(folder, entry), 'not a stem pack')
  assert.equal((await loadCachedStems(recovered.origin)).status, 404)
})

test('cached stem budget expires older completed entries without affecting the latest pack', async t => {
  const options = await fakeStemWorker(t)
  const { origin } = await serve(t, { ...options, stemCacheMaxBytes: stemPackBytes * 1.5 })
  const first = '1'.repeat(64)
  const second = '2'.repeat(64)
  for (const id of [first, second]) {
    const prepared = await sendStemJob(origin, id)
    assert.equal(prepared.status, 200)
    await prepared.arrayBuffer()
  }
  assert.equal((await loadCachedStems(origin, first)).status, 404)
  const retained = await loadCachedStems(origin, second)
  assert.equal(retained.status, 200)
  await retained.arrayBuffer()
})

test('batch stem preparation writes the cache without sending the pack to the browser', async t => {
  const options = await fakeStemWorker(t)
  const { origin } = await serve(t, options)
  const cacheOnly = { 'X-Stem-Cache-Only': '1' }
  const prepared = await sendStemJob(origin, undefined, undefined, cacheOnly)
  assert.equal(prepared.status, 204)
  assert.equal(prepared.headers.get('X-Stem-Cache-Status'), 'stored')
  assert.equal((await prepared.arrayBuffer()).byteLength, 0)
  const recovered = await serve(t, { ...options, stemPython: '', stemWeights: '' })
  const checked = await fetch(`${recovered.origin}/api/stems/cache/${'a'.repeat(64)}?frames=${stemFrames}`,
    { method: 'HEAD', headers: { 'X-Stem-Cache': '1' } })
  assert.equal(checked.status, 204)
  assert.equal(checked.headers.get('X-Stem-Cache-Status'), 'hit')
  assert.equal((await checked.arrayBuffer()).byteLength, 0)
  const duplicate = await sendStemJob(recovered.origin, undefined, undefined, cacheOnly)
  assert.equal(duplicate.status, 204)
  assert.equal(duplicate.headers.get('X-Stem-Cache-Status'), 'hit')
})

async function assertSessionOnly(t, options, stemCacheDir) {
  const { origin } = await serve(t, { ...options, stemCacheDir })
  const prepared = await sendStemJob(origin)
  assert.equal(prepared.status, 200)
  assert.equal(prepared.headers.get('X-Stem-Cache-Status'), 'session-only')
  await prepared.arrayBuffer()
  assert.equal((await loadCachedStems(origin)).status, 404)
}

test('a sync folder cache override keeps validated stems session-only', async t => {
  const options = await fakeStemWorker(t)
  const synced = path.join(options.projectRoot, 'OneDrive', 'stems')
  await assertSessionOnly(t, options, synced)
  await assert.rejects(readdir(synced), { code: 'ENOENT' })
})

test('a redirected cache keeps validated stems session-only', async t => {
  const options = await fakeStemWorker(t)
  const destination = path.join(options.projectRoot, 'outside-cache')
  const redirected = path.join(options.projectRoot, 'cache-link')
  await mkdir(destination)
  try {
    await symlink(destination, redirected, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error
    t.skip('The filesystem sandbox cannot create a redirection fixture.')
    return
  }
  await assertSessionOnly(t, options, redirected)
  assert.deepEqual(await readdir(destination), [])
})

test('enforces the worker deadline', async t => {
  const { origin } = await serve(t, { timeoutMs: 1 })
  const response = await upload(origin, 'track.wav', pulseWav())
  assert.equal(response.status, 504)
  assert.match((await response.json()).error, /too long/)
})
