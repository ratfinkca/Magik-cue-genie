import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import vm from 'node:vm'
import { studioPwaPlugin } from '../server/studioPwa.mjs'

function buildWorker(code = 'console.log("Studio")') {
  const plugin = studioPwaPlugin()
  const bundle = {
    'index.html': { type: 'asset', source: '<title>Cue Studio</title>' },
    'assets/index-abcd.js': { type: 'chunk', code },
    'assets/parser-efgh.js': { type: 'chunk', code: 'export default {}' },
    'assets/Stretch-ijk.mjs': { type: 'asset', source: 'export default {}' },
    'assets/stretch-v2.wasm': { type: 'asset', source: new Uint8Array([0, 97, 115, 109]) },
    'assets/font.woff2': { type: 'asset', source: 'test font' },
    'assets/selected-track.wav': { type: 'asset', source: 'user audio' },
    'assets/selected-track.json': { type: 'asset', source: 'user data' },
    'api/cues.js': { type: 'chunk', code: 'private API' },
  }
  let output
  plugin.generateBundle.handler.call({ emitFile(file) { output = file }, error: assert.fail }, {}, bundle)
  assert.equal(output.fileName, 'studio-sw.js')
  return output.source
}

test('build versions the static shell, lazy parser, audio worklet, WASM, fonts and manifest icons', () => {
  const worker = buildWorker()
  const files = JSON.parse(worker.match(/^const FILES = (.+);$/m)[1])
  for (const file of ['index.html', 'assets/index-abcd.js', 'assets/parser-efgh.js',
    'assets/Stretch-ijk.mjs', 'assets/stretch-v2.wasm', 'assets/font.woff2', 'manifest.webmanifest',
    'icons/studio-192.png', 'icons/studio-512.png']) assert.ok(files.includes(file), file)
  assert.ok(!files.some(path => path.includes('selected-track') || path.startsWith('api/')))
  assert.equal(buildWorker(), worker)
  assert.notEqual(buildWorker('console.log("Studio updated")'), worker)
})

test('manifest and app icons stay inside the configured GitHub Pages project', async () => {
  const scope = 'https://example.github.io/Magik-cue-genie/'
  const base = new URL(scope).pathname
  const plugin = studioPwaPlugin()
  plugin.configResolved({ base })
  const manifestLink = plugin.transformIndexHtml().find(tag => tag.attrs.rel === 'manifest')
  assert.equal(manifestLink.attrs.href, `${base}manifest.webmanifest`)
  const manifestUrl = new URL(manifestLink.attrs.href, scope)
  const manifest = JSON.parse(await readFile(new URL('../public/manifest.webmanifest', import.meta.url), 'utf8'))
  for (const path of [manifest.id, manifest.start_url, manifest.scope]) assert.equal(new URL(path, manifestUrl).href, scope)
  for (const icon of manifest.icons) assert.ok(new URL(icon.src, manifestUrl).href.startsWith(`${scope}icons/`))
})

async function checkOfflineScope(scope) {
  const handlers = {}
  const entries = new Map()
  const deleted = []
  let claimed = false
  const instance = {
    self: {
      registration: { scope },
      addEventListener(type, handler) { handlers[type] = handler },
      clients: { async claim() { claimed = true } },
    },
    Request, URL,
    caches: {
      async keys() { return [`magik-cue-studio:${new URL(scope).pathname}:old`, 'magik-cue-studio:/other/:keep', 'another-app'] },
      async delete(name) { deleted.push(name) },
      async open() {
        return {
          async addAll(requests) {
            for (const request of requests) {
              assert.equal(new URL(request.url).origin, new URL(scope).origin)
              assert.equal(request.cache, 'reload')
              entries.set(request.url, `cached:${request.url}`)
            }
          },
          async match(url) { return entries.get(url) },
        }
      },
    },
    fetch() { throw new Error('The network is offline') },
  }
  vm.runInNewContext(buildWorker(), instance)
  const wait = action => new Promise((resolve, reject) => handlers[action]({ waitUntil: pending => pending.then(resolve, reject) }))
  await wait('install')
  await wait('activate')
  assert.deepEqual(deleted, [`magik-cue-studio:${new URL(scope).pathname}:old`])
  assert.ok(claimed)

  function load(url, { method = 'GET', mode = 'same-origin', headers = {} } = {}) {
    let response
    handlers.fetch({
      request: { url: new URL(url, scope).href, method, mode, headers: new Headers(headers) },
      respondWith(pending) { response = pending },
    })
    return response
  }

  assert.equal(await load('?source=install', { mode: 'navigate' }), `cached:${scope}index.html`)
  assert.equal(await load('assets/Stretch-ijk.mjs'), `cached:${scope}assets/Stretch-ijk.mjs`)
  assert.equal(await load('assets/parser-efgh.js'), `cached:${scope}assets/parser-efgh.js`)
  assert.equal(load('api/analyze', { method: 'POST' }), undefined)
  assert.equal(load('api/analyze', { mode: 'navigate' }), undefined)
  assert.equal(load('api/stems/cache/private-fingerprint'), undefined)
  assert.equal(load('assets/selected-track.wav'), undefined)
  assert.equal(load('my-cues.json', { mode: 'navigate' }), undefined)
  assert.equal(load('/other/'), undefined)
  assert.equal(load('https://example.com/assets/parser-efgh.js'), undefined)
  assert.equal(load('assets/parser-efgh.js', { headers: { Range: 'bytes=0-100' } }), undefined)
}

for (const scope of ['http://127.0.0.1:4173/', 'https://example.github.io/Magik-cue-genie/']) {
  test(`offline fetch leaves uploads and outside URLs alone at ${scope}`, () => checkOfflineScope(scope))
}
