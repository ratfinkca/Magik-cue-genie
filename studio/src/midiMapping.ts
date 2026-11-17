export type MidiControl = { kind: "note" | "cc"; channel: number; number: number }

export type MidiMessage = (
  | (MidiControl & { kind: "note"; pressed: boolean })
  | (MidiControl & { kind: "cc"; pressed?: never })
) & { value: number }

const channelModeStart = 120
const midiMaximum = 127

function integerBetween(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum
}

export function isMidiControl(value: unknown): value is MidiControl {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const { kind, channel, number } = value as Partial<MidiControl>
  return (kind === "note" || kind === "cc") && integerBetween(channel, 1, 16)
    && integerBetween(number, 0, kind === "cc" ? channelModeStart - 1 : midiMaximum)
}

/** Web MIDI provides a complete message with its status byte. */
export function decodeMidiMessage(data: ArrayLike<number>): MidiMessage | null {
  if (data.length !== 3) return null
  const status = data[0]
  const number = data[1]
  const value = data[2]
  if (!integerBetween(status, 0x80, 0xff) || !integerBetween(number, 0, midiMaximum)
    || !integerBetween(value, 0, midiMaximum)) return null
  const channel = (status & 0x0f) + 1
  const command = status & 0xf0
  if (command === 0x90 || command === 0x80) {
    return { kind: "note", channel, number, value, pressed: command === 0x90 && value !== 0 }
  }
  // Channel Mode operations use the CC status byte but aren't physical controls.
  if (command === 0xb0 && number < channelModeStart) return { kind: "cc", channel, number, value }
  return null
}

export function midiControlKey({ kind, channel, number }: MidiControl): string {
  return `${kind}:${channel}:${number}`
}

export function midiButtonPressed(message: MidiMessage): boolean {
  return message.kind === "note" ? message.pressed : message.value >= 64
}

export function midiAbsoluteValue(message: MidiMessage): number | null {
  return message.kind === "cc" ? message.value / midiMaximum : null
}

/** Ignore hardware until it reaches or crosses the software value. Latches until reset. */
export function createMidiSoftTakeover() {
  const controls = new Map<string, { incoming: number; latched: boolean }>()
  const halfStep = .5 / midiMaximum + Number.EPSILON
  return {
    accept(key: string, incoming: number, current: number) {
      if (!Number.isFinite(incoming) || incoming < 0 || incoming > 1
        || !Number.isFinite(current) || current < 0 || current > 1) return false
      const previous = controls.get(key)
      if (previous?.latched) return true
      const reached = Math.abs(current - incoming) <= halfStep
      const crossed = previous !== undefined && (
        (previous.incoming < current && incoming > current) || (previous.incoming > current && incoming < current)
      )
      const latched = reached || crossed
      controls.set(key, { incoming, latched })
      return latched
    },
    reset(key?: string) {
      if (key === undefined) controls.clear()
      else controls.delete(key)
    },
  }
}
