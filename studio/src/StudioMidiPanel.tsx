import { useCallback, useId, useRef, useState } from "react"
import { MIDI_MAPPING_PREFERENCE_KEY, MAX_MIDI_BINDINGS, putMidiBinding, removeMidiBinding, replaceMidiInputBindings, validateMidiPreferences } from "./midiPreferences"
import type { MidiBinding, MidiLearnTarget, MidiPresetAssignment, MidiTarget } from "./midiPreferences"
import { controllerPresets, detectControllerPreset } from "./controllerPresets"
import type { ControllerPresetId } from "./controllerPresets"
import type { MidiControl } from "./midiMapping"
import type { useUsbMidi } from "./useUsbMidi"
import "./studioMidiPanel.css"

export type { MidiBinding, MidiLearnTarget, MidiTarget } from "./midiPreferences"

const groups = ["Deck A", "Deck B", "Mixer"] as const

function initialBindings(): { bindings: MidiBinding[]; presets: MidiPresetAssignment[]; storageError: string | null } {
  try {
    const saved = window.localStorage.getItem(MIDI_MAPPING_PREFERENCE_KEY)
    if (saved === null) return { bindings: [], presets: [], storageError: null }
    const preferences = validateMidiPreferences(JSON.parse(saved))
    if (preferences) return { bindings: preferences.bindings, presets: preferences.presets ?? [], storageError: null }
  } catch { /* The browser may disallow access to preferences. */ }
  return { bindings: [], presets: [], storageError: "Could not read saved MIDI mappings." }
}

export function useMidiBindings() {
  const [state, setState] = useState(initialBindings)
  const current = useRef({ bindings: state.bindings, presets: state.presets })

  const commit = useCallback((bindings: MidiBinding[], presets = current.current.presets) => {
    current.current = { bindings, presets }
    let storageError: string | null = null
    try {
      window.localStorage.setItem(MIDI_MAPPING_PREFERENCE_KEY, JSON.stringify({ version: 1, bindings, ...(presets.length ? { presets } : {}) }))
    } catch {
      storageError = "MIDI mappings are available for this session. The browser could not save them."
    }
    setState({ bindings, presets, storageError })
  }, [])

  const setBinding = useCallback((binding: MidiBinding) => {
    const next = putMidiBinding(current.current.bindings, binding)
    if (next) commit(next)
    else setState(previous => ({ ...previous, storageError: previous.bindings.length >= MAX_MIDI_BINDINGS
      ? `The mapping limit is ${MAX_MIDI_BINDINGS}. Remove an unused mapping to learn another.`
      : "This MIDI control could not be mapped." }))
  }, [commit])

  const removeBinding = useCallback((inputId: string, actionId: string) => {
    const next = removeMidiBinding(current.current.bindings, inputId, actionId)
    if (next.length !== current.current.bindings.length) commit(next)
  }, [commit])

  const applyPreset = useCallback((inputId: string, presetId: ControllerPresetId) => {
    const preset = controllerPresets.find(item => item.id === presetId)
    if (!preset) return
    const next = replaceMidiInputBindings(current.current.bindings, inputId, preset.bindings)
    if (!next) {
      setState(previous => ({ ...previous, storageError: `The mapping limit is ${MAX_MIDI_BINDINGS}. Remove unused mappings to apply this preset.` }))
      return
    }
    commit(next, [...current.current.presets.filter(item => item.inputId !== inputId), { inputId, presetId }])
  }, [commit])

  const autoApplyPresets = useCallback((inputs: readonly { id: string; name: string; manufacturer: string }[]) => {
    for (const input of inputs) {
      if (current.current.presets.some(item => item.inputId === input.id)
        || current.current.bindings.some(item => item.inputId === input.id)) continue
      const preset = detectControllerPreset(input)
      if (preset) applyPreset(input.id, preset.id)
    }
  }, [applyPreset])

  return { ...state, setBinding, removeBinding, applyPreset, autoApplyPresets }
}

type PanelProps = {
  midi: ReturnType<typeof useUsbMidi>
  targets: readonly MidiTarget[]
  bindings: readonly MidiBinding[]
  presets: readonly MidiPresetAssignment[]
  applyPreset: (inputId: string, presetId: ControllerPresetId) => void
  learning: MidiLearnTarget | null
  learn: (change: MidiLearnTarget | null) => void
  remove: (inputId: string, actionId: string) => void
  setBinding: (binding: MidiBinding) => void
  storageError?: string | null
}

function controlLabel(control: MidiControl) {
  return `${control.kind === "cc" ? "CC" : "Note"} ${control.number}${control.lsb === undefined ? "" : "+" + control.lsb} · Ch ${control.channel}`
}

export default function StudioMidiPanel({ midi, targets, bindings, presets, applyPreset, learning, learn, remove, setBinding, storageError }: PanelProps) {
  const dialog = useRef<HTMLDialogElement>(null)
  const headingId = useId()
  const [open, setOpen] = useState(false)
  const [selectedInput, setSelectedInput] = useState("")
  const [chosenPreset, setChosenPreset] = useState<{ inputId: string; id: string } | null>(null)
  const [group, setGroup] = useState<MidiTarget["group"]>("Deck A")

  function closePanel() {
    learn(null)
    dialog.current?.close()
    setOpen(false)
  }

  const inputOptions = new Map<string, { label: string; connected: boolean }>()
  if (open) {
    const liveInputs = midi.inputs.map(input => ({ id: input.id, label: [input.manufacturer, input.name].filter(Boolean).join(" · ") || "MIDI input" }))
    for (const [index, input] of liveInputs.entries()) {
      const label = liveInputs.some(other => other.id !== input.id && other.label === input.label)
        ? `${input.label} (input ${index + 1})` : input.label
      inputOptions.set(input.id, { label, connected: true })
    }
    let offlineCount = 0
    for (const { inputId } of bindings) if (!inputOptions.has(inputId)) {
      inputOptions.set(inputId, { label: `Saved input ${++offlineCount} (offline)`, connected: false })
    }
  }
  const inputId = inputOptions.has(selectedInput) ? selectedInput : inputOptions.keys().next().value
  const canLearn = Boolean(inputId && midi.status === "connected" && inputOptions.get(inputId)?.connected)
  const assignedPreset = controllerPresets.find(preset => preset.id === presets.find(item => item.inputId === inputId)?.presetId)
  const detectedPreset = detectControllerPreset(midi.inputs.find(input => input.id === inputId) ?? { name: "", manufacturer: "" })
  const selectedPreset = controllerPresets.find(preset => preset.id === (chosenPreset && chosenPreset.inputId === inputId
    ? chosenPreset.id : assignedPreset?.id ?? detectedPreset?.id))
  const byAction = open ? new Map(bindings.filter(binding => binding.inputId === inputId)
    .map(binding => [binding.actionId, binding])) : new Map<string, MidiBinding>()
  const learningAction = open && learning && learning.inputId === inputId ? targets.find(target => target.id === learning.actionId) : undefined
  const missing = open ? [...byAction.values()].filter(binding => !targets.some(target => target.id === binding.actionId)) : []

  return <>
    <button className="quiet" type="button" title="Configure MIDI mappings" onClick={() => {
      setOpen(true)
      dialog.current?.showModal()
    }}>MIDI</button>
    <dialog ref={dialog} className="studio-midi" aria-labelledby={headingId} onClose={() => {
      if (learning) learn(null)
      setOpen(false)
    }}>
      {open && <>
        <div className="studio-midi-heading">
          <h2 id={headingId}>MIDI mapping</h2>
          <button className="quiet" type="button" onClick={closePanel}>Close</button>
        </div>
        <div className="studio-midi-device">
          {midi.status === "connected" ? <button className="quiet" type="button" onClick={() => {
            learn(null)
            midi.disconnect()
          }}>Disconnect MIDI</button> : <button className="primary" type="button" onClick={() => void midi.connect()}
            disabled={midi.status === "connecting" || midi.status === "unsupported"}>
            {midi.status === "connecting" ? "Connecting…" : "Enable MIDI"}
          </button>}
          {inputOptions.size > 0 && <label>MIDI input
            <select aria-label="MIDI input" value={inputId} onChange={event => {
              learn(null)
              setSelectedInput(event.currentTarget.value)
            }}>
              {[...inputOptions].map(([id, option]) => <option value={id} key={id}>{option.label}</option>)}
            </select>
          </label>}
        </div>
        {inputId && <div className="studio-midi-preset">
          <label>Controller preset
            <select aria-label="Controller preset" value={selectedPreset?.id ?? ""} onChange={event => {
              setChosenPreset({ inputId, id: event.currentTarget.value })
            }}>
              <option value="">Choose preset</option>
              {controllerPresets.map(preset => <option key={preset.id} value={preset.id}>{preset.label}</option>)}
            </select>
          </label>
          <button type="button" className="quiet" disabled={!selectedPreset || !canLearn} onClick={() => {
            if (!selectedPreset) return
            learn(null)
            applyPreset(inputId, selectedPreset.id)
          }}>Apply preset</button>
          {assignedPreset && <p role="status">{assignedPreset.label} preset saved · {bindings.filter(binding => binding.inputId === inputId).length} mappings</p>}
          {selectedPreset && <p>{selectedPreset.setup}</p>}
          <p>Applying a preset replaces this input’s mappings. Move knobs and faders through the on-screen value to pick them up.</p>
        </div>}
        <div aria-live="polite" className="studio-midi-status">
          {midi.error && <p>{midi.error}</p>}
          {storageError && <p>{storageError}</p>}
          {learningAction ? <p>Waiting for {learningAction.kind === "button" ? "a button press" : "knob or fader movement"} for <strong>{learningAction.label}</strong>.</p>
            : midi.status === "connected" && !midi.inputs.length ? <p>Connect a controller to learn new mappings.</p>
            : canLearn ? <p>Use the preset or choose Learn for a custom assignment. Learning an already mapped control moves its assignment.</p>
            : inputId ? <p>Saved mappings for this input. Connect the matching controller to learn controls.</p>
            : midi.status === "idle" ? <p>Enable MIDI and connect a controller to map its buttons and faders.</p> : null}
        </div>
        {inputId && <>
          <div className="studio-midi-groups" role="group" aria-label="MIDI mapping sections">
            {groups.map(section => <button className="quiet" type="button" key={section} aria-pressed={group === section}
              onClick={() => { learn(null); setGroup(section) }}>{section}</button>)}
          </div>
          <div className="studio-midi-targets">
            <ul aria-label={`${group} mappings`}>
              {targets.filter(target => target.group === group).map(target => {
                const binding = byAction.get(target.id)
                const waiting = learningAction?.id === target.id
                return <li key={target.id}>
                  <span>{target.label}</span>
                  <span className="studio-midi-control">{binding ? <>
                    {controlLabel(binding.control)}
                    {binding.when && <span className="studio-midi-bank">{binding.when.mode === "autoloop" ? "Auto Loop"
                      : binding.when.mode === "savedloop" ? "Saved Loop" : "Hot Cue"}{binding.when.shift ? " · Shift" : ""}</span>}
                    {target.kind === "absolute" && binding.control.kind === "cc" && <label className="studio-midi-invert">
                      <input type="checkbox" checked={binding.inverted === true} aria-label={`Reverse ${target.label}`}
                        onChange={event => setBinding({ ...binding, inverted: event.currentTarget.checked })} />Reverse
                    </label>}
                  </> : "Unmapped"}</span>
                  <button className="quiet" type="button" disabled={!canLearn} aria-pressed={waiting}
                    aria-label={`${waiting ? "Cancel learning" : "Learn"} ${target.label}`}
                    onClick={() => learn(waiting ? null : { inputId, actionId: target.id })}>
                    {waiting ? "Cancel" : "Learn"}
                  </button>
                  <button className="quiet" type="button" disabled={!binding} aria-label={`Remove mapping for ${target.label}`}
                    onClick={() => remove(inputId, target.id)}>Remove</button>
                </li>
              })}
            </ul>
            {missing.length > 0 && <ul aria-label="Unavailable mappings">
              {missing.map(binding => <li key={binding.actionId}>
                <span>Unavailable · {binding.actionId}</span>
                <span className="studio-midi-control">{controlLabel(binding.control)}</span>
                <button className="quiet" type="button" aria-label={`Remove mapping for ${binding.actionId}`}
                  onClick={() => remove(inputId, binding.actionId)}>Remove</button>
              </li>)}
            </ul>}
          </div>
        </>}
      </>}
    </dialog>
  </>
}
