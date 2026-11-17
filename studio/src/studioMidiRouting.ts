import { createMidiSoftTakeover, decodeMidiMessage, midiAbsoluteValue, midiButtonPressed, midiControlKey } from "./midiMapping"
import type { MidiBinding, MidiLearnTarget, MidiTarget } from "./midiPreferences"
import type { HotCueFinish } from "./hotCueGesture"

type Axis = { position: number; set: (position: number) => number | void }
type MidiRoute = {
  bindings: readonly MidiBinding[]
  targets: readonly MidiTarget[]
  learning: MidiLearnTarget | null
  learned(binding: MidiBinding): void
  press(actionId: string): HotCueFinish | undefined
  axis(actionId: string): Axis | null
}

type InputState = {
  pressed: Map<string, { actionId: string; finish?: HotCueFinish }>
  pickup: ReturnType<typeof createMidiSoftTakeover>
  axes: Map<string, { actionId: string; output?: { committed: number; before: number; observed: boolean } }>
}

/** Own each physical press until its release, even if learning or settings change. */
export function createStudioMidiRouter() {
  const inputs = new Map<string, InputState>()

  function removeInput(inputId: string) {
    const input = inputs.get(inputId)
    inputs.delete(inputId)
    for (const press of input?.pressed.values() ?? []) press.finish?.("cancel")
  }

  function clear() {
    for (const inputId of inputs.keys()) removeInput(inputId)
  }

  function observeAxis(input: InputState, key: string, position: number) {
    const output = input.axes.get(key)?.output
    if (!output) return
    if (Math.abs(position - output.committed) <= 2 / 127) output.observed = true
    else if (output.observed || Math.abs(position - output.before) > 2 / 127) {
      input.pickup.reset(key)
      input.axes.delete(key)
    }
  }

  function observeAxes(read: MidiRoute["axis"]) {
    for (const input of inputs.values()) for (const [key, entry] of input.axes) {
      const axis = read(entry.actionId)
      if (axis) observeAxis(input, key, axis.position)
      else { input.pickup.reset(key); input.axes.delete(key) }
    }
  }

  function receive(inputId: string, bytes: ArrayLike<number>, route: MidiRoute) {
    const message = decodeMidiMessage(bytes)
    if (!message) return
    const key = midiControlKey(message)
    let input = inputs.get(inputId)
    if (!input) {
      input = { pressed: new Map(), pickup: createMidiSoftTakeover(), axes: new Map() }
      inputs.set(inputId, input)
    }
    const pressed = midiButtonPressed(message)
    const binding = route.bindings.find(item => item.inputId === inputId && midiControlKey(item.control) === key)
    const active = input.pressed.get(key)
    if (active) {
      if (!pressed) {
        input.pressed.delete(key)
        active.finish?.(binding?.actionId === active.actionId ? "release" : "cancel")
      }
      return
    }

    if (route.learning?.inputId === inputId) {
      const target = route.targets.find(item => item.id === route.learning?.actionId)
      if (!target || (target.kind === "button" ? !pressed : message.kind !== "cc")) return
      if (target.kind === "button") input.pressed.set(key, { actionId: target.id })
      input.pickup.reset(key)
      input.axes.delete(key)
      route.learned({ inputId, actionId: target.id,
        control: { kind: message.kind, channel: message.channel, number: message.number } })
      return
    }

    const target = binding && route.targets.find(item => item.id === binding.actionId)
    if (!target) return
    if (target.kind === "button") {
      if (pressed) input.pressed.set(key, { actionId: target.id, finish: route.press(target.id) })
      return
    }

    const value = midiAbsoluteValue(message)
    const axis = value === null ? null : route.axis(target.id)
    if (value === null || !axis) {
      input.pickup.reset(key)
      input.axes.delete(key)
      return
    }
    const previous = input.axes.get(key)
    if (previous && previous.actionId !== target.id) {
      input.pickup.reset(key)
      input.axes.delete(key)
    } else observeAxis(input, key, axis.position)
    if (input.pickup.accept(key, value, axis.position)) {
      const applied = axis.set(value)
      input.axes.set(key, { actionId: target.id,
        output: { before: axis.position, committed: applied ?? value, observed: false } })
    } else if (!input.axes.has(key)) input.axes.set(key, { actionId: target.id })
  }

  function updateBindings(bindings: readonly MidiBinding[]) {
    for (const [inputId, input] of inputs) {
      const controls = new Map(bindings.filter(binding => binding.inputId === inputId)
        .map(binding => [midiControlKey(binding.control), binding.actionId]))
      for (const [key, press] of input.pressed) {
        if (controls.get(key) === press.actionId) continue
        press.finish?.("cancel")
        press.finish = undefined
      }
      for (const key of input.axes.keys()) {
        if (controls.get(key) === input.axes.get(key)?.actionId) continue
        input.axes.delete(key)
        input.pickup.reset(key)
      }
    }
  }

  return { receive, removeInput, clear, updateBindings, observeAxes }
}
