export const DECK_FX_KINDS = ["echo", "pingPong", "room", "flanger", "tremolo"] as const
export type DeckFxKind = typeof DECK_FX_KINDS[number]

export interface DeckFxSettings {
  kind: DeckFxKind
  enabled: boolean
  mix: number
  delayMs: number
  feedback: number
  pingPongDelayMs: number
  pingPongFeedback: number
  roomPredelayMs: number
  roomDamping: number
  tremoloRateHz: number
  tremoloDepth: number
  flangerRateHz: number
  flangerDepth: number
}

export const DEFAULT_DECK_FX: Readonly<DeckFxSettings> = Object.freeze({
  kind: "echo",
  enabled: false,
  mix: 30,
  delayMs: 375,
  feedback: 30,
  pingPongDelayMs: 500,
  pingPongFeedback: 35,
  roomPredelayMs: 18,
  roomDamping: 35,
  tremoloRateHz: 4,
  tremoloDepth: 80,
  flangerRateHz: .3,
  flangerDepth: 70,
})

export const FX_MIX_RANGE = [0, 100] as const
export const FX_DELAY_MS_RANGE = [60, 1_000] as const
export const FX_FEEDBACK_RANGE = [0, 70] as const
export const FX_ROOM_PREDELAY_RANGE = [0, 90] as const
export const FX_ROOM_DAMPING_RANGE = [0, 100] as const
export const FX_TREMOLO_RATE_RANGE = [.5, 16] as const
export const FX_TREMOLO_DEPTH_RANGE = [0, 100] as const
export const FX_FLANGER_RATE_RANGE = [.05, 3] as const
export const FX_FLANGER_DEPTH_RANGE = [0, 100] as const

const ROOM_TAIL_SECONDS = 1.3

function bounded(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback
}

export function normalizeDeckFx(value: unknown): DeckFxSettings {
  const settings = value && typeof value === "object" ? value as Partial<DeckFxSettings> : DEFAULT_DECK_FX
  return {
    kind: DECK_FX_KINDS.find(kind => kind === settings.kind) ?? "echo",
    enabled: settings.enabled === true,
    mix: bounded(settings.mix, ...FX_MIX_RANGE, DEFAULT_DECK_FX.mix),
    delayMs: bounded(settings.delayMs, ...FX_DELAY_MS_RANGE, DEFAULT_DECK_FX.delayMs),
    feedback: bounded(settings.feedback, ...FX_FEEDBACK_RANGE, DEFAULT_DECK_FX.feedback),
    pingPongDelayMs: bounded(settings.pingPongDelayMs, ...FX_DELAY_MS_RANGE, DEFAULT_DECK_FX.pingPongDelayMs),
    pingPongFeedback: bounded(settings.pingPongFeedback, ...FX_FEEDBACK_RANGE, DEFAULT_DECK_FX.pingPongFeedback),
    roomPredelayMs: bounded(settings.roomPredelayMs, ...FX_ROOM_PREDELAY_RANGE, DEFAULT_DECK_FX.roomPredelayMs),
    roomDamping: bounded(settings.roomDamping, ...FX_ROOM_DAMPING_RANGE, DEFAULT_DECK_FX.roomDamping),
    tremoloRateHz: bounded(settings.tremoloRateHz, ...FX_TREMOLO_RATE_RANGE, DEFAULT_DECK_FX.tremoloRateHz),
    tremoloDepth: bounded(settings.tremoloDepth, ...FX_TREMOLO_DEPTH_RANGE, DEFAULT_DECK_FX.tremoloDepth),
    flangerRateHz: bounded(settings.flangerRateHz, ...FX_FLANGER_RATE_RANGE, DEFAULT_DECK_FX.flangerRateHz),
    flangerDepth: bounded(settings.flangerDepth, ...FX_FLANGER_DEPTH_RANGE, DEFAULT_DECK_FX.flangerDepth),
  }
}

/** How long a meter may still see an effect tail after the source stops. */
export function deckFxTailSeconds(settings: DeckFxSettings): number {
  const value = normalizeDeckFx(settings)
  if (!value.enabled || value.mix === 0 || value.kind === "tremolo") return 0
  if (value.kind === "flanger") return .008
  if (value.kind === "room") return ROOM_TAIL_SECONDS + value.roomPredelayMs / 1_000 + .04
  const delayMs = value.kind === "pingPong" ? value.pingPongDelayMs : value.delayMs
  const repeat = (value.kind === "pingPong" ? value.pingPongFeedback : value.feedback) / 100
  const echoes = repeat > 0 ? Math.ceil(Math.log(.001) / Math.log(repeat)) : 1
  return delayMs / 1_000 * echoes
}

type SetParameter = (parameter: AudioParam, target: number, timeConstant?: number) => void
type WetPath = {
  input: AudioNode
  output: AudioNode
  nodes: AudioNode[]
  update(settings: DeckFxSettings, mix: number, set: SetParameter): number
  stop?(): void
}

function createEcho(context: BaseAudioContext, settings: DeckFxSettings): WetPath {
  const delay = context.createDelay(FX_DELAY_MS_RANGE[1] / 1_000)
  const feedback = context.createGain()
  delay.delayTime.value = settings.delayMs / 1_000
  feedback.gain.value = 0
  delay.connect(feedback)
  feedback.connect(delay)
  return {
    input: delay, output: delay, nodes: [delay, feedback],
    update(value, mix, set) {
      const repeat = mix > 0 ? value.feedback / 100 : 0
      set(delay.delayTime, value.delayMs / 1_000, .025)
      set(feedback.gain, repeat)
      // Compensate for the gain of the repeat train when the echoes overlap.
      return mix * (1 - repeat)
    },
  }
}

function createPingPong(context: BaseAudioContext, settings: DeckFxSettings): WetPath {
  // Fold the wet send to mono so each successive echo can occupy one output channel.
  const input = context.createGain()
  input.channelCount = 1
  input.channelCountMode = "explicit"
  const left = context.createDelay(FX_DELAY_MS_RANGE[1] / 1_000)
  const right = context.createDelay(FX_DELAY_MS_RANGE[1] / 1_000)
  const leftToRight = context.createGain()
  const rightToLeft = context.createGain()
  const output = context.createChannelMerger(2)
  left.delayTime.value = right.delayTime.value = settings.pingPongDelayMs / 1_000
  leftToRight.gain.value = rightToLeft.gain.value = 0
  input.connect(left)
  left.connect(output, 0, 0)
  right.connect(output, 0, 1)
  left.connect(leftToRight)
  leftToRight.connect(right)
  right.connect(rightToLeft)
  rightToLeft.connect(left)
  return {
    input, output, nodes: [input, left, right, leftToRight, rightToLeft, output],
    update(value, mix, set) {
      const repeat = mix > 0 ? value.pingPongFeedback / 100 : 0
      set(left.delayTime, value.pingPongDelayMs / 1_000, .025)
      set(right.delayTime, value.pingPongDelayMs / 1_000, .025)
      set(leftToRight.gain, repeat)
      set(rightToLeft.gain, repeat)
      return mix * (1 - repeat)
    },
  }
}

const roomResponses = new WeakMap<BaseAudioContext, AudioBuffer>()
function roomResponse(context: BaseAudioContext): AudioBuffer {
  const saved = roomResponses.get(context)
  if (saved) return saved
  const rate = context.sampleRate
  const frames = Math.ceil(rate * ROOM_TAIL_SECONDS)
  const response = context.createBuffer(2, frames, rate)
  for (let channel = 0; channel < response.numberOfChannels; channel++) {
    const samples = response.getChannelData(channel)
    let seed = 901_747 + 7_981 * channel
    let filtered = 0
    for (let frame = 0; frame < frames; frame++) {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0
      filtered += .42 * (seed / 0x80000000 - 1 - filtered)
      const envelope = (1 - frame / frames) ** 4 * Math.min(1, frame / (rate * .012))
      samples[frame] = filtered * envelope
    }
  }
  roomResponses.set(context, response)
  return response
}

function createRoom(context: BaseAudioContext, settings: DeckFxSettings): WetPath {
  const predelay = context.createDelay(FX_ROOM_PREDELAY_RANGE[1] / 1_000)
  const room = context.createConvolver()
  const damping = context.createBiquadFilter()
  const cutoff = (amount: number) => Math.min(context.sampleRate * .45, 12_000 * 10 ** (-amount / 100))
  predelay.delayTime.value = settings.roomPredelayMs / 1_000
  room.buffer = roomResponse(context)
  damping.type = "lowpass"
  damping.Q.value = 0
  damping.frequency.value = cutoff(settings.roomDamping)
  predelay.connect(room)
  room.connect(damping)
  return {
    input: predelay, output: damping, nodes: [predelay, room, damping],
    update(value, mix, set) {
      set(predelay.delayTime, value.roomPredelayMs / 1_000, .025)
      set(damping.frequency, cutoff(value.roomDamping), .025)
      return mix
    },
  }
}

function createTremolo(context: BaseAudioContext, settings: DeckFxSettings): WetPath {
  const amplitude = context.createGain()
  const depth = context.createGain()
  const lfo = context.createOscillator()
  depth.gain.value = 0
  lfo.frequency.value = settings.tremoloRateHz
  lfo.type = "sine"
  lfo.connect(depth)
  depth.connect(amplitude.gain)
  lfo.start()
  return {
    input: amplitude, output: amplitude, nodes: [lfo, depth, amplitude],
    update(value, mix, set) {
      const modulation = mix > 0 ? value.tremoloDepth / 200 : 0
      set(lfo.frequency, value.tremoloRateHz)
      set(amplitude.gain, 1 - modulation)
      set(depth.gain, modulation)
      return mix
    },
    stop() { lfo.stop() },
  }
}

function createFlanger(context: BaseAudioContext, settings: DeckFxSettings): WetPath {
  const input = context.createGain()
  const direct = context.createGain()
  const delayed = context.createGain()
  const output = context.createGain()
  const delay = context.createDelay(.008)
  const modulation = context.createGain()
  const lfo = context.createOscillator()
  delay.delayTime.value = .0045
  modulation.gain.value = 0
  lfo.frequency.value = settings.flangerRateHz
  lfo.type = "sine"
  input.connect(direct)
  direct.connect(output)
  input.connect(delay)
  delay.connect(delayed)
  delayed.connect(output)
  lfo.connect(modulation)
  modulation.connect(delay.delayTime)
  lfo.start()
  return {
    input, output, nodes: [input, direct, delayed, output, delay, modulation, lfo],
    update(value, mix, set) {
      const depth = value.flangerDepth / 100
      set(lfo.frequency, value.flangerRateHz)
      set(modulation.gain, .0035 * depth)
      set(direct.gain, 1 - depth / 2)
      set(delayed.gain, depth / 2)
      return mix
    },
    stop() { lfo.stop() },
  }
}

const effects = { echo: createEcho, pingPong: createPingPong, room: createRoom, flanger: createFlanger, tremolo: createTremolo }

function createWetBranch(context: BaseAudioContext, input: AudioNode, output: AudioNode, settings: DeckFxSettings) {
  const send = context.createGain()
  const wet = context.createGain()
  send.gain.value = 0
  wet.gain.value = 0
  const path = effects[settings.kind](context, settings)
  input.connect(send)
  send.connect(path.input)
  path.output.connect(wet)
  wet.connect(output)
  return {
    update(next: DeckFxSettings, mix: number, set: SetParameter) {
      set(send.gain, mix > 0 ? 1 : 0)
      set(wet.gain, path.update(next, mix, set))
    },
    disconnect() {
      path.stop?.()
      for (const node of [send, ...path.nodes, wet]) node.disconnect()
    },
  }
}

export function createDeckEffects(context: BaseAudioContext, settings: DeckFxSettings) {
  const input = context.createGain()
  const dry = context.createGain()
  const output = context.createGain()
  const branches: Partial<Record<DeckFxKind, ReturnType<typeof createWetBranch>>> = {}
  input.connect(dry)
  dry.connect(output)

  function apply(next: DeckFxSettings, smooth: boolean) {
    const value = normalizeDeckFx(next)
    const amount = value.enabled ? value.mix / 100 : 0
    if (amount > 0) branches[value.kind] ??= createWetBranch(context, input, output, value)
    const now = context.currentTime
    function set(parameter: AudioParam, target: number, timeConstant = .015) {
      if (smooth) parameter.setTargetAtTime(target, now, timeConstant)
      else parameter.value = target
    }
    set(dry.gain, 1 - amount)
    for (const kind of DECK_FX_KINDS) branches[kind]?.update(value, kind === value.kind ? amount : 0, set)
  }

  apply(settings, false)
  return {
    input,
    output,
    update(next: DeckFxSettings) { apply(next, true) },
    disconnect() {
      for (const kind of DECK_FX_KINDS) {
        branches[kind]?.disconnect()
        delete branches[kind]
      }
      for (const node of [input, dry, output]) node.disconnect()
    },
  }
}
