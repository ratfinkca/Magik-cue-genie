import { createMidiSoftTakeover, decodeMidiMessage, midiAbsoluteValue, midiButtonPressed, midiControlKey } from "./midiMapping"
import type { ControllerPadMode, MidiBinding, MidiLearnTarget, MidiTarget } from "./midiPreferences"
import type { ControllerPreset } from "./controllerPresets"
import type { HotCueFinish } from "./hotCueGesture"

type Axis = { position: number; centered?: boolean; set: (position: number) => number | void }
type MidiRoute = {
  bindings: readonly MidiBinding[]
  targets: readonly MidiTarget[]
  learning: MidiLearnTarget | null
  learned(binding: MidiBinding): void
  press(actionId: string): HotCueFinish | undefined
  axis(actionId: string): Axis | null
  preset?: ControllerPreset
}

type InputState = {
  pressed: Map<string, { actionId: string; finish?: HotCueFinish }>
  pickup: ReturnType<typeof createMidiSoftTakeover>
  axes: Map<string, { actionId: string; mapping: string; resolution: number;
    output?: { committed: number; before: number; observed: boolean } }>
  pendingCc: Map<string, { mapping: string; msb?: number; lsb?: number }>
  presetId?: string
  shifts: Record<"A" | "B", boolean>
  modes: Record<"A" | "B", ControllerPadMode>
}

function bindingSignature(binding: MidiBinding) {
  return `${binding.actionId}:${binding.control.lsb ?? ""}:${binding.inverted === true}:${JSON.stringify(binding.when ?? null)}`
}

function conditionMatches(binding: MidiBinding, input: InputState) {
  const condition = binding.when
  return !condition || (input.presetId !== undefined
    && (condition.shift === undefined || condition.shift === input.shifts[condition.deck])
    && (condition.mode === undefined || condition.mode === input.modes[condition.deck]))
}

function centeredValue(value: number, center: number) {
  const midpoint = 64 / 127
  return value <= center ? midpoint * value / center
    : midpoint + (1 - midpoint) * (value - center) / (1 - center)
}

function invertCenteredValue(value: number) {
  const midpoint = 64 / 127
  return value <= midpoint ? midpoint + (1 - midpoint) * (1 - value / midpoint)
    : midpoint * (1 - (value - midpoint) / (1 - midpoint))
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
    const entry = input.axes.get(key)
    const output = entry?.output
    if (!output) return
    const tolerance = 2 / entry.resolution
    if (Math.abs(position - output.committed) <= tolerance) output.observed = true
    else if (output.observed || Math.abs(position - output.before) > tolerance) {
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
    let input = inputs.get(inputId)
    if (!input || input.presetId !== route.preset?.id) {
      removeInput(inputId)
      input = { pressed: new Map(), pickup: createMidiSoftTakeover(), axes: new Map(), pendingCc: new Map(),
        presetId: route.preset?.id, shifts: { A: false, B: false }, modes: { A: "hotcue", B: "hotcue" } }
      inputs.set(inputId, input)
    }
    const pressed = midiButtonPressed(message)
    const binding = route.bindings.find(item => item.inputId === inputId && conditionMatches(item, input) && item.control.kind === message.kind
      && item.control.channel === message.channel
      && (item.control.number === message.number || (message.kind === "cc" && item.control.lsb === message.number)))
    const key = midiControlKey(binding?.control ?? message)
    const active = input.pressed.get(key)
    if (active) {
      if (!pressed) {
        input.pressed.delete(key)
        const remains = route.bindings.some(item => item.inputId === inputId && item.actionId === active.actionId && midiControlKey(item.control) === key)
        active.finish?.(remains ? "release" : "cancel")
      }
      return
    }

    if (!binding && route.learning?.inputId !== inputId) {
      for (const deck of ["A", "B"] as const) {
        const shift = route.preset?.shifts?.[deck]
        if (shift && midiControlKey(shift) === key) { input.shifts[deck] = pressed; return }
      }
      const mode = route.preset?.modes?.find(item => midiControlKey(item.control) === key)
      if (mode) { if (pressed) input.modes[mode.deck] = mode.mode; return }
    }

    if (route.learning?.inputId === inputId) {
      const target = route.targets.find(item => item.id === route.learning?.actionId)
      if (!target || (target.kind === "button" ? !pressed : message.kind !== "cc")) return
      if (target.kind === "button") input.pressed.set(key, { actionId: target.id })
      input.pickup.reset(key)
      input.axes.delete(key)
      input.pendingCc.delete(key)
      route.learned({ inputId, actionId: target.id,
        control: binding?.control.lsb !== undefined ? { ...binding.control }
          : { kind: message.kind, channel: message.channel, number: message.number },
        ...(binding?.inverted === undefined ? {} : { inverted: binding.inverted }) })
      return
    }

    const target = binding && route.targets.find(item => item.id === binding.actionId)
    if (!target) return
    if (target.kind === "button") {
      if (binding.control.lsb !== undefined) return
      if (pressed) input.pressed.set(key, { actionId: target.id, finish: route.press(target.id) })
      return
    }

    let value = midiAbsoluteValue(message)
    const axis = value === null ? null : route.axis(target.id)
    if (value === null || !axis) {
      input.pickup.reset(key)
      input.axes.delete(key)
      input.pendingCc.delete(key)
      return
    }
    const mapping = bindingSignature(binding)
    const resolution = binding.control.lsb === undefined ? 127 : 16383
    if (binding.control.lsb !== undefined) {
      let pending = input.pendingCc.get(key)
      if (!pending || pending.mapping !== mapping) {
        pending = { mapping }
        input.pendingCc.set(key, pending)
      }
      const initialized = pending.msb !== undefined && pending.lsb !== undefined
      const previous = message.number === binding.control.number ? pending.msb : pending.lsb
      if (message.number === binding.control.number) pending.msb = message.value
      else pending.lsb = message.value
      if (pending.msb === undefined || pending.lsb === undefined) return
      if (initialized && previous === message.value) return
      value = (pending.msb * 128 + pending.lsb) / resolution
      if (axis.centered) value = centeredValue(value, 8192 / 16383)
    }
    if (binding.inverted) value = axis.centered ? invertCenteredValue(value) : 1 - value
    const previous = input.axes.get(key)
    if (previous && previous.mapping !== mapping) {
      input.pickup.reset(key)
      input.axes.delete(key)
    } else observeAxis(input, key, axis.position)
    if (input.pickup.accept(key, value, axis.position, resolution)) {
      const applied = axis.set(value)
      input.axes.set(key, { actionId: target.id, mapping, resolution,
        output: { before: axis.position, committed: applied ?? value, observed: false } })
    } else if (!input.axes.has(key)) input.axes.set(key, { actionId: target.id, mapping, resolution })
  }

  function updateBindings(bindings: readonly MidiBinding[]) {
    for (const [inputId, input] of inputs) {
      const controls = bindings.filter(binding => binding.inputId === inputId)
      for (const [key, pending] of input.pendingCc) {
        if (!controls.some(binding => midiControlKey(binding.control) === key && bindingSignature(binding) === pending.mapping)) input.pendingCc.delete(key)
      }
      for (const [key, press] of input.pressed) {
        if (controls.some(binding => midiControlKey(binding.control) === key && binding.actionId === press.actionId)) continue
        press.finish?.("cancel")
        press.finish = undefined
      }
      for (const key of input.axes.keys()) {
        if (controls.some(binding => midiControlKey(binding.control) === key && bindingSignature(binding) === input.axes.get(key)?.mapping)) continue
        input.axes.delete(key)
        input.pickup.reset(key)
      }
    }
  }

  return { receive, removeInput, clear, updateBindings, observeAxes }
}
