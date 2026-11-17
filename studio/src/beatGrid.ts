const emptyGrid: number[] = [];
export const MIN_MANUAL_GRID_BPM = 40;
export const MAX_MANUAL_GRID_BPM = 400;

export type ManualBeatGrid = { version: 1; bpm: number; anchor_seconds: number };

export function readManualBeatGrid(grid: unknown, duration: number): ManualBeatGrid | null {
  if (!grid || typeof grid !== "object" || !("version" in grid) || grid.version !== 1
    || !("bpm" in grid) || typeof grid.bpm !== "number" || !Number.isFinite(grid.bpm)
    || grid.bpm < MIN_MANUAL_GRID_BPM || grid.bpm > MAX_MANUAL_GRID_BPM
    || !("anchor_seconds" in grid) || typeof grid.anchor_seconds !== "number" || !Number.isFinite(grid.anchor_seconds)
    || !Number.isFinite(duration) || grid.anchor_seconds < 0 || grid.anchor_seconds >= duration) return null;
  return { version: 1, bpm: grid.bpm, anchor_seconds: grid.anchor_seconds };
}

/** Set beat zero on the user's chosen downbeat, including when looking back from it. */
export function manualBeatTicks(grid: ManualBeatGrid, duration: number, minimum = 0) {
  const period = 60 / grid.bpm;
  const first = Math.ceil((minimum - grid.anchor_seconds) / period - 1e-9);
  const end = Math.floor((duration - grid.anchor_seconds) / period + 1e-9);
  const length = end - first + 1;
  if (!Number.isFinite(length) || length < 1 || length > 16_384) return [];
  return Array.from({ length }, (_, offset) => {
    const index = first + offset;
    const time = Math.max(minimum, Math.min(duration, grid.anchor_seconds + index * period));
    return { time, index, estimated: time < 0 };
  });
}

export function readBeatTimes(grid: unknown, duration: number): number[] {
  return readGridTimes(grid, duration, "estimated");
}

export function readModelBeatTimes(grid: unknown, duration: number): number[] {
  if (!grid || typeof grid !== "object" || !("source" in grid) || grid.source !== "beat_this_small0") return emptyGrid;
  return readGridTimes(grid, duration, "predicted");
}

function readGridTimes(grid: unknown, duration: number, status: "estimated" | "predicted"): number[] {
  if (!grid || typeof grid !== "object" || !("status" in grid) || grid.status !== status
    || !("beat_times_seconds" in grid) || !Array.isArray(grid.beat_times_seconds)) return emptyGrid;
  const times: unknown[] = grid.beat_times_seconds;
  if (times.length > 16_384) return emptyGrid;
  const valid: number[] = [];
  for (const time of times) {
    if (typeof time !== "number" || !Number.isFinite(time) || time < 0 || time > duration + 0.05
      || time <= (valid.at(-1) ?? -1)) return emptyGrid;
    if (time <= duration) valid.push(time);
  }
  return valid;
}

export function visibleBeats(beats: number[], start: number, end: number, width: number): number[] {
  function lowerBound(value: number) {
    let left = 0, right = beats.length;
    while (left < right) {
      const middle = Math.floor((left + right) / 2);
      if (beats[middle] < value) left = middle + 1;
      else right = middle;
    }
    return left;
  }
  const first = lowerBound(start);
  const last = lowerBound(end);
  // A grid drawn every few pixels becomes a colored rectangle at full-track zoom.
  // Retain individual beat markers once the user zooms close enough to read them.
  if (last - first > Math.max(1, width / 6)) return [];
  return beats.slice(first, last);
}
