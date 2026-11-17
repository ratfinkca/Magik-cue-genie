import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import ts from 'typescript'

const source = name => readFile(new URL(`../src/${name}.ts`, import.meta.url), 'utf8')
function moduleUrl(input) {
  const code = ts.transpileModule(input, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
  return 'data:text/javascript;base64,' + Buffer.from(code).toString('base64')
}
const [analyzer, cues, trackTime, diagnostics, localBackend] = await Promise.all(
  ['analyzer', 'cues', 'trackTime', 'studioDiagnostics', 'localBackend'].map(source))
const cuesUrl = moduleUrl(cues.replace('"./trackTime"', JSON.stringify(moduleUrl(trackTime))))
function loadAnalyzer(backend = localBackend) {
  return import(moduleUrl(analyzer.replace('"./cues"', JSON.stringify(cuesUrl))
    .replace('"./studioDiagnostics"', JSON.stringify(moduleUrl(diagnostics)))
    .replace('"./localBackend"', JSON.stringify(moduleUrl(backend)))))
}
const { analyzeTrack } = await loadAnalyzer()

function prepareClient(t, originalStatus) {
  const calls = []
  const values = {
    document: { baseURI: 'http://127.0.0.1:5173/' },
    OfflineAudioContext: class {
      constructor(_channels, frames) { this.frames = frames }
      createBufferSource() { return { connect() {}, start() {} } }
      async startRendering() { return { getChannelData: () => new Float32Array(this.frames) } }
    },
  }
  for (const [key, value] of Object.entries(values)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key)
    Object.defineProperty(globalThis, key, { configurable: true, value })
    t.after(() => previous ? Object.defineProperty(globalThis, key, previous) : delete globalThis[key])
  }
  t.mock.method(globalThis, 'fetch', async (url, { body, headers }) => {
    assert.equal(url.origin, 'http://127.0.0.1:5173')
    const name = decodeURIComponent(headers['X-Track-Name'])
    calls.push({ name, body })
    if (body instanceof File && originalStatus) return Response.json({ error: 'Upload too large' }, { status: originalStatus })
    return Response.json({ sidecar: { schema_version: 1, source_file: name, analysis: { duration_seconds: 1 }, cues: [], warnings: [] } })
  })
  return { calls, buffer: { duration: 1, numberOfChannels: 2 } }
}

test('a playable file over the analysis limit sends only the bounded PCM copy', async t => {
  const { calls, buffer } = prepareClient(t, 413)
  const file = new File(['fixture'], 'oversized.wav')
  Object.defineProperty(file, 'size', { value: 100 * 1024 * 1024 + 1 })
  const output = await analyzeTrack(file, buffer, new AbortController().signal)
  assert.deepEqual(calls.map(call => call.name), ['studio-audio.wav'])
  assert.equal(calls[0].body.size, 44 + 12_000 * 2 * 2)
  assert.equal(calls[0].body.type, 'audio/wav')
  assert.equal(output.source_file, file.name)
  assert.match(output.warnings.join(' '), /temporary PCM copy/)
})

test('a loopback 413 can retry a decoded track as PCM', async t => {
  const { calls, buffer } = prepareClient(t, 413)
  const file = new File(['fixture'], 'original.flac')
  const output = await analyzeTrack(file, buffer, new AbortController().signal)
  assert.deepEqual(calls.map(call => call.name), ['original.flac', 'studio-audio.wav'])
  assert.equal(calls[0].body, file)
  assert.equal(output.source_file, 'original.flac')
})

test('a hosted page sends neither media nor track name to a local-only analysis endpoint', async t => {
  const { calls, buffer } = prepareClient(t)
  document.baseURI = 'https://example.github.io/Cue-Studio/'
  const file = new File(['fixture'], 'private-track.wav')
  await assert.rejects(analyzeTrack(file, buffer, new AbortController().signal), /Run Cue Studio locally/)
  document.URL = document.baseURI
  document.baseURI = 'http://127.0.0.1:5173/'
  await assert.rejects(analyzeTrack(file, buffer, new AbortController().signal), /Run Cue Studio locally/)
  assert.deepEqual(calls, [])
})

test('the static build does not use the analyzer when previewed on loopback', async t => {
  const { calls, buffer } = prepareClient(t)
  const flaggedBackend = localBackend.replace('import.meta.env?.VITE_STUDIO_STATIC', '"1"')
  assert.notEqual(flaggedBackend, localBackend)
  const staticAnalyzer = await loadAnalyzer(flaggedBackend)
  await assert.rejects(staticAnalyzer.analyzeTrack(new File(['fixture'], 'private.wav'), buffer, new AbortController().signal), /Run Cue Studio locally/)
  assert.deepEqual(calls, [])
})
