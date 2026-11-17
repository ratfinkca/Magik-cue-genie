import { analyzeTrack } from "./analyzer"
import { appendAnalysisLoops, mergeTrackAnalysis } from "./analysisPreparation"
import { readBeatTimes } from "./beatGrid"
import { estimateKey, formatKey } from "./key"
import { queueLocalPreparation } from "./localPreparationQueue"
import { prepareCachedDeckStems } from "./localStems"
import type { AnalysisPreferences } from "./studioPreferences"
import { readDeckKey, readDeckTempo } from "./trackAnalysisEvidence"
import { openLibraryFile, readTrackPrep, writeTrackPrep } from "./trackLibrary"
import { readTrackMetadata } from "./trackMetadata"
import { buildWaveform } from "./waveform"

export type LibraryPreparationKind = "analysis" | "stems"
export type DecodeForPreparation = (file: File, signal: AbortSignal) => Promise<AudioBuffer>

export function prepareLibraryTrack(id: string, kind: LibraryPreparationKind, decode: DecodeForPreparation,
  preferences: AnalysisPreferences, signal: AbortSignal) {
  return queueLocalPreparation(async () => {
    signal.throwIfAborted()
    const stored = await openLibraryFile(id)
    if (!stored) throw new Error("Add the audio file before preparing this track.")
    const { file } = stored
    const source = await decode(file, signal)
    if (kind === "stems") {
      await prepareCachedDeckStems(source, id, signal)
      return
    }

    const result = await analyzeTrack(file, source, signal)
    const tags = await readTrackMetadata(file)
    signal.throwIfAborted()
    const foundKey = tags.key ?? await estimateKey(source, signal).catch(() => null)
    const observed = readBeatTimes(result.analysis.studio_beatgrid, source.duration).length >= 3
    const waveform = preferences.emergencyLoops === "off" || !observed ? null : await buildWaveform(source, signal).catch(() => null)
    signal.throwIfAborted()
    const duration = source.duration
    // Read after the expensive work so edits made on either deck during analysis are included.
    const previous = await readTrackPrep(id)
    signal.throwIfAborted()
    const { sidecar } = mergeTrackAnalysis(previous, result, duration, preferences)
    const hasGrid = readBeatTimes(sidecar.analysis.studio_beatgrid, duration).length >= 2
    const tempo = readDeckTempo(sidecar.analysis, tags.bpm, hasGrid)
    const key = readDeckKey(sidecar.analysis, tags.key, foundKey)
    sidecar.analysis = {
      ...sidecar.analysis, duration_seconds: duration, estimated_bpm: tempo.bpm,
      ...(tempo.source === "file_tag" && { estimated_bpm_source: "file_tag", estimated_bpm_confidence: undefined }),
      ...(key && { estimated_key: formatKey(key, "standard"), studio_key_source: key.method === "file-tag" ? "file_tag" : "audio" }),
    }
    await writeTrackPrep(id, appendAnalysisLoops(sidecar, waveform, tempo.bpm, duration, preferences))
  })
}
