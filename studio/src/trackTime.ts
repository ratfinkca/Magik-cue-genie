export const MIN_TRACK_SECONDS = -600

export function clampTrackTime(seconds: number, duration: number): number {
  return Math.max(MIN_TRACK_SECONDS, Math.min(duration, seconds))
}
