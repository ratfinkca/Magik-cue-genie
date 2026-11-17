import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import ts from 'typescript'

const source = await readFile(new URL('../src/loops.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText
const { canArmEmergencyLoop, getLoop, suggestEmergencyLoop } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`
)

const duration = 220
const offset = 0.124
const grid = (length, period = 0.5) => Array.from(
  { length: Math.floor((length - offset) / period) + 1 },
  (_, index) => offset + index * period,
)

function emergency(start, end) {
  return {
    label: 'Emergency loop',
    time_seconds: start,
    confidence: 0.7,
    reason: 'Synthetic loop',
    metadata: { loop: { kind: 'emergency', active: true, end_seconds: end } },
  }
}

function kickWave(period = 0.5, silenceAfter = duration) {
  const binCount = 22_000
  const low = new Float32Array(binCount)
  for (let index = 0; index < binCount; index++) {
    const time = duration * index / binCount
    const phase = (time - offset) % period
    if (phase >= 0 && phase < 0.14 && time < silenceAfter) low[index] = Math.exp(-phase * 28)
  }
  return { duration, binCount, low, mid: low, high: low, peak: low }
}

test('only a late loop on the observed beat phase can arm', () => {
  const beats = grid(duration)
  assert.ok(canArmEmergencyLoop(emergency(211.124, 215.124), duration, beats))
  assert.equal(canArmEmergencyLoop(emergency(133.124, 137.124), duration, beats), false)
  assert.equal(canArmEmergencyLoop(emergency(191.124, 195.124), duration, beats), false)
  assert.equal(canArmEmergencyLoop(emergency(211.249, 215.249), duration, beats), false)
  assert.equal(canArmEmergencyLoop(emergency(211.124, 215.124), duration, []), false)
})

test('interior beat evidence and consistent phase are required', () => {
  const beats = grid(duration)
  const missing = beats.filter((time) => Math.abs(time - 213.124) > 0.001)
  assert.equal(canArmEmergencyLoop(emergency(211.124, 215.124), duration, missing), false)
  const drifting = beats.map((time) => time === 213.124 ? time + 0.08 : time)
  assert.equal(canArmEmergencyLoop(emergency(211.124, 215.124), duration, drifting), false)
  assert.equal(canArmEmergencyLoop(emergency(211.106, 215.142), duration, beats), false)
})

test('automatic proposal uses actual grid endpoints rather than nominal BPM length', () => {
  const period = 0.503
  const beats = grid(duration, period)
  const cue = suggestEmergencyLoop([], 120, kickWave(period), duration, 4, beats)
  assert.ok(cue)
  const loop = getLoop(cue, duration)
  assert.ok(loop.active)
  assert.ok(beats.includes(cue.time_seconds))
  assert.ok(beats.some((time) => Math.abs(time - loop.end_seconds) <= 1e-9))
  assert.ok(canArmEmergencyLoop(cue, duration, beats))
  const length = loop.end_seconds - cue.time_seconds
  assert.ok(Math.abs(length - Math.round(length / period) * period) < 1e-9)
  assert.ok(Math.abs(length - Math.round(length / 0.5) * 0.5) > 0.01)
})

test('a steady earlier groove or a BPM alone never arms the tail', () => {
  const beats = grid(duration)
  assert.equal(suggestEmergencyLoop([], 120, kickWave(), duration), null)
  assert.equal(suggestEmergencyLoop([], 120, kickWave(0.5, 170), duration, 4, beats), null)
  assert.equal(suggestEmergencyLoop([], 120, kickWave(), duration, 4,
    beats.filter((time) => time < 193)), null)
})
