import { readStudioAnalysis } from "./cues";
import type { Sidecar } from "./cues";
import { LOCAL_BACKEND_REQUIRED, localBackendUrl, studioLocalBackendAvailable } from "./localBackend";
import { recordDiagnostic } from "./studioDiagnostics";

const MAX_ANALYSIS_UPLOAD_BYTES = 100 * 1024 * 1024;

async function requestAnalysis(audio: Blob, name: string, signal: AbortSignal): Promise<Response> {
  const url = localBackendUrl("api/analyze");
  if (!url) throw new Error(LOCAL_BACKEND_REQUIRED);
  try {
    return await fetch(url, {
      method: "POST",
      credentials: "same-origin",
      redirect: "error",
      headers: { "Content-Type": "application/octet-stream", "X-Track-Name": encodeURIComponent(name) },
      body: audio,
      signal,
    });
  } catch (cause) {
    signal.throwIfAborted();
    throw new Error("Start the local Cue Studio server to analyze new tracks.", { cause });
  }
}

async function readAnalysis(response: Response, analyzedName: string, duration: number): Promise<Sidecar> {
  if (!response.headers.get("content-type")?.includes("application/json")) {
    throw new Error("Start Cue Studio with Vite to enable the local Python analyzer.");
  }
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error || "Local cue analysis failed.");
  const result = readStudioAnalysis(payload?.sidecar, analyzedName, duration);
  const status = (value: unknown) => {
    if (!value || typeof value !== "object" || !("status" in value)) return null;
    const stage = value.status;
    if (stage === "ready" && "partial" in value && value.partial === true) return "partial";
    return stage === "ready" || stage === "estimated" || stage === "predicted" || stage === "tempo_only" || stage === "unavailable"
      || stage === "partial" || stage === "error" ? stage : null;
  };
  const stages = {
    base: status(result.analysis.studio_base), tempo: status(result.analysis.studio_tempo),
    grid: status(result.analysis.studio_beatgrid), cues: status(result.analysis.studio_cues),
    modelGrid: status(result.analysis.studio_model_grid),
    vocals: status(result.analysis.studio_vocals),
  };
  const incomplete = Object.values(stages).some(stage => stage === "error" || stage === "partial");
  recordDiagnostic(incomplete ? "warn" : "info", "analysis.stages", { ...stages, cueCount: result.cues.length });
  return result;
}

async function pcmCopy(source: AudioBuffer, signal: AbortSignal): Promise<Blob> {
  signal.throwIfAborted();
  // The Python cue analyzer needs RMS windows, so this fallback can use a
  // compact stereo rate. The browser still plays and renders the source buffer.
  const rate = 12_000;
  const channels = Math.min(2, source.numberOfChannels);
  const frames = Math.ceil(source.duration * rate);
  const context = new OfflineAudioContext(channels, frames, rate);
  const node = context.createBufferSource();
  node.buffer = source;
  node.connect(context.destination);
  node.start();
  const rendered = await context.startRendering();
  signal.throwIfAborted();
  const samples = Array.from({ length: channels }, (_, channel) => rendered.getChannelData(channel));
  const byteLength = frames * channels * 2;
  const wav = new ArrayBuffer(44 + byteLength);
  const header = new DataView(wav, 0, 44);
  header.setUint32(0, 0x52494646); // RIFF
  header.setUint32(4, byteLength + 36, true);
  header.setUint32(8, 0x57415645); // WAVE
  header.setUint32(12, 0x666d7420); // fmt
  header.setUint32(16, 16, true);
  header.setUint16(20, 1, true); // PCM
  header.setUint16(22, channels, true);
  header.setUint32(24, rate, true);
  header.setUint32(28, rate * channels * 2, true);
  header.setUint16(32, channels * 2, true);
  header.setUint16(34, 16, true);
  header.setUint32(36, 0x64617461); // data
  header.setUint32(40, byteLength, true);
  const pcm = new DataView(wav, 44);
  for (let frame = 0; frame < frames; frame++) {
    if (frame > 0 && frame % 131_072 === 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      signal.throwIfAborted();
    }
    for (let channel = 0; channel < channels; channel++) {
      const sample = Math.min(1, Math.max(-1, samples[channel][frame]));
      pcm.setInt16((frame * channels + channel) * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
    }
  }
  return new Blob([wav], { type: "audio/wav" });
}

async function analyzePcmCopy(fileName: string, source: AudioBuffer, signal: AbortSignal): Promise<Sidecar> {
  const preparedName = "studio-audio.wav";
  const copy = await pcmCopy(source, signal);
  const prepared = await requestAnalysis(copy, preparedName, signal);
  if (!prepared.ok) recordDiagnostic("warn", "analysis.pcm_http_error", { status: prepared.status });
  const result = await readAnalysis(prepared, preparedName, source.duration);
  return {
    ...result,
    source_file: fileName,
    warnings: [...result.warnings, "Cue analysis used a temporary PCM copy decoded by the browser."],
  };
}

export async function analyzeTrack(file: File, source: AudioBuffer, signal: AbortSignal): Promise<Sidecar> {
  if (!studioLocalBackendAvailable()) throw new Error(LOCAL_BACKEND_REQUIRED);
  if (source.duration > 30 * 60) throw new Error("Studio analysis supports tracks up to 30 minutes.");
  // 12 kHz stereo PCM takes at most 86,400,044 bytes at this duration limit.
  // A playable file can exceed the analyzer's original-byte request limit.
  if (file.size > MAX_ANALYSIS_UPLOAD_BYTES) {
    recordDiagnostic("info", "analysis.oversize_pcm_copy");
    return analyzePcmCopy(file.name, source, signal);
  }
  const response = await requestAnalysis(file, file.name, signal);
  if (!response.ok) recordDiagnostic("warn", "analysis.http_error", { status: response.status });
  if (response.status !== 413 && response.status !== 415 && response.status !== 422) {
    return readAnalysis(response, file.name, source.duration);
  }
  // The browser already decoded the source, even if the loopback analyzer rejected its encoding or size.
  await response.text();
  return analyzePcmCopy(file.name, source, signal);
}
