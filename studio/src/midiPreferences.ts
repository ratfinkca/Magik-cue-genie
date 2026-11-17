import { isMidiControl, midiControlKey } from "./midiMapping"
import type { MidiControl } from "./midiMapping"

export const MIDI_MAPPING_PREFERENCE_KEY = "magik.studio.midi.v1"
export const MAX_MIDI_BINDINGS = 512

export type MidiTarget = { id: string; label: string; kind: "button" | "absolute"; group: "Deck A" | "Deck B" | "Mixer" }
export type MidiLearnTarget = { inputId: string; actionId: string }
export type MidiBinding = MidiLearnTarget & { control: MidiControl }
export type MidiPreferences = { version: 1; bindings: MidiBinding[] }

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function identifier(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max && Boolean(value.trim())
}

function bindingFrom(value: unknown): MidiBinding | null {
  if (!record(value) || !identifier(value.inputId, 512) || !identifier(value.actionId, 128)
    || !isMidiControl(value.control)) return null
  const { kind, channel, number } = value.control
  return { inputId: value.inputId, actionId: value.actionId, control: { kind, channel, number } }
}

/** Within an input port, assign each target and physical control once. */
export function putMidiBinding(bindings: readonly MidiBinding[], binding: MidiBinding): MidiBinding[] | null {
  const candidate = bindingFrom(binding)
  if (!candidate) return null
  const key = midiControlKey(candidate.control)
  const kept = bindings.filter(existing => existing.inputId !== candidate.inputId
    || (existing.actionId !== candidate.actionId && midiControlKey(existing.control) !== key))
  return kept.length < MAX_MIDI_BINDINGS ? [...kept, candidate] : null
}

export function removeMidiBinding(bindings: readonly MidiBinding[], inputId: string, actionId: string): MidiBinding[] {
  return bindings.filter(binding => binding.inputId !== inputId || binding.actionId !== actionId)
}

export function validateMidiPreferences(value: unknown): MidiPreferences | null {
  if (!record(value) || value.version !== 1 || !Array.isArray(value.bindings)) return null
  let bindings: MidiBinding[] = []
  for (const raw of value.bindings.slice(0, MAX_MIDI_BINDINGS)) {
    const binding = bindingFrom(raw)
    if (binding) bindings = putMidiBinding(bindings, binding) ?? bindings
  }
  return { version: 1, bindings }
}
