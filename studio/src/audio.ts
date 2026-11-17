import { useCallback, useEffect, useRef, useState } from 'react'
import { createDemoBuffer, DEMO_NAME } from './demo'

type SourceKind = 'demo' | 'file' | null
export type AuditionBehavior = 'continue' | 'loop' | 'pause'
export type LoopRange = { start: number; end: number }
type Playback = {
  source: AudioBufferSourceNode
  gain: GainNode
  context: AudioContext
  offset: number
  startedAt: number
  end: number
  loop: LoopRange | null
  mode: 'track' | 'excerpt' | 'loop'
}

export interface AudioTransport {
  buffer: AudioBuffer | null
  fileName: string
  sourceKind: SourceKind
  duration: number
  position: number
  getPosition: () => number
  isPlaying: boolean
  hasPlaybackLoop: boolean
  isLoading: boolean
  error: string | null
  volume: number
  setVolume: (value: number) => void
  loadDemo: () => Promise<AudioBuffer | null>
  loadFile: (file: File) => Promise<AudioBuffer | null>
  play: () => Promise<void>
  pause: () => void
  toggle: () => Promise<void>
  seek: (seconds: number) => void
  audition: (cueSeconds: number, beforeSeconds: number, afterSeconds: number, behavior: AuditionBehavior, savedLoop?: LoopRange) => Promise<void>
  setArmedLoop: (loop: LoopRange | null) => void
  exitLoop: () => void
}

const bound = (value: number, maximum: number) => Math.max(0, Math.min(maximum, Number.isFinite(value) ? value : 0))

function usableLoop(loop: LoopRange | null | undefined, from: number, duration: number): LoopRange | null {
  return loop && Number.isFinite(loop.start) && loop.start >= 0 && loop.end <= duration
    && loop.end - loop.start >= 0.05 && from < loop.end ? loop : null
}

/** Browser-local playback. No object URLs, requests, uploads, or original-file writes. */
export function useAudioTransport(): AudioTransport {
  const [buffer, setBuffer] = useState<AudioBuffer | null>(null)
  const [fileName, setFileName] = useState('')
  const [sourceKind, setSourceKind] = useState<SourceKind>(null)
  const [position, setPosition] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [hasPlaybackLoop, setHasPlaybackLoop] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [volume, setVolumeState] = useState(0.8)
  const contextRef = useRef<AudioContext | null>(null)
  const masterGainRef = useRef<GainNode | null>(null)
  const volumeRef = useRef(0.8)
  const bufferRef = useRef<AudioBuffer | null>(null)
  const playbackRef = useRef<Playback | null>(null)
  const armedLoopRef = useRef<LoopRange | null>(null)
  const positionRef = useRef(0)
  const aliveRef = useRef(true)
  const loadingRef = useRef(false)
  const pendingPlayRef = useRef(false)
  const loadIdRef = useRef(0)
  const playIdRef = useRef(0)
  const frameRef = useRef<number | null>(null)

  const getContext = useCallback(() => {
    if (!contextRef.current || contextRef.current.state === 'closed') {
      const AudioContextClass = window.AudioContext
        || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!AudioContextClass) throw new Error('This browser does not support local audio playback.')
      contextRef.current = new AudioContextClass()
      const master = contextRef.current.createGain()
      master.gain.value = volumeRef.current
      master.connect(contextRef.current.destination)
      masterGainRef.current = master
    }
    return contextRef.current
  }, [])

  const setVolume = useCallback((value: number) => {
    const next = bound(value, 1)
    volumeRef.current = next
    if (aliveRef.current) setVolumeState(next)
    const context = contextRef.current
    if (context && masterGainRef.current && context.state !== 'closed') {
      masterGainRef.current.gain.setTargetAtTime(next, context.currentTime, 0.015)
    }
  }, [])

  const currentPosition = useCallback(() => {
    const playback = playbackRef.current
    if (!playback) return positionRef.current
    const raw = playback.offset + Math.max(0, playback.context.currentTime - playback.startedAt)
    const loop = playback.loop
    if (loop && raw >= loop.end) return loop.start + (raw - loop.end) % (loop.end - loop.start)
    return Math.min(playback.end, raw)
  }, [])

  const stopSource = useCallback(() => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
    frameRef.current = null
    const playback = playbackRef.current
    playbackRef.current = null
    if (playback) {
      playback.source.onended = null
      try { playback.source.stop() } catch { /* Already ended. */ }
      playback.source.disconnect()
      playback.gain.disconnect()
    }
  }, [])

  const pause = useCallback(() => {
    const stoppedAt = currentPosition()
    playIdRef.current++
    pendingPlayRef.current = false
    stopSource()
    positionRef.current = stoppedAt
    if (aliveRef.current) {
      setPosition(stoppedAt)
      setIsPlaying(false)
      setHasPlaybackLoop(false)
    }
  }, [currentPosition, stopSource])

  const startAt = useCallback(async (seconds: number, options?: { until?: number; loop?: LoopRange }) => {
    const audio = bufferRef.current
    if (!aliveRef.current || !audio || loadingRef.current) return
    const start = bound(seconds, audio.duration)
    const end = options?.until === undefined ? audio.duration : bound(options.until, audio.duration)
    pause()
    positionRef.current = start
    setPosition(start)
    if (end <= start) return
    const playId = ++playIdRef.current
    pendingPlayRef.current = true
    try {
      const context = getContext()
      await context.resume()
      if (!aliveRef.current || playId !== playIdRef.current || audio !== bufferRef.current || loadingRef.current) return
      const source = context.createBufferSource()
      const gain = context.createGain()
      const mode = options?.loop ? 'loop' : options?.until !== undefined ? 'excerpt' : 'track'
      const loop = usableLoop(mode === 'track' ? armedLoopRef.current : options?.loop, start, end)
      source.buffer = audio
      if (loop) {
        source.loop = true
        source.loopStart = loop.start
        source.loopEnd = loop.end
      }
      source.connect(gain)
      gain.connect(masterGainRef.current ?? context.destination)
      const startedAt = context.currentTime
      const length = end - start
      const fade = Math.min(0.006, length / 3)
      gain.gain.setValueAtTime(0, startedAt)
      gain.gain.linearRampToValueAtTime(0.9, startedAt + fade)
      if (mode === 'excerpt') {
        gain.gain.setValueAtTime(0.9, startedAt + length - fade)
        gain.gain.linearRampToValueAtTime(0, startedAt + length)
      }
      const playback: Playback = { source, gain, context, offset: start, startedAt, end, loop, mode }
      playbackRef.current = playback
      source.onended = () => {
        if (playbackRef.current !== playback) return
        stopSource()
        positionRef.current = playback.end
        if (aliveRef.current) {
          setPosition(playback.end)
          setIsPlaying(false)
          setHasPlaybackLoop(false)
        }
      }
      if (mode === 'excerpt') source.start(startedAt, start, length)
      else source.start(startedAt, start)
      setError(null)
      setIsPlaying(true)
      setHasPlaybackLoop(Boolean(loop))
      let lastPaint = 0
      const tick = (now: number) => {
        if (!aliveRef.current || playbackRef.current !== playback) return
        if (now - lastPaint >= 32) {
          positionRef.current = currentPosition()
          setPosition(positionRef.current)
          lastPaint = now
        }
        frameRef.current = requestAnimationFrame(tick)
      }
      frameRef.current = requestAnimationFrame(tick)
    } catch (cause) {
      if (aliveRef.current && playId === playIdRef.current) {
        stopSource()
        setIsPlaying(false)
        setHasPlaybackLoop(false)
        setError(cause instanceof Error ? cause.message : 'Audio playback could not start.')
      }
    } finally {
      if (playId === playIdRef.current) pendingPlayRef.current = false
    }
  }, [currentPosition, getContext, pause, stopSource])

  const applyLoop = useCallback((playback: Playback, loop: LoopRange | null) => {
    playback.offset = currentPosition()
    playback.startedAt = playback.context.currentTime
    playback.loop = loop
    if (loop) {
      playback.source.loopStart = loop.start
      playback.source.loopEnd = loop.end
    }
    playback.source.loop = Boolean(loop)
    setHasPlaybackLoop(Boolean(loop))
  }, [currentPosition])

  const setArmedLoop = useCallback((loop: LoopRange | null) => {
    armedLoopRef.current = loop
    const playback = playbackRef.current
    if (playback?.mode === 'track') applyLoop(playback, usableLoop(loop, currentPosition(), playback.end))
  }, [applyLoop, currentPosition])

  const exitLoop = useCallback(() => {
    const playback = playbackRef.current
    if (playback?.loop) {
      playback.mode = 'track'
      applyLoop(playback, null)
    }
  }, [applyLoop])

  const load = useCallback(async (
    name: string,
    kind: Exclude<SourceKind, null>,
    decode: (context: AudioContext, isCurrent: () => boolean) => Promise<AudioBuffer | null>,
  ) => {
    const loadId = ++loadIdRef.current
    pause()
    loadingRef.current = true
    setIsLoading(true)
    setError(null)
    const isCurrent = () => aliveRef.current && loadId === loadIdRef.current
    try {
      const nextBuffer = await decode(getContext(), isCurrent)
      if (!isCurrent() || !nextBuffer) return null
      if (!Number.isFinite(nextBuffer.duration) || nextBuffer.duration <= 0) {
        throw new Error('This file has no playable audio.')
      }
      bufferRef.current = nextBuffer
      armedLoopRef.current = null
      positionRef.current = 0
      setBuffer(nextBuffer)
      setFileName(name)
      setSourceKind(kind)
      setPosition(0)
      return nextBuffer
    } catch (cause) {
      if (isCurrent()) {
        setError(cause instanceof Error && cause.name !== 'EncodingError' && cause.name !== 'NotSupportedError'
          ? cause.message
          : 'This browser could not decode the file. Try a WAV or MP3 file.')
      }
      return null
    } finally {
      if (isCurrent()) {
        loadingRef.current = false
        setIsLoading(false)
      }
    }
  }, [getContext, pause])

  const loadDemo = useCallback(() => load(DEMO_NAME, 'demo', async (context) => createDemoBuffer(context)), [load])
  const loadFile = useCallback((file: File) => load(file.name, 'file', async (context, isCurrent) => {
    const bytes = await file.arrayBuffer()
    return isCurrent() ? context.decodeAudioData(bytes) : null
  }), [load])
  const play = useCallback(async () => {
    if (playbackRef.current || pendingPlayRef.current) return
    const duration = bufferRef.current?.duration ?? 0
    await startAt(positionRef.current >= duration ? 0 : positionRef.current)
  }, [startAt])
  const toggle = useCallback(async () => {
    if (playbackRef.current || pendingPlayRef.current) pause()
    else await play()
  }, [pause, play])
  const seek = useCallback((seconds: number) => {
    const next = bound(seconds, bufferRef.current?.duration ?? 0)
    const wasPlaying = playbackRef.current !== null || pendingPlayRef.current
    pause()
    positionRef.current = next
    if (aliveRef.current) setPosition(next)
    if (wasPlaying) void startAt(next)
  }, [pause, startAt])
  const audition = useCallback(async (
    cueSeconds: number, beforeSeconds: number, afterSeconds: number, behavior: AuditionBehavior, savedLoop?: LoopRange,
  ) => {
    const duration = bufferRef.current?.duration ?? 0
    const cue = bound(cueSeconds, duration)
    const before = Number.isFinite(beforeSeconds) ? Math.max(0, beforeSeconds) : 2
    const after = Number.isFinite(afterSeconds) ? Math.max(0, afterSeconds) : 4
    const start = Math.max(0, cue - before)
    const end = Math.min(duration, savedLoop?.end ?? cue + after)
    if (behavior === 'continue') await startAt(start)
    else if (behavior === 'pause') await startAt(start, { until: end })
    else if (end - start >= 0.05) await startAt(start, {
      loop: { start: savedLoop?.start ?? start, end },
    })
  }, [startAt])

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      loadIdRef.current++
      playIdRef.current++
      pendingPlayRef.current = false
      stopSource()
      const context = contextRef.current
      contextRef.current = null
      masterGainRef.current?.disconnect()
      masterGainRef.current = null
      if (context && context.state !== 'closed') void context.close().catch(() => {})
    }
  }, [stopSource])

  return {
    buffer, fileName, sourceKind, duration: buffer?.duration ?? 0, position, getPosition: currentPosition,
    isPlaying, hasPlaybackLoop, isLoading, error, volume, setVolume, loadDemo, loadFile, play, pause, toggle, seek,
    audition, setArmedLoop, exitLoop,
  }
}
