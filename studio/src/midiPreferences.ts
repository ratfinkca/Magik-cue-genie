import { isMidiControl } from "./midiMapping"
import type { MidiControl } from "./midiMapping"

export const MIDI_MAPPING_PREFERENCE_KEY = "magik.studio.midi.v1"
export const MAX_MIDI_BINDINGS = 512

export type MidiTarget = { id: string; label: string; kind: "button" | "absolute"; group: "Deck A" | "Deck B" | "Mixer" }
export type MidiLearnTarget = { inputId: string; actionId: string }
export type ControllerPadMode = "hotcue" | "autoloop" | "savedloop" | "roll"
export type MidiBindingCondition = { deck: "A" | "B"; shift?: boolean; mode?: ControllerPadMode }
export type MidiBinding = MidiLearnTarget & { control: MidiControl; inverted?: boolean; when?: MidiBindingCondition }
export type MidiPresetAssignment = { inputId: string; presetId: "ddj-flx4" | "mixstream-pro-go" }
export type MidiPreferences = { version: 1; bindings: MidiBinding[]; presets?: MidiPresetAssignment[] }

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function identifier(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max && Boolean(value.trim())
}

function bindingFrom(value: unknown): MidiBinding | null {
  if (!record(value) || !identifier(value.inputId, 512) || !identifier(value.actionId, 128)
    || !isMidiControl(value.control)) return null
  const { kind, channel, number, lsb } = value.control
  const binding: MidiBinding = { inputId: value.inputId, actionId: value.actionId,
    control: { kind, channel, number, ...(lsb === undefined ? {} : { lsb }) } }
  if (value.inverted !== undefined) {
    if (typeof value.inverted !== "boolean" || kind !== "cc") return null
    binding.inverted = value.inverted
  }
  if (value.when !== undefined) {
    const when = value.when
    if (!record(when) || (when.deck !== "A" && when.deck !== "B")
      || (when.shift !== undefined && typeof when.shift !== "boolean")
      || (when.mode !== undefined && when.mode !== "hotcue" && when.mode !== "autoloop" && when.mode !== "savedloop" && when.mode !== "roll")) return null
    binding.when = { deck: when.deck, ...(when.shift === undefined ? {} : { shift: when.shift }),
      ...(when.mode === undefined ? {} : { mode: when.mode }) }
  }
  return binding
}

function conditionsOverlap(first?: MidiBindingCondition, second?: MidiBindingCondition) {
  if (!first || !second || first.deck !== second.deck) return true
  if (first.shift !== undefined && second.shift !== undefined && first.shift !== second.shift) return false
  return first.mode === undefined || second.mode === undefined || first.mode === second.mode
}

function controlsOverlap(first: MidiControl, second: MidiControl) {
  if (first.kind !== second.kind || first.channel !== second.channel) return false
  const firstBytes = [first.number, first.lsb]
  return firstBytes.includes(second.number) || (second.lsb !== undefined && firstBytes.includes(second.lsb))
}

/** Alternate pad banks can share a button. A custom assignment replaces its preset banks. */
export function putMidiBinding(bindings: readonly MidiBinding[], binding: MidiBinding): MidiBinding[] | null {
  const candidate = bindingFrom(binding)
  if (!candidate) return null
  const kept = bindings.filter(existing => existing.inputId !== candidate.inputId
    || !conditionsOverlap(existing.when, candidate.when)
    || (existing.actionId !== candidate.actionId && !controlsOverlap(existing.control, candidate.control)))
  return kept.length < MAX_MIDI_BINDINGS ? [...kept, candidate] : null
}

export function replaceMidiInputBindings(bindings: readonly MidiBinding[], inputId: string,
  definitions: readonly Omit<MidiBinding, "inputId">[]): MidiBinding[] | null {
  if (!identifier(inputId, 512) || definitions.length > MAX_MIDI_BINDINGS) return null
  let next = bindings.filter(binding => binding.inputId !== inputId)
  if (next.length + definitions.length > MAX_MIDI_BINDINGS) return null
  for (const definition of definitions) {
    const changed = putMidiBinding(next, { ...definition, inputId })
    if (!changed || changed.length !== next.length + 1) return null
    next = changed
  }
  return next
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
  const presets = new Map<string, MidiPresetAssignment>()
  if (Array.isArray(value.presets)) for (const item of value.presets.slice(0, MAX_MIDI_BINDINGS)) {
    if (record(item) && identifier(item.inputId, 512) && (item.presetId === "ddj-flx4" || item.presetId === "mixstream-pro-go")) {
      presets.set(item.inputId, { inputId: item.inputId, presetId: item.presetId })
    }
  }
  return { version: 1, bindings, ...(presets.size ? { presets: [...presets.values()] } : {}) }
}
