import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import ts from 'typescript'

const source = await readFile(new URL('../src/rekordboxXml.ts', import.meta.url), 'utf8')
const javascript = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText
const { decodeRekordboxXml, encodeRekordboxXml } = await import(
  `data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`)

const testLibrary = {
  tracks: [{
    id: 'local-a', location: 'C:\\QA Set\\Café #1 & 20%.wav', title: 'Café & "Test"', artist: 'A < B',
    genre: 'House', key: 'Am', bpm: 128, durationSeconds: 66.75,
    cuePoints: [
      { name: 'Intro', timeSeconds: 0.125 },
      { name: 'Vocal loop', timeSeconds: 10.25, endSeconds: 11.5, hotCueSlot: 7, color: '#a1b2c3' },
    ],
    tempo: [
      { timeSeconds: 0.125, bpm: 128, meter: '4/4', beat: 1 },
      { timeSeconds: 30.125, bpm: 130, meter: '7/8', beat: 2 },
    ],
  }],
  playlists: [{ name: 'Friday', folderPath: ['Prep & QA'], trackIds: ['local-a', 'local-a'] }],
  warnings: [],
}

test('rekordbox export escapes metadata and converts the reviewed source to a local file URI', () => {
  const { xml, warnings } = encodeRekordboxXml(testLibrary)
  assert.deepEqual(warnings, [])
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>/)
  assert.match(xml, /Name="Café &amp; &quot;Test&quot;" Artist="A &lt; B"/)
  assert.match(xml, /Location="file:\/\/localhost\/C:\/QA%20Set\/Caf%C3%A9%20%231%20%26%2020%25.wav"/)
  assert.match(xml, /TotalTime="67"/)
  assert.match(xml, /<TEMPO Inizio="30.125" Bpm="130" Metro="7\/8" Battito="2"\/>/)
  assert.match(xml, /<POSITION_MARK Name="Intro" Type="0" Start="0.125" Num="-1"\/>/)
  assert.match(xml, /Name="Vocal loop" Type="4" Start="10.25" End="11.5" Num="7" Red="161" Green="178" Blue="195"/)
  assert.match(xml, /Type="0" Name="Prep &amp; QA" Count="1"/)
  assert.match(xml, /Type="1" Name="Friday" KeyType="0" Entries="2"/)
  assert.equal((xml.match(/<TRACK Key="1"\/>/g) ?? []).length, 2)
})

test('rekordbox export reports unsupported fields without moving cues or inventing a grid', () => {
  const fixture = structuredClone(testLibrary)
  fixture.tracks[0].cuePoints = [
    { name: 'Pre-roll', timeSeconds: -4 },
    { name: 'Sentinel', timeSeconds: 10, endSeconds: 14, armed: true, hotCueSlot: 8, color: '#aabbcc' },
    { name: 'Malformed loop', type: 'loop', timeSeconds: 20, endSeconds: 20 },
    { name: 'Broken color', timeSeconds: 20, hotCueSlot: 1, color: 'pink' },
    { name: 'Duplicate slot', timeSeconds: 25, hotCueSlot: 1 },
  ]
  fixture.tracks[0].tempo.push(
    { timeSeconds: 40, bpm: 0, meter: '4/4', beat: 1 },
    { timeSeconds: 45, bpm: 128, meter: '4/4', beat: 5 },
  )
  fixture.tracks.push({ id: 'missing', location: 'relative/x.wav', title: 'Needs folder' })
  fixture.playlists[0].trackIds.push('missing')
  fixture.playlists.push({ ...fixture.playlists[0] })
  const { xml, warnings } = encodeRekordboxXml(fixture)
  assert.doesNotMatch(xml, /Pre-roll|Malformed loop|relative\/|Inizio="4[05]"/)
  assert.match(xml, /Name="Sentinel" Type="4" Start="10" End="14" Num="-1"/)
  assert.match(xml, /Name="Duplicate slot" Type="0" Start="25" Num="-1"/)
  assert.match(xml, /Name="Friday \(2\)"/)
  for (const expected of ['Pre-roll', 'armed', 'outside A–H', 'Malformed loop', 'Broken color',
    'Duplicate slot', 'invalid BPM', 'invalid beat', 'Needs folder', 'missing', 'Friday (2)']) {
    assert.ok(warnings.some(warning => warning.includes(expected)), `${expected} warning is missing`)
  }
})

test('rekordbox XML rejects document type declarations before parsing', () => {
  assert.throws(() => decodeRekordboxXml('<!DOCTYPE DJ_PLAYLISTS><DJ_PLAYLISTS/>'), /document type/i)
})

test('file URI export preserves literal percent escapes in source filenames', () => {
  const fixture = structuredClone(testLibrary)
  fixture.tracks[0].location = '/Music/Track%20🎚.wav'
  const path = 'file://localhost/Music/Track%2520%F0%9F%8E%9A.wav'
  assert.ok(encodeRekordboxXml(fixture).xml.includes(path))
  fixture.tracks[0].location = path
  assert.ok(encodeRekordboxXml(fixture).xml.includes(path))
})

const requiresDom = { skip: typeof DOMParser === 'undefined' && 'Requires a DOMParser in the Node test environment' }

test('rekordbox XML round trips metadata, distinct mark classes, tempo changes and ordered playlists', requiresDom, () => {
  const { xml } = encodeRekordboxXml(testLibrary)
  const result = decodeRekordboxXml(xml)
  assert.deepEqual(result.warnings, [])
  assert.equal(result.tracks[0].title, 'Café & "Test"')
  assert.equal(result.tracks[0].artist, 'A < B')
  assert.equal(result.tracks[0].key, 'Am')
  assert.deepEqual(result.tracks[0].cuePoints, testLibrary.tracks[0].cuePoints.map((cue, index) => ({
    ...cue, type: index === 0 ? 'cue' : 'loop',
  })))
  assert.deepEqual(result.tracks[0].tempo, testLibrary.tracks[0].tempo)
  assert.deepEqual(result.playlists, [{ name: 'Friday', folderPath: ['Prep & QA'], trackIds: ['1', '1'] }])
})

test('rekordbox XML safely reads location-keyed playlists and reports invalid rows and ambiguous IDs', requiresDom, () => {
  const result = decodeRekordboxXml(`<?xml version="1.0"?>
    <DJ_PLAYLISTS Version="1.0.0">
      <COLLECTION Entries="3">
        <TRACK TrackID="5" Name="One" Location="file://localhost/C:/Music/One.wav" TotalTime="3">
          <TEMPO Inizio="0.1" Bpm="128" Metro="4/4" Battito="5"/>
          <POSITION_MARK Type="3" Start="0.1" Num="-1"/>
          <POSITION_MARK Type="4" Start="3" End="3.25" Num="0"/>
          <POSITION_MARK Name="Too long" Type="4" Start="3" End="99" Num="-1"/>
          <POSITION_MARK Name="Unsupported" Type="44" Start="3" Num="-1"/>
        </TRACK>
        <TRACK TrackID="5" Name="Duplicate" Location="file:///Other.wav"/>
        <TRACK Name="No track ID" Location="C:/Music/No track ID.wav"/>
      </COLLECTION>
      <PLAYLISTS>
        <NODE Type="0" Name="ROOT" Count="2">
          <NODE Type="1" Name="By location" KeyType="1" Entries="2">
            <TRACK Key="file:///C:/Music/No%20track%20ID.wav"/>
            <TRACK Key="file:///C:/Music/One.wav"/>
          </NODE>
          <NODE Type="1" Name="By ID" KeyType="0" Entries="1"><TRACK Key="5"/></NODE>
        </NODE>
      </PLAYLISTS>
    </DJ_PLAYLISTS>`)
  assert.deepEqual(result.tracks.map(track => track.title), ['One', 'No track ID'])
  assert.deepEqual(result.tracks[0].cuePoints, [
    { name: '', timeSeconds: 0.1, type: 'load' },
    { name: '', timeSeconds: 3, endSeconds: 3.25, type: 'loop', hotCueSlot: 0 },
  ])
  assert.deepEqual(result.playlists, [
    { name: 'By location', trackIds: ['track-3', '5'] }, { name: 'By ID', trackIds: [] },
  ])
  for (const expected of ['invalid beat', 'Too long', 'Unsupported', 'duplicate TrackID', 'ambiguous track']) {
    assert.ok(result.warnings.some(warning => warning.includes(expected)), `${expected} warning is missing`)
  }
})
