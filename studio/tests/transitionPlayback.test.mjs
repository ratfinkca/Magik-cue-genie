import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { test } from "node:test"
import { createElement } from "react"
import { renderToString } from "react-dom/server"
import ts from "typescript"

const options = { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }
const moduleUrl = source => "data:text/javascript;base64," + Buffer.from(source).toString("base64")
const eq = await readFile(new URL("../src/transitionEq.ts", import.meta.url), "utf8")
const mixer = await readFile(new URL("../src/transitionMixer.ts", import.meta.url), "utf8")
const fx = await readFile(new URL("../src/transitionFx.ts", import.meta.url), "utf8")
const session = await readFile(new URL("../src/deckSession.ts", import.meta.url), "utf8")
const library = await readFile(new URL("../src/trackLibrary.ts", import.meta.url), "utf8")
const playlist = await readFile(new URL("../src/trackPlaylist.ts", import.meta.url), "utf8")
const key = await readFile(new URL("../src/key.ts", import.meta.url), "utf8")
const metadata = await readFile(new URL("../src/trackMetadata.ts", import.meta.url), "utf8")
const sessionUrl = moduleUrl(ts.transpileModule(session, options).outputText)
const playlistUrl = moduleUrl(ts.transpileModule(playlist, options).outputText
  .replaceAll(/["']\.\/deckSession["']/g, JSON.stringify(sessionUrl)))
const metadataUrl = moduleUrl(ts.transpileModule(metadata, options).outputText
  .replaceAll(/["']music-metadata["']/g, JSON.stringify(import.meta.resolve("music-metadata"))))
const matchEvidence = await readFile(new URL("../src/trackMatchEvidence.ts", import.meta.url), "utf8")
const matchEvidenceUrl = moduleUrl(ts.transpileModule(matchEvidence, options).outputText)
const libraryUrl = moduleUrl(ts.transpileModule(library, options).outputText
  .replaceAll(/["']\.\/deckSession["']/g, JSON.stringify(sessionUrl))
  .replaceAll(/["']\.\/trackPlaylist["']/g, JSON.stringify(playlistUrl))
  .replaceAll(/["']\.\/trackMetadata["']/g, JSON.stringify(metadataUrl))
  .replaceAll(/["']\.\/trackMatchEvidence["']/g, JSON.stringify(matchEvidenceUrl))
  .replaceAll(/["']\.\/key["']/g, JSON.stringify(moduleUrl(ts.transpileModule(key, options).outputText))))
const diagnostics = await readFile(new URL("../src/studioDiagnostics.ts", import.meta.url), "utf8")
const meter = await readFile(new URL("../src/levelMeter.ts", import.meta.url), "utf8")
const trackTime = await readFile(new URL("../src/trackTime.ts", import.meta.url), "utf8")
const cues = await readFile(new URL("../src/cues.ts", import.meta.url), "utf8")
const trackTimeUrl = moduleUrl(ts.transpileModule(trackTime, options).outputText)
const cuesUrl = moduleUrl(ts.transpileModule(cues, options).outputText
  .replaceAll(/["']\.\/trackTime["']/g, JSON.stringify(trackTimeUrl)))
const transport = await readFile(new URL("../src/transitionAudio.ts", import.meta.url), "utf8")
const stemPlayback = await readFile(new URL("../src/stemPlayback.ts", import.meta.url), "utf8")
const stemUrl = moduleUrl(ts.transpileModule(stemPlayback, options).outputText)
const localStems = await readFile(new URL("../src/localStems.ts", import.meta.url), "utf8")
const localBackend = await readFile(new URL("../src/localBackend.ts", import.meta.url), "utf8")
const localPreparationQueue = await readFile(new URL("../src/localPreparationQueue.ts", import.meta.url), "utf8")
const localStemsUrl = moduleUrl(ts.transpileModule(localStems, options).outputText
  .replaceAll(/["']\.\/localBackend["']/g, JSON.stringify(moduleUrl(ts.transpileModule(localBackend, options).outputText)))
  .replaceAll(/["']\.\/stemPlayback["']/g, JSON.stringify(stemUrl)))
const output = ts.transpileModule(transport, options).outputText
const deckSourceExport = output.replaceAll(/(^import .*?from )["'](?:\.\/demo|\.\/keyLock)["'];?\r?\n/gm, "")
  .replaceAll(/["']\.\/stemPlayback["']/g, JSON.stringify(stemUrl))
  .replaceAll(/["']\.\/localStems["']/g, JSON.stringify(localStemsUrl))
  .replaceAll(/["']\.\/localPreparationQueue["']/g, JSON.stringify(moduleUrl(ts.transpileModule(localPreparationQueue, options).outputText)))
  .replaceAll(/["']react["']/g, JSON.stringify(import.meta.resolve("react")))
  .replaceAll(/["']\.\/transitionEq["']/g, JSON.stringify(moduleUrl(ts.transpileModule(eq, options).outputText)))
  .replaceAll(/["']\.\/transitionMixer["']/g, JSON.stringify(moduleUrl(ts.transpileModule(mixer, options).outputText)))
  .replaceAll(/["']\.\/transitionFx["']/g, JSON.stringify(moduleUrl(ts.transpileModule(fx, options).outputText)))
  .replaceAll(/["']\.\/deckSession["']/g, JSON.stringify(sessionUrl))
  .replaceAll(/["']\.\/trackLibrary["']/g, JSON.stringify(libraryUrl))
  .replaceAll(/["']\.\/studioDiagnostics["']/g, JSON.stringify(moduleUrl(ts.transpileModule(diagnostics, options).outputText)))
  .replaceAll(/["']\.\/cues["']/g, JSON.stringify(cuesUrl))
  .replaceAll(/["']\.\/levelMeter["']/g, JSON.stringify(moduleUrl(ts.transpileModule(meter, options).outputText)))
  .replaceAll(/["']\.\/trackTime["']/g, JSON.stringify(trackTimeUrl))
const { createDeckSources, createTransitionOutput, useTransitionAudio } = await import(moduleUrl(deckSourceExport))
const { DEFAULT_DECK_FX } = await import(moduleUrl(ts.transpileModule(fx, options).outputText))

function audioNode() {
  const param = () => ({ value: 0, setValueAtTime(value) { this.value = value }, linearRampToValueAtTime() {},
    cancelScheduledValues() {}, setTargetAtTime(value) { this.value = value } })
  return {
    gain: param(), playbackRate: param(), frequency: param(), Q: param(), pan: param(),
    connect(target) { this.connectedTo = target }, disconnect() { this.connectedTo = undefined },
    start(when, offset, duration) { this.begin = { when, offset }; this.duration = duration },
    stop(when) { this.stopAt = when },
  }
}

function setup() {
  const native = []
  const filters = []
  const panners = []
  const context = {
    currentTime: 5,
    sampleRate: 48_000,
    createGain: audioNode,
    createBiquadFilter() {
      const node = audioNode()
      filters.push(node)
      return node
    },
    createStereoPanner() {
      const node = audioNode()
      panners.push(node)
      return node
    },
    createBufferSource() {
      const node = audioNode()
      native.push(node)
      return node
    },
  }
  assert.equal(typeof createDeckSources, "function", "independent per-deck sources must be available")
  const sources = createDeckSources()
  const start = (id, offset, loop = null, onEnd = () => {}, startAt = 5, excerptEnd, keyLock, carryPosition, stems) => sources.start(id, {
    context, destination: audioNode(), startAt, offset, excerptEnd, keyLock, carryPosition, stems,
    buffer: { duration: 20 }, speed: 1, loop, level: .5,
    eq: { low: 0, mid: 0, high: 0 }, pan: 0, filter: 0, onEnd,
  })
  return { context, sources, start, native, filters, panners }
}

test("stem levels use the shared loop, seek and tempo and leave the other deck alone", () => {
  const { context, sources, native, start } = setup()
  const stems = Object.fromEntries(["vocals", "drums", "bass", "other"].map(name => [name, { name, duration: 20 }]))
  start("A", 1.25, { start: 1, end: 3 }, undefined, 5, undefined, undefined, false, stems)
  start("B", 2, null, undefined, 5, undefined, undefined, false, stems)
  const [a, b] = [native.slice(0, 5), native.slice(5, 10)]
  assert.deepEqual(a.map(node => node.begin), Array(5).fill({ when: 5, offset: 1.25 }))
  assert.deepEqual(a.map(node => [node.loopStart, node.loopEnd]), Array(5).fill([1, 3]))
  assert.deepEqual(a.map(node => node.connectedTo.gain.value), [1, 0, 0, 0, 0])
  sources.setStemLevels("A", { vocals: 70, drums: 0, bass: 100, other: 100 })
  assert.deepEqual(a.map(node => node.connectedTo.gain.value), [0, .7, 0, 1, 1])
  assert.deepEqual(b.map(node => node.connectedTo.gain.value), [1, 0, 0, 0, 0])
  sources.setStemLevels("A", { vocals: 100, drums: 100, bass: 100, other: 100 })
  assert.deepEqual(a.map(node => node.connectedTo.gain.value), [1, 0, 0, 0, 0])
  sources.setSpeed("A", 1.25)
  assert.ok(a.every(node => node.playbackRate.value === 1.25))
  assert.ok(b.every(node => node.playbackRate.value === 1))
  context.currentTime = 7
  assert.equal(sources.position("A"), 1.75)
  start("A", 8.75, null, undefined, 7.1, 9, undefined, false, stems)
  assert.deepEqual(native.slice(-5).map(node => node.begin), Array(5).fill({ when: 7.1, offset: 8.75 }))
  assert.ok(native.slice(-5).every(node => node.duration === .25))
  assert.ok(b.every(node => node.stopAt === undefined))
})

test("a hosted page never looks up track fingerprints or submits audio for separation", async t => {
  const { readCachedDeckStems, fetchDeckStems, prepareCachedDeckStems } = await import(localStemsUrl)
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document")
  Object.defineProperty(globalThis, "document", { configurable: true, value: { baseURI: "https://example.github.io/Cue-Studio/" } })
  t.after(() => previous ? Object.defineProperty(globalThis, "document", previous) : delete globalThis.document)
  const fetch = t.mock.method(globalThis, "fetch", () => assert.fail("A hosted Studio may not send track information"))
  const source = { duration: 2, length: 88_200, sampleRate: 44_100 }
  const fingerprint = "a".repeat(64)
  const signal = new AbortController().signal
  assert.equal(await readCachedDeckStems({}, source, fingerprint, signal), null)
  await assert.rejects(fetchDeckStems({}, source, signal, fingerprint), /Run Cue Studio locally/)
  await assert.rejects(prepareCachedDeckStems(source, fingerprint, signal), /Run Cue Studio locally/)
  assert.equal(fetch.mock.callCount(), 0)
})

test("cache reads use exact fingerprint and timeline and share pending decoded buffers", async t => {
  const { createStemCacheReader } = await import(localStemsUrl)
  const context = { createBuffer(count, length, sampleRate) {
    const samples = Array.from({ length: count }, () => new Float32Array(length))
    return { length, sampleRate, getChannelData(channel) { return samples[channel] } }
  } }
  const sampleRate = 44_100, length = 2 * sampleRate
  const source = { duration: 2, length, sampleRate }
  const fingerprint = "a".repeat(64)
  const packet = Buffer.alloc(12 + length * 8 * 4)
  packet.write("MGS1")
  packet.writeUInt32LE(sampleRate, 4)
  packet.writeUInt32LE(length, 8)
  const requests = []
  let supply
  const starting = new Promise(resolve => { supply = resolve })
  const oldDocument = globalThis.document
  const oldFetch = globalThis.fetch
  globalThis.document = { baseURI: "http://127.0.0.1:4175/" }
  globalThis.fetch = (url, options) => new Promise(resolve => {
    requests.push({ url: url.toString(), options, resolve })
    supply()
  })
  t.after(() => {
    if (oldDocument === undefined) delete globalThis.document
    else globalThis.document = oldDocument
    globalThis.fetch = oldFetch
  })
  const read = createStemCacheReader()
  const first = new AbortController()
  const second = new AbortController()
  const obsolete = read(context, source, fingerprint, first.signal)
  const retained = read(context, source, fingerprint, second.signal)
  await starting
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, `http://127.0.0.1:4175/api/stems/cache/${fingerprint}?frames=${length}`)
  assert.equal(requests[0].options.headers["X-Stem-Cache"], "1")
  first.abort()
  await assert.rejects(obsolete, { name: "AbortError" })
  assert.equal(requests[0].options.signal.aborted, false)
  requests[0].resolve(new Response(packet, { headers: { "Content-Type": "application/octet-stream" } }))
  assert.deepEqual(Object.keys(await retained), ["vocals", "drums", "bass", "other"])

  globalThis.fetch = async () => new Response(null, { status: 404 })
  assert.equal(await read(context, source, fingerprint, new AbortController().signal), null)

  const mounted = mountScrubTransport(t)
  Object.assign(mounted.context, context)
  const loaded = []
  globalThis.fetch = async (url, options) => {
    loaded.push([url.toString(), options.method ?? "GET"])
    return new Response(packet, { headers: { "Content-Type": "application/octet-stream" } })
  }
  mounted.transport.loadDecoded("A", { name: "Synthetic cache hit", file: new File(["test"], "fixture.wav"), buffer: source, fingerprint })
  await new Promise(resolve => setImmediate(resolve))
  await mounted.transport.play("A")
  assert.deepEqual(loaded, [[`http://127.0.0.1:4175/api/stems/cache/${fingerprint}?frames=${length}`, "GET"]])
  assert.equal(mounted.native.length, 5)
  mounted.transport.setStemLevel("A", "bass", 42)
  assert.deepEqual(mounted.native.map(node => node.connectedTo.gain.value), [0, 1, 1, .42, 1])
})

test("the loopback stem stream preserves every sample across uneven packet boundaries", async () => {
  const { readStemBank } = await import(localStemsUrl)
  const frameCount = 5
  const packet = Buffer.alloc(12 + frameCount * 8 * 4)
  packet.write("MGS1")
  packet.writeUInt32LE(44_100, 4)
  packet.writeUInt32LE(frameCount, 8)
  for (let sample = 0; sample < frameCount * 8; sample++) packet.writeFloatLE(sample / 64, 12 + sample * 4)
  function stream(bytes) {
    return new ReadableStream({ start(controller) {
      for (let offset = 0; offset < bytes.length; offset += 7) controller.enqueue(bytes.subarray(offset, offset + 7))
      controller.close()
    } })
  }
  const context = { createBuffer(count, length, sampleRate) {
    const samples = Array.from({ length: count }, () => new Float32Array(length))
    return { length, sampleRate, getChannelData(channel) { return samples[channel] } }
  } }
  const source = { length: frameCount, sampleRate: 44_100 }
  const { signal } = new AbortController()
  const bank = await readStemBank(context, stream(packet), frameCount, source, signal)
  assert.deepEqual(Object.keys(bank), ["vocals", "drums", "bass", "other"])
  const samples = Object.values(bank).flatMap(buffer => [0, 1].flatMap(channel => [...buffer.getChannelData(channel)]))
  assert.deepEqual(samples, Array.from({ length: 40 }, (_, index) => index / 64))
  await assert.rejects(readStemBank(context, stream(packet.subarray(0, -1)), frameCount, source, signal), /match this deck/)
  await assert.rejects(readStemBank(context, stream(packet), frameCount - 1, source, signal), /match this deck/)
})

function mountScrubTransport(t, { suspended = false } = {}) {
  const { context, native } = setup()
  Object.assign(context, {
    state: suspended ? "suspended" : "running", destination: audioNode(), addEventListener() {},
    createDynamicsCompressor() { return { ...audioNode(), threshold: {}, knee: {}, ratio: {}, attack: {}, release: {} } },
    createDelay() { return { ...audioNode(), delayTime: audioNode().gain } },
  })
  let resume
  context.resume = () => suspended && context.state !== "running"
    ? new Promise(resolve => { resume = resolve }) : Promise.resolve()
  const original = Object.getOwnPropertyDescriptor(globalThis, "AudioContext")
  Object.defineProperty(globalThis, "AudioContext", { configurable: true, value: class { constructor() { return context } } })
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "AudioContext", original)
    else delete globalThis.AudioContext
  })
  let transport
  renderToString(createElement(function TestScrub() {
    transport = useTransitionAudio()
    return null
  }))
  for (const deck of ["A", "B"]) transport.loadDecoded(deck, { name: "Synthetic " + deck, buffer: { duration: 20, sampleRate: 48_000 } })
  return { transport, native, context, finishResume: () => { context.state = "running"; resume?.() } }
}

test("a paused deck scrubs short excerpts and parks at release while the other deck plays", async t => {
  const { transport, native, context } = mountScrubTransport(t)
  await transport.play("B")
  const originalB = native[0]
  assert.ok(originalB)
  assert.equal(transport.beginScrub("A", 5), true)
  const preview = native[1]
  assert.equal(preview.begin.offset, 5)
  assert.ok(preview.duration > 0 && preview.duration <= .2)
  assert.equal(transport.getPositions().A, 0)
  transport.updateScrub("A", 6)
  assert.equal(native.at(-1).begin.offset, 6)
  transport.endScrub("A", 6.2)
  assert.equal(transport.getPositions().A, 6.2)
  assert.ok(native.at(-1).stopAt > context.currentTime)
  assert.equal(originalB.stopAt, undefined)
})

test("releasing a paused scrub before audio resumes prevents a stale audition", async t => {
  const { transport, native, finishResume } = mountScrubTransport(t, { suspended: true })
  assert.equal(transport.beginScrub("A", 5), true)
  transport.endScrub("A", 6)
  finishResume()
  await Promise.resolve()
  assert.equal(transport.getPositions().A, 6)
  assert.equal(native.length, 0)
})

test("canceling a live scrub resumes the original deck position without touching the other deck", async t => {
  const { transport, native, context } = mountScrubTransport(t)
  transport.seek("A", 3)
  await transport.play("both")
  const originalB = native[1]
  context.currentTime = 5.5
  const originalPosition = transport.getPositions().A
  assert.equal(transport.beginScrub("A", 8), true)
  assert.equal(native.at(-1).begin.offset, 8)
  transport.updateScrub("A", 10)
  assert.equal(native.at(-1).begin.offset, 10)
  transport.endScrub("A")
  assert.equal(native.at(-1).begin.offset, originalPosition)
  assert.equal(transport.getPositions().A, originalPosition)
  assert.ok(transport.getPositions().B > 0)
  assert.equal(originalB.stopAt, undefined)
})

test("play-on-release parks a running deck without stopping the other deck", async t => {
  const { transport, native } = mountScrubTransport(t)
  await transport.play("both")
  const [originalA, originalB] = native
  const finish = transport.pressHotCue("A", 4, "release")
  assert.equal(transport.getPositions().A, 4)
  assert.notEqual(originalA.stopAt, undefined)
  assert.equal(native.length, 2)
  assert.equal(originalB.stopAt, undefined)
  finish("release")
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(native.length, 3)
  assert.equal(native.at(-1).begin.offset, 4)
})

test("hold plays from the cue and releases to the original signed position", async t => {
  const { transport, native, context } = mountScrubTransport(t)
  const finish = transport.pressHotCue("A", -1, "hold")
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(native.at(-1).begin.offset, 0)
  context.currentTime = 7
  const source = native.at(-1)
  assert.ok(transport.getPositions().A > 0)
  finish("release")
  assert.notEqual(source.stopAt, undefined)
  assert.equal(transport.getPositions().A, -1)
})

test("an ended hot-cue hold cancels a pending start and a replaced cue cannot seek later", async t => {
  const { transport, native, finishResume } = mountScrubTransport(t, { suspended: true })
  const finish = transport.pressHotCue("A", 6, "hold")
  finish("cancel")
  finishResume()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(native.length, 0)
  assert.equal(transport.getPositions().A, 6)

  const stalePress = transport.pressHotCue("A", 8, "release")
  transport.loadDecoded("A", { name: "Replacement", buffer: { duration: 15, sampleRate: 48_000 } }, 2)
  stalePress("release")
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(native.length, 0)
  assert.equal(transport.getPositions().A, 2)
})

test("re-loop starts at In even when the current playhead is inside the loop", async t => {
  const { transport, native } = mountScrubTransport(t)
  transport.seek("A", 3.02)
  await transport.play("A")
  assert.equal(transport.setLoop("A", { start: 3, end: 3.05 }, true), true)
  assert.equal(transport.getPositions().A, 3)
  assert.equal(native.at(-1).begin.offset, 3)
})

test("master gain precedes output protection and each deck is metered between its FX and fader", () => {
  const splitters = []
  const waveforms = [[-.25], [.5], [1.2], [0], [.5], [.125]]
  let nextWaveform = 0
  function graphNode() {
    return {
      ...audioNode(), threshold: {}, knee: {}, ratio: {}, attack: {}, release: {}, delayTime: audioNode().gain,
      outputs: [],
      connect(node, channel) { this.outputs.push({ node, channel }) },
      disconnect(node) { this.outputs = node ? this.outputs.filter(output => output.node !== node) : [] },
    }
  }
  const context = {
    state: "suspended", currentTime: 0, destination: graphNode(),
    createGain: graphNode, createDynamicsCompressor: graphNode, createDelay: graphNode,
    createChannelSplitter(outputs) {
      assert.equal(outputs, 2)
      const node = graphNode()
      splitters.push(node)
      return node
    },
    createAnalyser() {
      const samples = waveforms[nextWaveform++]
      return { ...graphNode(), getFloatTimeDomainData(buffer) { buffer.fill(0); buffer.set(samples) } }
    },
  }
  const mixer = createTransitionOutput(context, { A: 1, B: 0 }, { masterDb: -6 })
  const [masterFromA] = mixer.decks.A.fader.outputs
  const [masterFromB] = mixer.decks.B.fader.outputs
  const master = masterFromA.node
  assert.equal(master, masterFromB.node)
  assert.ok(Math.abs(master.gain.value - .7 * 10 ** (-6 / 20)) < 1e-6)
  assert.equal(master.outputs[0].node, mixer.protection)
  mixer.setMasterDb(-60)
  assert.equal(master.gain.value, 0)
  mixer.setMasterDb(0)
  assert.equal(master.gain.value, .7)
  assert.equal(mixer.getLevels().A.left, -60)
  assert.equal(splitters.length, 0)
  context.state = "running"
  const levels = mixer.getLevels()
  assert.ok(Math.abs(levels.A.left - 20 * Math.log10(.25)) < 1e-5)
  assert.ok(Math.abs(levels.A.right - 20 * Math.log10(.5)) < 1e-5)
  assert.ok(levels.B.left > 0)
  assert.equal(levels.B.right, -60)
  assert.ok(levels.master.left > levels.master.right)
  assert.deepEqual(splitters.map(splitter => splitter.outputs.map(out => out.channel)), [[0, 1], [0, 1], [0, 1]])
  assert.equal(mixer.decks.B.fader.gain.value, 0)
  assert.equal(mixer.decks.B.input.outputs[0].node, mixer.decks.B.effects.input)
  assert.ok(mixer.decks.B.effects.output.outputs.some(out => out.node === splitters[1]))
  assert.ok(mixer.decks.B.effects.output.outputs.some(out => out.node === mixer.decks.B.fader))
  assert.ok(mixer.protection.outputs.some(out => out.node === splitters[2]))
  assert.ok(mixer.protection.outputs.some(out => out.node === context.destination))
  mixer.getLevels()
  assert.equal(splitters.length, 3)
  mixer.disconnect()
  assert.ok(splitters.every(splitter => splitter.outputs.length === 0))
})

test("Master Out and per-deck FX survive reloads and source loads, and reset independently", () => {
  const storageKey = "magik.transitionMixer"
  const storage = new Map([[storageKey, JSON.stringify({ gains: { A: -8, B: 2 }, curve: "linear" })]])
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage")
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
  } })
  function mount() {
    let transport
    renderToString(createElement(function TestDeck() {
      transport = useTransitionAudio()
      return null
    }))
    return transport
  }
  try {
    const initial = mount()
    const defaults = DEFAULT_DECK_FX
    assert.equal(initial.masterDb, 0)
    assert.equal(initial.decks.A.gainDb, -8)
    assert.equal(initial.curve, "linear")
    assert.deepEqual(initial.decks.A.fx, defaults)

    initial.setFx("A", { enabled: true, mix: 53 })
    initial.setFx("A", { feedback: 68 })
    initial.setFx("B", { kind: "tremolo", delayMs: 440, tremoloDepth: 45 })
    initial.setMasterDb(100)
    initial.loadDecoded("A", { name: "Synthetic", buffer: { duration: 12, sampleRate: 48_000 } })
    initial.setGain("A", -8)

    const reloaded = mount()
    assert.equal(reloaded.masterDb, 6)
    assert.deepEqual(reloaded.decks.A.fx, { ...defaults, enabled: true, mix: 53, feedback: 68 })
    const deckB = { ...defaults, kind: "tremolo", delayMs: 440, tremoloDepth: 45 }
    assert.deepEqual(reloaded.decks.B.fx, deckB)
    reloaded.setFx("A", defaults)
    reloaded.setMasterDb(0)

    const reset = mount()
    assert.equal(reset.masterDb, 0)
    assert.deepEqual(reset.decks.A.fx, defaults)
    assert.deepEqual(reset.decks.B.fx, deckB)
  } finally {
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage)
    else delete globalThis.localStorage
  }
})

test("negative pre-roll advances silently to sample zero without holding the other deck", () => {
  const { context, sources, start } = setup()
  const a = start("A", -3)
  const b = start("B", 0)
  assert.deepEqual(a.begin, { when: 8, offset: 0 })
  assert.deepEqual(b.begin, { when: 5, offset: 0 })
  context.currentTime = 6.5
  assert.equal(sources.position("A"), -1.5)
  assert.equal(sources.pause("A"), -1.5)
  context.currentTime = 7
  const resumed = start("A", -1.5, { start: 1, end: 2 }, undefined, 7)
  assert.deepEqual(resumed.begin, { when: 8.5, offset: 0 })
  assert.deepEqual([resumed.loopStart, resumed.loopEnd], [1, 2])
  assert.equal(sources.position("B"), 2)
})

test("changing pitch before sample zero reschedules its launch and keeps the current position", () => {
  const { context, sources, start, native } = setup()
  const old = start("A", -4)
  const staleEnd = old.onended
  context.currentTime = 6
  sources.setSpeed("A", 2)
  assert.equal(old.stopAt, 6)
  assert.deepEqual(native[1].begin, { when: 7.5, offset: 0 })
  assert.equal(native[1].playbackRate.value, 2)
  staleEnd()
  assert.equal(sources.position("A"), -3)
  context.currentTime = 8
  assert.equal(sources.position("A"), 1)
})

test("pausing just before zero cancels the pending input and keeps the other deck running", () => {
  const { context, sources, start } = setup()
  const a = start("A", -1)
  const b = start("B", 0)
  context.currentTime = 5.996
  assert.ok(sources.pause("A") < 0)
  assert.equal(a.stopAt, a.begin.when)
  assert.equal(b.stopAt, undefined)
})

test("pre-roll rate rescheduling retains each deck's independent pan and filter graph", () => {
  const { context, sources, start, filters, panners } = setup()
  start("A", -2)
  start("B", 4)
  sources.setPan("A", -60)
  sources.setFilter("A", 50)
  context.currentTime = 5.5
  sources.setSpeed("A", .75)
  assert.deepEqual(panners.map(node => node.pan.value), [-.6, 0])
  const highpasses = filters.filter(node => node.type === "highpass")
  assert.equal(highpasses.length, 2)
  assert.ok(highpasses[0].frequency.value > 0)
  assert.equal(highpasses[1].frequency.value, 0)
})

test("an all-negative audition ends silently at its requested track position", () => {
  const { context, sources, start } = setup()
  const ended = []
  const run = start("A", -5, null, () => ended.push("A"), 5, -2)
  assert.deepEqual(run.begin, { when: 8, offset: 0 })
  assert.equal(run.duration, 0)
  context.currentTime = 8
  assert.equal(sources.position("A"), -2)
  run.onended()
  assert.deepEqual(ended, ["A"])
})

test("pausing A leaves B's source and audio clock running", () => {
  const { context, sources, start } = setup()
  start("A", 1)
  const b = start("B", 3)
  context.currentTime = 7
  assert.equal(sources.pause("A"), 3)
  assert.equal(sources.has("A"), false)
  assert.equal(sources.has("B"), true)
  assert.equal(b.stopAt, undefined)
  context.currentTime = 9
  assert.equal(sources.position("B"), 7)
})

test("looping audio and the deck's displayed position wrap to the same point", () => {
  const { context, sources, start } = setup()
  const node = start("A", 5, { start: 4, end: 6 })
  assert.deepEqual([node.loop, node.loopStart, node.loopEnd], [true, 4, 6])
  context.currentTime = 6.5
  assert.equal(sources.position("A"), 4.5)
  assert.equal(sources.pause("A"), 4.5)
})

test("an ended callback from an old source cannot stop its replacement or the other deck", () => {
  const { sources, start } = setup()
  const ended = []
  const old = start("A", 1, null, () => ended.push("old A"))
  const oldEnd = old.onended
  const current = start("A", 6, null, () => ended.push("A"))
  start("B", 3, null, () => ended.push("B"))
  oldEnd()
  assert.deepEqual(ended, [])
  assert.equal(sources.position("A"), 6)
  assert.equal(sources.position("B"), 3)
  current.onended()
  assert.deepEqual(ended, ["A"])
  assert.equal(sources.has("B"), true)
})

test("changing rate during play preserves the current offset and native loop", () => {
  const { context, sources, start } = setup()
  const node = start("A", 5, { start: 4, end: 6 })
  start("B", 1)
  context.currentTime = 8.5
  assert.equal(sources.position("A"), 4.5)
  sources.setSpeed("A", .5)
  assert.equal(node.playbackRate.value, .5)
  assert.equal(node.stopAt, undefined)
  assert.deepEqual([node.loop, node.loopStart, node.loopEnd], [true, 4, 6])
  assert.equal(sources.position("A"), 4.5)
  context.currentTime = 12.5
  assert.equal(sources.position("A"), 4.5)
  assert.equal(sources.position("B"), 8.5)
})

test("a rate change before a scheduled start keeps the original launch time", () => {
  const { context, sources, start } = setup()
  const node = start("B", 3, null, undefined, 10)
  sources.setSpeed("B", 1.5)
  assert.equal(sources.position("B"), 3)
  assert.deepEqual(node.begin, { when: 10, offset: 3 })
  assert.equal(node.stopAt, undefined)
  context.currentTime = 11
  assert.equal(sources.position("B"), 4.5)
})

test("a paused audition keeps its exact track endpoint after a rate change", () => {
  const { context, sources, start } = setup()
  const excerpt = start("A", 1, null, undefined, 5, 5)
  const other = start("B", 2)
  assert.equal(excerpt.duration, 4)
  context.currentTime = 7
  sources.setSpeed("A", 2)
  assert.equal(excerpt.duration, 4)
  assert.equal(excerpt.stopAt, undefined)
  context.currentTime = 8.1
  assert.equal(sources.position("A"), 5)
  assert.equal(other.stopAt, undefined)
  excerpt.onended()
  assert.equal(sources.has("A"), false)
  assert.equal(sources.has("B"), true)
})

test("a locked seek reuses the active source and stale end callbacks leave the new run intact", () => {
  const { context, sources, start } = setup()
  const runs = []
  const rates = []
  const stops = []
  const locked = {
    node: audioNode(),
    start: options => runs.push(options),
    setRate: (...args) => rates.push(args),
    setLoop() {},
    stop: at => stops.push(at),
  }
  start("A", 1, null, undefined, 9, undefined, locked)
  sources.setSpeed("A", 1.25)
  assert.deepEqual(rates, [[1.25, 9]])
  assert.equal(sources.position("A"), 1)
  const same = start("A", 6, null, undefined, 10, 11, locked)
  assert.equal(same, locked.node)
  assert.deepEqual(stops, [])
  assert.equal(runs[1].excerptEnd, 11)
  context.currentTime = 12
  runs[0].onEnd()
  assert.equal(sources.position("A"), 8)
  runs[1].onEnd()
  assert.equal(sources.has("A"), false)
})

test("pausing before a Key Lock handoff stops the outgoing deck without a playhead jump", () => {
  const { context, sources, start } = setup()
  const stops = []
  const lock = { node: audioNode(), start() {}, setRate() {}, setLoop() {}, stop: at => stops.push(at) }
  const original = start("A", 1)
  const other = start("B", 3)
  context.currentTime = 6
  start("A", 3, null, undefined, 7, undefined, lock, true)
  sources.setSpeed("A", 1.5)
  context.currentTime = 6.25
  assert.equal(sources.position("A"), 2.25)
  assert.equal(sources.pause("A"), 2.25)
  assert.ok(original.stopAt < 6.3)
  assert.ok(stops[0] < 6.3)
  assert.equal(other.stopAt, undefined)
})

test("rapidly re-enabling cached Key Lock never stops its new run", () => {
  const { context, sources, start } = setup()
  const calls = []
  const lock = {
    node: audioNode(), start: () => calls.push("start"), stop: () => calls.push("stop"),
    setRate() {}, setLoop() {},
  }
  start("A", 1)
  context.currentTime = 6
  start("A", 3, null, undefined, 7, undefined, lock, true)
  context.currentTime = 6.25
  start("A", 2.75, null, undefined, 6.75, undefined, undefined, true)
  context.currentTime = 6.5
  start("A", 4, null, undefined, 8, undefined, lock, true)
  assert.deepEqual(calls, ["start", "stop", "start"])
  assert.equal(sources.has("A"), true)
})

test("mixer curves have exact end cuts, symmetric overlap and matching marks", async () => {
  const { CROSSFADER_CURVES, getCrossfaderGain, getDeckOutputGain } = await import(moduleUrl(ts.transpileModule(mixer, options).outputText))
  for (const [curve, { marks }] of Object.entries(CROSSFADER_CURVES)) {
    assert.deepEqual([getCrossfaderGain("A", 0, curve), getCrossfaderGain("B", 0, curve)], [1, 0])
    assert.deepEqual([getCrossfaderGain("A", 100, curve), getCrossfaderGain("B", 100, curve)], [0, 1])
    assert.equal(getCrossfaderGain("A", 25, curve), getCrossfaderGain("B", 75, curve))
    assert.equal(getCrossfaderGain("A", 50, curve), getCrossfaderGain("B", 50, curve))
    assert.equal(marks.includes(50), true)
  }
  const sharp = CROSSFADER_CURVES.sharp.marks
  assert.equal(getCrossfaderGain("B", sharp[1], "sharp"), 1)
  assert.equal(getCrossfaderGain("A", sharp.at(-2), "sharp"), 1)
  assert.equal(getDeckOutputGain("B", 0, "linear", 6), 0)
  assert.ok(Math.abs(getDeckOutputGain("B", 50, "linear", 6) - .998) < .001)
})
