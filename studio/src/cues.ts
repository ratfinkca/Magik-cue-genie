import { MIN_TRACK_SECONDS } from "./trackTime";

export type Cue = {
  label: string;
  time_seconds: number;
  confidence: number;
  reason: string;
  metadata?: Record<string, unknown>;
};

export type Sidecar = {
  schema_version: 1;
  source_file: string;
  analysis: Record<string, unknown>;
  cues: Cue[];
  warnings: string[];
};

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const inRange = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;

export function normalizeCueColor(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const color = value.trim().toLowerCase();
  if (/^#[a-f0-9]{6}$/.test(color)) return color;
  if (/^#[a-f0-9]{3}$/.test(color)) return color.replace(/[a-f0-9]/g, digit => digit + digit);
  return undefined;
}

export function cueColor(cue: Cue): string | undefined {
  return normalizeCueColor(cue.metadata?.color);
}

export function readSidecar(text: string, fileName: string, duration: number): Sidecar {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("This cue sidecar is not valid JSON.");
  }
  return validateSidecar(data, fileName, duration, false);
}

/** A failed suggestion should not discard a valid local-analysis result. */
export function readStudioAnalysis(data: unknown, fileName: string, duration: number): Sidecar {
  return validateSidecar(data, fileName, duration, true);
}

function validateSidecar(data: unknown, fileName: string, duration: number, recoverCues: boolean): Sidecar {
  if (!record(data) || data.schema_version !== 1 || (!recoverCues && !Array.isArray(data.cues))
    || !record(data.analysis) || !Array.isArray(data.warnings)
    || data.warnings.some((warning) => typeof warning !== "string")) {
    throw new Error("Choose a Magik Cue Genie version 1 sidecar.");
  }
  if (data.source_file !== fileName) {
    throw new Error("Open the audio file named in this sidecar first.");
  }
  const reportedDuration = data.analysis.duration_seconds;
  if (typeof reportedDuration === "number" && Math.abs(duration - reportedDuration) > 0.5) {
    throw new Error("The sidecar duration and the loaded track do not match.");
  }
  const candidates = Array.isArray(data.cues) ? data.cues : [];
  let failed = !Array.isArray(data.cues);
  const cues: Cue[] = [];
  for (const cue of candidates) {
    if (!record(cue) || typeof cue.label !== "string" || !cue.label.trim()
      || typeof cue.reason !== "string" || !inRange(cue.time_seconds, MIN_TRACK_SECONDS, duration + 0.05)
      || !inRange(cue.confidence, 0, 1)) {
      if (!recoverCues) throw new Error("This sidecar contains an invalid label, timestamp, or confidence.");
      failed = true;
      continue;
    }
    const metadata = record(cue.metadata) ? { ...cue.metadata } : undefined;
    if (metadata && "color" in metadata) {
      const color = normalizeCueColor(metadata.color);
      if (color) metadata.color = color;
      else delete metadata.color;
    }
    cues.push({
      ...cue,
      label: cue.label,
      time_seconds: Math.min(cue.time_seconds, duration),
      confidence: cue.confidence,
      reason: cue.reason,
      metadata,
    });
  }
  let analysis = data.analysis;
  let warnings = data.warnings;
  if (failed) {
    const stage = record(analysis.studio_cues) ? analysis.studio_cues : {};
    analysis = { ...analysis, studio_cues: { ...stage, status: cues.length ? "partial" : "error", count: cues.length } };
    warnings = [...warnings, "Some local cue suggestions could not be read."];
  }
  return { ...data, schema_version: 1, source_file: fileName, analysis, cues, warnings };
}

export function demoCues(duration: number): Cue[] {
  return [
    { label: "Mix in", time_seconds: 0, confidence: 1, reason: "The first kick sets the tempo." },
    { label: "First drop", time_seconds: 16, confidence: 1, reason: "The full bassline and drums enter here." },
    { label: "Mix out", time_seconds: 24, confidence: 1, reason: "The arrangement starts to thin out." },
  ].filter((cue) => cue.time_seconds <= duration);
}

export function formatTime(seconds: number, detailed = false): string {
  const ms = Math.round(Math.abs(seconds) * 1000);
  const sign = seconds < 0 && ms > 0 ? "-" : "";
  const whole = Math.floor(ms / 1000);
  const minutes = Math.floor(whole / 60).toString().padStart(2, "0");
  const remainder = (whole % 60).toString().padStart(2, "0");
  return `${sign}${minutes}:${remainder}${detailed ? "." + (ms % 1000).toString().padStart(3, "0") : ""}`;
}
