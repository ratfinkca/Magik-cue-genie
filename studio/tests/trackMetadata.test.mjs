import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import ts from 'typescript'

// Transpile only this module; its sole runtime dependency is resolved from studio.
const source = await readFile(new URL('../src/trackMetadata.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
const dependency = import.meta.resolve('music-metadata')
const { parseTaggedKey, parseTaggedBpm, readTrackMetadata, readLibraryTrackMetadata } = await import(`data:text/javascript;base64,${Buffer.from(compiled.replaceAll("'music-metadata'", JSON.stringify(dependency))).toString('base64')}`)

test('key tags preserve standard, enharmonic, Camelot and Open Key meanings', () => {
  for (const [value, pitchClass, mode] of [['C', 0, 'major'], ['F#m', 6, 'minor'], ['B♭ minor', 10, 'minor'], ['Db maj', 1, 'major'], ['8A', 9, 'minor'], ['8B', 0, 'major'], ['1m', 9, 'minor'], ['1d', 0, 'major'], ['12m', 2, 'minor']]) {
    const key = parseTaggedKey(value)
    assert.equal(key?.pitchClass, pitchClass, value)
    assert.equal(key?.mode, mode, value)
    assert.equal(key.method, 'file-tag')
  }
  for (const value of ['', '13A', '0d', 'C mixolydian', '8A / 9A', 'unknown', 3]) assert.equal(parseTaggedKey(value), null)
})

test('BPM accepts full positive decimal tags without partial numeric coercion', () => {
  assert.equal(parseTaggedBpm('128.75'), 128.75)
  assert.equal(parseTaggedBpm(90), 90)
  for (const value of ['', '128oops', '120/130', -1, 0, Infinity, NaN, {}, true]) assert.equal(parseTaggedBpm(value), null)
})

function id3(key, bpm, genre) {
  const tags = [['TKEY', key], ['TBPM', bpm]]
  if (genre) tags.push(['TCON', genre])
  const frames = tags.map(([name, value]) => {
    const data = Buffer.from(`\0${value}`, 'latin1')
    const header = Buffer.alloc(10)
    header.write(name); header.writeUInt32BE(data.length, 4)
    return Buffer.concat([header, data])
  })
  const data = Buffer.concat(frames)
  const header = Buffer.from([73, 68, 51, 3, 0, 0, 0, 0, 0, 0])
  let length = data.length
  for (let i = 9; i >= 6; i--) { header[i] = length & 127; length >>>= 7 }
  return Buffer.concat([header, data])
}

function flac(key, bpm, genres = []) {
  const uint = (value) => { const b = Buffer.alloc(4); b.writeUInt32LE(value); return b }
  const comments = [`INITIALKEY=${key}`, `BPM=${bpm}`, ...genres.map(genre => `GENRE=${genre}`)].map(value => Buffer.from(value))
  const tags = Buffer.concat([uint(0), uint(comments.length), ...comments.flatMap(value => [uint(value.length), value])])
  const header = Buffer.alloc(4); header[0] = 0x84; header.writeUIntBE(tags.length, 1, 3)
  return Buffer.concat([Buffer.from('fLaC'), Buffer.from([0, 0, 0, 34]), Buffer.alloc(34), header, tags])
}

function wav(key, bpm) {
  const chunk = (name, bytes) => {
    const header = Buffer.alloc(8); header.write(name); header.writeUInt32LE(bytes.length, 4)
    return Buffer.concat([header, bytes, Buffer.alloc(bytes.length % 2)])
  }
  const format = Buffer.alloc(16)
  format.writeUInt16LE(1); format.writeUInt16LE(1, 2); format.writeUInt32LE(8000, 4)
  format.writeUInt32LE(16000, 8); format.writeUInt16LE(2, 12); format.writeUInt16LE(16, 14)
  const payload = Buffer.concat([Buffer.from('WAVE'), chunk('fmt ', format), chunk('id3 ', id3(key, bpm)), chunk('data', Buffer.alloc(160))])
  const header = Buffer.alloc(8); header.write('RIFF'); header.writeUInt32LE(payload.length, 4)
  return Buffer.concat([header, payload])
}

function mp4(key, bpm) {
  const box = (name, ...parts) => {
    const body = Buffer.concat(parts); const header = Buffer.alloc(8)
    header.writeUInt32BE(body.length + 8); header.write(name, 4)
    return Buffer.concat([header, body])
  }
  const data = (value) => box('data', Buffer.from([0, 0, 0, 1, 0, 0, 0, 0]), Buffer.from(value))
  const freeform = (name, value) => box('----', box('mean', Buffer.alloc(4), Buffer.from('com.apple.iTunes')), box('name', Buffer.alloc(4), Buffer.from(name)), data(value))
  return Buffer.concat([box('ftyp', Buffer.from('M4A '), Buffer.alloc(4), Buffer.from('M4A ')), box('moov', box('udta', box('meta', Buffer.alloc(4), box('ilst', freeform('initialkey', key), freeform('BPM', bpm)))))])
}

test('synthetic MP3, FLAC, WAV and MP4 metadata supplies independent key and decimal BPM', async () => {
  for (const [bytes, name, type] of [[id3('8A', '128.75'), 'test.mp3', 'audio/mpeg'], [flac('1m', '128.75'), 'test.flac', 'audio/flac'], [wav('Am', '128.75'), 'test.wav', 'audio/wav'], [mp4('A minor', '128.75'), 'test.m4a', 'audio/mp4']]) {
    const result = await readTrackMetadata(new File([bytes], name, { type }))
    assert.equal(result.key?.pitchClass, 9, name)
    assert.equal(result.key?.mode, 'minor', name)
    assert.equal(result.bpm, 128.75, name)
  }
})

test('invalid BPM stays absent even when parser common tags coerce it to an integer', async () => {
  const result = await readTrackMetadata(new File([id3('C', '128oops')], 'test.mp3', { type: 'audio/mpeg' }))
  assert.equal(result.bpm, null)
  assert.equal(result.key?.pitchClass, 0)
})

test('library genres read embedded ID3 and FLAC tags while preserving other metadata', async () => {
  const mp3 = await readLibraryTrackMetadata(new File([id3('C', '135', 'Deep House')], 'test.mp3', { type: 'audio/mpeg' }))
  assert.deepEqual(mp3.genres, ['Deep House'])
  assert.equal(mp3.bpm, 135)
  const tagged = flac('Am', '125', [' Techno ', 'TECHNO', '', 'Acid'])
  const library = await readLibraryTrackMetadata(new File([tagged], 'test.flac', { type: 'audio/flac' }))
  assert.deepEqual(library.genres, ['Techno', 'Acid'])
  assert.equal(library.key?.pitchClass, 9)
  const untagged = await readLibraryTrackMetadata(new File([id3('C', '120')], 'test.mp3', { type: 'audio/mpeg' }))
  assert.deepEqual(untagged.genres, [])
})

test('unsupported and malformed local files return missing values', async () => {
  assert.deepEqual(await readTrackMetadata(new File(['bad data'], 'test.mp3')), { key: null, bpm: null })
})
