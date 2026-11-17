import { useCallback, useId, useRef, useState } from "react"
import { MIDI_MAPPING_PREFERENCE_KEY, MAX_MIDI_BINDINGS, putMidiBinding, removeMidiBinding, validateMidiPreferences } from "./midiPreferences"
import type { MidiBinding, MidiLearnTarget, MidiTarget } from "./midiPreferences"
import type { MidiControl } from "./midiMapping"
import type { useUsbMidi } from "./useUsbMidi"
import "./studioMidiPanel.css"

export type { MidiBinding, MidiLearnTarget, MidiTarget } from "./midiPreferences"

const groups = ["Deck A", "Deck B", "Mixer"] as const

function initialBindings(): { bindings: MidiBinding[]; storageError: string | null } {
  try {
    const saved = window.localStorage.getItem(MIDI_MAPPING_PREFERENCE_KEY)
    if (saved === null) return { bindings: [], storageError: null }
    const preferences = validateMidiPreferences(JSON.parse(saved))
    if (preferences) return { bindings: preferences.bindings, storageError: null }
  } catch { /* The browser may disallow access to preferences. */ }
  return { bindings: [], storageError: "Could not read saved MIDI mappings." }
}

export function useMidiBindings() {
  const [state, setState] = useState(initialBindings)
  const current = useRef(state.bindings)

  const commit = useCallback((bindings: MidiBinding[]) => {
    current.current = bindings
    let storageError: string | null = null
    try {
      window.localStorage.setItem(MIDI_MAPPING_PREFERENCE_KEY, JSON.stringify({ version: 1, bindings }))
    } catch {
      storageError = "MIDI mappings are available for this session. The browser could not save them."
    }
    setState({ bindings, storageError })
  }, [])

  const setBinding = useCallback((binding: MidiBinding) => {
    const next = putMidiBinding(current.current, binding)
    if (next) commit(next)
    else setState(previous => ({ ...previous, storageError: previous.bindings.length >= MAX_MIDI_BINDINGS
      ? `The mapping limit is ${MAX_MIDI_BINDINGS}. Remove an unused mapping to learn another.`
      : "This MIDI control could not be mapped." }))
  }, [commit])

  const removeBinding = useCallback((inputId: string, actionId: string) => {
    const next = removeMidiBinding(current.current, inputId, actionId)
    if (next.length !== current.current.length) commit(next)
  }, [commit])

  return { ...state, setBinding, removeBinding }
}

type PanelProps = {
  midi: ReturnType<typeof useUsbMidi>
  targets: readonly MidiTarget[]
  bindings: readonly MidiBinding[]
  learning: MidiLearnTarget | null
  learn: (change: MidiLearnTarget | null) => void
  remove: (inputId: string, actionId: string) => void
  storageError?: string | null
}

function controlLabel(control: MidiControl) {
  return `${control.kind === "cc" ? "CC" : "Note"} ${control.number} · Ch ${control.channel}`
}

export default function StudioMidiPanel({ midi, targets, bindings, learning, learn, remove, storageError }: PanelProps) {
  const dialog = useRef<HTMLDialogElement>(null)
  const headingId = useId()
  const [open, setOpen] = useState(false)
  const [selectedInput, setSelectedInput] = useState("")
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
            <select value={inputId} onChange={event => {
              learn(null)
              setSelectedInput(event.currentTarget.value)
            }}>
              {[...inputOptions].map(([id, option]) => <option value={id} key={id}>{option.label}</option>)}
            </select>
          </label>}
        </div>
        <div aria-live="polite" className="studio-midi-status">
          {midi.error && <p>{midi.error}</p>}
          {storageError && <p>{storageError}</p>}
          {learningAction ? <p>Waiting for {learningAction.kind === "button" ? "a button press" : "knob or fader movement"} for <strong>{learningAction.label}</strong>.</p>
            : midi.status === "connected" && !midi.inputs.length ? <p>Connect a controller to learn new mappings.</p>
            : canLearn ? <p>Choose Learn, then use the controller. Learning an already mapped control moves its assignment.</p>
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
                  <span className="studio-midi-control">{binding ? controlLabel(binding.control) : "Unmapped"}</span>
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
