import { useCallback, useEffect, useRef, useState } from "react"

export type UsbMidiInput = { id: string; name: string; manufacturer: string }
export type UsbMidiStatus = "idle" | "connecting" | "connected" | "unsupported" | "error"

type UsbMidiCallbacks = {
  onMessage: (input: UsbMidiInput, bytes: Uint8Array, timestamp: number) => void
  onInputRemoved?: (inputId: string) => void
}

type MidiState = { status: UsbMidiStatus; inputs: readonly UsbMidiInput[]; error: string | null }
type MidiConnection = { stop?: () => void }
type Binding = {
  port: MIDIInput
  input: UsbMidiInput
  listener: (event: MIDIMessageEvent) => void
  status: "opening" | "listening" | "unavailable"
}

function midiAvailable() {
  return typeof navigator !== "undefined" && typeof navigator.requestMIDIAccess === "function"
}

function unsupportedMessage() {
  return typeof window !== "undefined" && !window.isSecureContext
    ? "Open Cue Studio on localhost or HTTPS to connect MIDI."
    : "This browser does not support Web MIDI. Open Cue Studio in a browser with Web MIDI support."
}

function accessError(error: unknown) {
  const name = error && typeof error === "object" && "name" in error ? error.name : null
  if (name === "NotAllowedError" || name === "SecurityError") return "MIDI access was blocked. Allow MIDI in this site's browser permissions and try again."
  if (name === "NotSupportedError") return "MIDI is unavailable in this browser session. Reconnect the controller and try again."
  return "Could not open MIDI access. Check your controller and browser, then try again."
}

export function listenToMidiInputs(access: MIDIAccess, callbacks: UsbMidiCallbacks,
  onChange: (inputs: readonly UsbMidiInput[], error: string | null) => void) {
  const bindings = new Map<string, Binding>()
  let stopped = false

  function update() {
    if (stopped) return
    const inputs: UsbMidiInput[] = []
    const failed: string[] = []
    for (const { input, status } of bindings.values()) {
      if (status === "listening") inputs.push(input)
      if (status === "unavailable") failed.push(input.name)
    }
    inputs.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    onChange(inputs, failed.length ? `Could not open MIDI input ${failed.join(", ")}. Reconnect the device or close another app using it.` : null)
  }

  function detach(binding: Binding) {
    bindings.delete(binding.input.id)
    binding.port.removeEventListener("midimessage", binding.listener)
    void binding.port.close().catch(() => {})
    if (binding.status === "listening") callbacks.onInputRemoved?.(binding.input.id)
  }

  function attach(port: MIDIInput) {
    const input: UsbMidiInput = { id: port.id, name: port.name?.trim() || "Unnamed MIDI input", manufacturer: port.manufacturer?.trim() || "" }
    const listener = (event: MIDIMessageEvent) => {
      if (bindings.get(input.id) === binding && binding.status === "listening" && port.state === "connected" && event.data?.length) {
        callbacks.onMessage(input, event.data, event.timeStamp)
      }
    }
    const binding: Binding = { port, input, listener, status: "opening" }
    bindings.set(input.id, binding)
    port.addEventListener("midimessage", listener)
    void port.open().then(() => {
      if (bindings.get(input.id) !== binding || stopped) return
      binding.status = "listening"
      update()
    }).catch(() => {
      if (bindings.get(input.id) !== binding || stopped) return
      binding.status = "unavailable"
      update()
    })
  }

  function synchronize(event?: MIDIConnectionEvent) {
    if (stopped || event?.port?.type === "output") return
    const ports = new Map<string, MIDIInput>()
    access.inputs.forEach(port => { if (port.state === "connected") ports.set(port.id, port) })
    for (const [id, binding] of bindings) if (ports.get(id) !== binding.port) detach(binding)
    for (const [id, port] of ports) if (!bindings.has(id)) attach(port)
    update()
  }

  access.addEventListener("statechange", synchronize)
  synchronize()
  return () => {
    if (stopped) return
    stopped = true
    access.removeEventListener("statechange", synchronize)
    for (const binding of bindings.values()) detach(binding)
  }
}

const idleState: MidiState = { status: "idle", inputs: [], error: null }
const unsupportedState = (): MidiState => ({ status: "unsupported", inputs: [], error: unsupportedMessage() })

export function useUsbMidi(callbacks: UsbMidiCallbacks) {
  const [state, setState] = useState<MidiState>(() => midiAvailable() ? idleState : unsupportedState())
  const handlers = useRef(callbacks)
  handlers.current = callbacks
  const active = useRef<MidiConnection | null>(null)

  const stop = useCallback(() => {
    const connection = active.current
    active.current = null
    connection?.stop?.()
  }, [])

  useEffect(() => stop, [stop])

  const connect = useCallback(async () => {
    if (active.current) return
    if (!midiAvailable()) {
      setState(unsupportedState())
      return
    }
    const connection: MidiConnection = {}
    active.current = connection
    setState({ status: "connecting", inputs: [], error: null })
    try {
      const access = await navigator.requestMIDIAccess({ sysex: false })
      if (active.current !== connection) return
      connection.stop = listenToMidiInputs(access, {
        onMessage: (input, bytes, timestamp) => handlers.current.onMessage(input, bytes, timestamp),
        onInputRemoved: id => handlers.current.onInputRemoved?.(id),
      }, (inputs, error) => setState({ status: "connected", inputs, error }))
    } catch (error) {
      if (active.current !== connection) return
      stop()
      setState({ status: "error", inputs: [], error: accessError(error) })
    }
  }, [stop])

  const disconnect = useCallback(() => {
    stop()
    setState(midiAvailable() ? idleState : unsupportedState())
  }, [stop])

  return { ...state, connect, disconnect }
}
