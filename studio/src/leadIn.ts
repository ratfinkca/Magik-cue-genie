import type { Cue } from "./cues";
import { MIN_TRACK_SECONDS } from "./trackTime";

export type LeadInUnit = "seconds" | "beats" | "bars";
export type LeadInPlacement = "insert" | "append";

export function leadInSeconds(unit: LeadInUnit, amount: number, bpm: number | null, beatsPerBar: number): number | null {
  if (!Number.isFinite(amount) || amount < 0 || amount > 600) return null;
  if (unit === "seconds" || amount === 0) return amount;
  if (!Number.isInteger(amount) || bpm === null || !Number.isFinite(bpm) || bpm < 20 || bpm > 400) return null;
  if (unit === "bars" && (!Number.isInteger(beatsPerBar) || beatsPerBar < 1 || beatsPerBar > 16)) return null;
  return amount * (60 / bpm) * (unit === "bars" ? beatsPerBar : 1);
}

export function leadInPlaybackRate(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 1;
}

/** Seconds use track time. Beat/bar overrides describe a tempo heard at playback speed. */
export function leadInTrackSeconds(unit: LeadInUnit, amount: number, sourceBpm: number | null,
  beatsPerBar: number, playbackRate: number, tempoOverride?: number): number | null {
  // With the deck's own adjusted BPM, the playback rate and tempo adjustment cancel out.
  if (unit === "seconds" || tempoOverride === undefined) return leadInSeconds(unit, amount, sourceBpm, beatsPerBar);
  const seconds = leadInSeconds(unit, amount, tempoOverride, beatsPerBar);
  return seconds === null ? null : seconds * leadInPlaybackRate(playbackRate);
}

export function leadInTime(cueTime: number, offset: number | null): number | null {
  if (offset === null || offset <= 0 || !Number.isFinite(offset)) return null;
  const time = cueTime - offset;
  return Number.isFinite(time) && time >= MIN_TRACK_SECONDS ? time : null;
}

export function placeLeadIn(cues: Cue[], targetIndex: number, target: Cue, leadIn: Cue,
  previousIndex: number, placement: LeadInPlacement): { cues: Cue[]; selected: number } {
  const next = cues.map((cue, index) => index === targetIndex ? target : cue)
    .filter((_, index) => index !== previousIndex);
  const parentIndex = next.indexOf(target);
  next.splice(placement === "insert" ? parentIndex : next.length, 0, leadIn);
  return { cues: next, selected: next.indexOf(target) };
}
