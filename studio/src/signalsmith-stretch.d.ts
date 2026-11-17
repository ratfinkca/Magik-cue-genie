declare module "signalsmith-stretch" {
  interface StretchSchedule {
    output: number
    input?: number
    rate?: number
    active: boolean
    semitones?: number
    loopStart?: number
    loopEnd?: number
  }

  export interface StretchNode extends AudioWorkletNode {
    addBuffers(channels: Float32Array[], transfer: Transferable[]): Promise<number>
    dropBuffers(): Promise<{ start: number; end: number }>
    latency(): Promise<number>
    schedule(options: StretchSchedule): Promise<unknown>
  }

  const createStretchNode: {
    (context: BaseAudioContext, options: AudioWorkletNodeOptions): Promise<StretchNode>
    moduleUrl?: string
  }
  export default createStretchNode
}
