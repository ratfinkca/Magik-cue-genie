"""Streaming low-frequency onset evidence for a fixed Studio beat grid."""
from __future__ import annotations

from array import array
from bisect import bisect_left
from dataclasses import dataclass
import math
from pathlib import Path
from statistics import median
import sys
import wave


@dataclass(frozen=True)
class KickPulse:
    period: float
    offset: float
    beats: list[float]
    support: float
    phase_concentration: float
    quarter_support: list[float]
    drift: float
    residual_p90: float
    hop: float


def _low_pass(cutoff: float, rate: float) -> tuple[float, float, float, float]:
    omega = math.tau * cutoff / rate
    cosine = math.cos(omega)
    alpha = math.sin(omega) / math.sqrt(2)
    b0 = (1 - cosine) / (2 * (1 + alpha))
    return b0, 2 * b0, -2 * cosine / (1 + alpha), (1 - alpha) / (1 + alpha)


def read_kick_power(path: Path) -> tuple[list[list[float]], float]:
    """Measure two low-frequency bands and combine stereo power."""
    with wave.open(str(path), "rb") as wav:
        rate, channels = wav.getframerate(), wav.getnchannels()
        hop_frames = max(1, round(.005 * rate))
        if rate < 2000:
            return [], hop_frames / rate
        factor = max(1, rate // 3000)
        hop_frames = max(factor, round(hop_frames / factor) * factor)
        block = factor * channels
        filtered_rate = rate / factor
        # Remove rumble first so crossing filters retain similar phase.
        dc_alpha = 1 - math.exp(-math.tau * 34 / filtered_rate)
        dc = [0.] * channels
        low_states = [[0., 0.] for _ in range(channels)]
        upper_states = [[0., 0.] for _ in range(channels)]
        lb, l2b, la1, la2 = _low_pass(123, filtered_rate)
        ub, u2b, ua1, ua2 = _low_pass(235, filtered_rate)
        levels: list[list[float]] = [[], []]
        while raw := wav.readframes(hop_frames):
            samples = array("h", raw)
            if sys.byteorder != "little":
                samples.byteswap()
            low_power = upper_power = 0.
            blocks = 0
            for start in range(0, len(samples) - block + 1, block):
                for channel in range(channels):
                    sample = sum(samples[start + channel:start + block:channels]) / factor
                    dc[channel] += dc_alpha * (sample - dc[channel])
                    signal = sample - dc[channel]
                    lstate, ustate = low_states[channel], upper_states[channel]
                    lower = lb * signal + lstate[0]
                    upper = ub * signal + ustate[0]
                    lstate[0] = l2b * signal - la1 * lower + lstate[1]
                    lstate[1] = lb * signal - la2 * lower
                    ustate[0] = u2b * signal - ua1 * upper + ustate[1]
                    ustate[1] = ub * signal - ua2 * upper
                    low_power += lower * lower
                    upper_power += (upper - lower) ** 2
                blocks += 1
            if blocks:
                levels[0].append(low_power / (blocks * channels))
                levels[1].append(upper_power / (blocks * channels))
    return levels, hop_frames / rate


def _smooth_novelty(power: list[float], hop: float) -> list[float]:
    width = max(1, round(.020 / hop))
    weights = [.5 + .5 * math.cos(math.pi * i / (width + 1)) for i in range(-width, width + 1)]
    scale = sum(weights) * 32768 ** 2
    padded = [0.] * width + power + [0.] * width
    smooth = [math.sqrt(sum(weight * value for weight, value in zip(weights, padded[i:i + len(weights)])) / scale)
              for i in range(len(power))]
    if max(smooth, default=0.) < .018:
        return [0.] * len(power)
    ordered = sorted(smooth)
    baseline = max(.001, 2.5 * ordered[int(.72 * (len(ordered) - 1))])
    levels = [math.log1p(value / baseline) for value in smooth]
    lag = max(1, round(.020 / hop))
    rises = [max(0., value - (levels[i - lag] if i >= lag else 0.)) for i, value in enumerate(levels)]
    ordered = sorted(rises)
    norm = max(.008, ordered[int(.96 * (len(ordered) - 1))])
    return [min(3., rise / norm) for rise in rises]


def kick_onsets(bands: list[list[float]], hop: float) -> list[tuple[float, float]]:
    """Return sparse attacks from smoothed and normalized low-band novelty."""
    if len(bands) != 2 or not bands[0] or max(bands[0]) < (.017 * 32768) ** 2:
        return []
    low, upper = (_smooth_novelty(band, hop) for band in bands)
    rises = [a * .73 + b * .27 for a, b in zip(low, upper)]
    indices: list[int] = []
    for i, rise in enumerate(rises):
        if rise < .38 or low[i] < .20:
            continue
        if (i and rise < rises[i - 1]) or (i + 1 < len(rises) and rise <= rises[i + 1]):
            continue
        if indices and (i - indices[-1]) * hop < .105:
            if rise > rises[indices[-1]]:
                indices[-1] = i
        else:
            indices.append(i)
    return [(max(0., i * hop), rises[i] ** 1.3) for i in indices]


def _phase_at_tempo(events: list[tuple[float, float]], bpm: float) -> tuple[float, float]:
    """Weighted circular mean and concentration of observed kick attacks."""
    step = math.tau * bpm / 60
    x = sum(weight * math.cos(time * step) for time, weight in events)
    y = sum(weight * math.sin(time * step) for time, weight in events)
    return math.hypot(x, y), (math.atan2(y, x) / step) % (60 / bpm)


def _consistent_pulse(events: list[tuple[float, float]], bpm: float, offset: float,
                      concentration: float, duration: float, hop: float) -> KickPulse | None:
    period = 60 / bpm
    times = [time for time, _ in events]

    def collect(window: float) -> tuple[list[tuple[int, float]], int]:
        first = math.ceil(-offset / period)
        last = math.floor((duration - offset) / period)
        matches = []
        for index in range(first, last + 1):
            center = offset + index * period
            at = bisect_left(times, center)
            neighbors = times[max(0, at - 1):at + 1]
            if not neighbors:
                continue
            chosen = min(neighbors, key=lambda time: abs(time - center))
            if abs(chosen - center) <= window:
                matches.append((index, chosen))
        return matches, max(0, last - first + 1)

    # Refine using the selected attacks at their actual times. The fit is
    # global, so a precise local pulse can't disguise a tempo or phase shift.
    for _ in range(2):
        matched, count = collect(.048)
        if len(matched) < 16 or len(matched) < count * .52:
            return None
        average_index = sum(index for index, _ in matched) / len(matched)
        average_time = sum(time for _, time in matched) / len(matched)
        denominator = sum((index - average_index) ** 2 for index, _ in matched)
        new_period = sum((index - average_index) * (time - average_time)
                         for index, time in matched) / denominator
        new_offset = average_time - average_index * new_period
        if abs(new_period - period) > .0025 or abs(new_offset - offset) > .06:
            return None
        period, offset = new_period, new_offset

    matched, count = collect(.035)
    if len(matched) < 16 or len(matched) < count * .63 or not 70 <= 60 / period <= 180:
        return None
    quarters = []
    median_residuals = []
    for quarter in range(4):
        start, stop = duration * quarter / 4, duration * (quarter + 1) / 4
        expected = max(1, math.ceil((stop - offset) / period) - math.ceil((start - offset) / period))
        residuals = [time - (offset + index * period) for index, time in matched
                     if start <= offset + index * period < stop]
        if len(residuals) < max(3, expected * .35):
            return None
        quarters.append(len(residuals) / expected)
        median_residuals.append(median(residuals))
    # One breakdown can have sparse kicks. Keep the fixed grid only when the
    # other three quarters and the global fit still corroborate this phase.
    if sum(support >= .48 for support in quarters) < 3:
        return None
    drift = max(median_residuals) - min(median_residuals)
    ordered = sorted(abs(time - (offset + index * period)) for index, time in matched)
    p90 = ordered[math.ceil(.9 * len(ordered)) - 1]
    if drift > .023 or p90 > .026:
        return None
    # Expose observed attacks only. The lattice merely indexes their evidence.
    return KickPulse(period, offset % period, [time for _, time in matched], len(matched) / count,
                     concentration, quarters, drift, p90, hop)


def _dense_kick_phase(events: list[tuple[float, float]], bpm: float, hop: float) -> float | None:
    """Find a tight, well-separated phase cluster without loudness weighting."""
    period = 60 / bpm
    bins = min(192, max(24, round(period / hop)))
    width = period / bins
    counts = [0] * bins
    for time, _ in events:
        counts[round((time % period) / width) % bins] += 1
    radius = max(1, round(.024 / width))
    density = [sum(counts[(i + delta) % bins] for delta in range(-radius, radius + 1)) for i in range(bins)]
    best = max(range(bins), key=density.__getitem__)
    alternative = max((value for i, value in enumerate(density)
                       if min(abs(i - best), bins - abs(i - best)) * width >= .07), default=0)
    if alternative >= density[best] * .90:
        return None
    weight = density[best]
    center = sum(delta * counts[(best + delta) % bins] for delta in range(-radius, radius + 1)) / weight
    return ((best + center) * width) % period


def fit_kick_pulse(events: list[tuple[float, float]], seeds: list[float],
                   duration: float, hop: float) -> KickPulse | None:
    if len(events) < 16 or events[-1][0] - events[0][0] < 8 or not seeds:
        return None
    # The span determines tempo resolution: a candidate must stay coherent
    # across the complete recording. Narrow searches around audio-derived
    # seed tempos keep the work bounded.
    step = min(.15, max(.006, 12 / duration))
    shifts = math.ceil(1.5 / step)
    tempos = sorted({round(seed + i * step, 6) for seed in seeds[:3]
                     for i in range(-shifts, shifts + 1) if 70 <= seed + i * step <= 180})
    if not tempos:
        return None
    total = sum(weight for _, weight in events)
    scored = sorted(((*_phase_at_tempo(events, bpm), bpm) for bpm in tempos), reverse=True)
    best_mass, _, best_bpm = scored[0]
    rival = next((mass for mass, _, bpm in scored if abs(bpm - best_bpm) > 2.1), 0.)
    # Bass notes and drum subdivisions often add energy at other phases.
    # Require a distinguishable kick phase here and let the per-quarter beat
    # coverage and residual checks decide whether the grid is trustworthy.
    if best_mass < total * .16 or rival >= best_mass * .90:
        return None
    finer = [best_bpm + i * step / 10 for i in range(-10, 11)
             if 70 <= best_bpm + i * step / 10 <= 180]
    mass, offset, bpm = max((*_phase_at_tempo(events, candidate), candidate) for candidate in finer)
    fit = _consistent_pulse(events, bpm, offset, mass / total, duration, hop)
    if fit:
        return fit
    # A strong bass or percussion offbeat can pull the circular mean away
    # from the actual kicks. The density fallback must pass the same fit.
    dense_phase = _dense_kick_phase(events, bpm, hop)
    return _consistent_pulse(events, bpm, dense_phase, mass / total, duration, hop) if dense_phase is not None else None
