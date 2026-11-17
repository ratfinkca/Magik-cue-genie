"""Conservative Studio pulse estimates; no meter, downbeat or phrase inference.

Streaming 10 ms channel-power frames avoid stereo phase cancellation. Rising
energy detects transient candidates; interval consensus proposes a pulse and a
least-squares fit checks its phase over the entire observed span. This intentionally
abstains on many real mixes: it is not a replacement for a trained beat tracker.
Only observed, supported beats are returned (no grid through silent gaps).
"""
from __future__ import annotations

from array import array
from bisect import bisect_left
import math
from pathlib import Path
from statistics import median
import sys
from typing import Any
import wave

from .studio_kick import fit_kick_pulse, kick_onsets, read_kick_power


def empty_studio_rhythm(status: str = 'unavailable') -> dict[str, Any]:
    return {
        'tempo': {'bpm': None, 'confidence': 0.0, 'source': 'studio_onset_consensus', 'status': status},
        'grid': {'status': status, 'beat_times_seconds': [], 'offset_seconds': None,
                 'confidence': 0.0, 'meter': None, 'downbeat_verified': False, 'evidence': {}},
        'cues': [], 'cue_status': status, 'warnings': [],
    }


def analyze_studio_rhythm(audio_path: Path, sidecar: dict | None = None) -> dict[str, Any]:
    """Read normalized PCM16 WAV without modifying it; return JSON-ready evidence.

    ``sidecar`` is accepted for integration compatibility, but deliberately not
    used: coarse legacy RMS cue timestamps are not beat evidence. Input is capped
    at 30 minutes and 192 kHz stereo; unsupported input yields explicit abstention.
    """
    result = empty_studio_rhythm()
    try:
        energy, hop = _read_power(audio_path)
    except (OSError, EOFError, wave.Error, ValueError):
        result['warnings'].append('Rhythm analysis could not read the decoded PCM audio.')
        return result
    try:
        peaks = _onsets(energy, hop)
        result['grid']['evidence']['onset_count'] = len(peaks)
        fit = _fit_pulse(peaks)
    except Exception:
        fit = None
        result['grid']['status'] = 'error'
        result['warnings'].append('Onset phase fitting failed; trying the independent tempo estimate.')
    fallback = {}
    if fit is None:
        try:
            fallback = _tempo_without_phase(energy, hop)
        except Exception:
            result['tempo']['status'] = 'error'
            result['warnings'].append('The tempo-only analysis did not finish.')
    if fit:
        seeds = [60 / fit[0]]
    elif fallback.get('bpm') is not None:
        seeds = [fallback['bpm']]
    else:
        seeds = [entry['bpm'] for entry in fallback.get('candidates', []) if entry['periodicity_score'] >= .14]
    duration = len(energy) * hop
    kick = None
    kick_seed = 'full_mix_tempo'
    if duration >= 8 and (seeds or result['grid']['evidence'].get('onset_count', 0) >= 16):
        try:
            low_band, kick_hop = read_kick_power(audio_path)
            kicks = kick_onsets(low_band, kick_hop)
            kick = fit_kick_pulse(kicks, seeds, duration, kick_hop)
            if kick is None and fit is None:
                # Busy percussion can obscure the full-mix tempo even when the
                # spaced low attacks agree. Use their timing as a new seed, then
                # still require the complete kick phase/coverage checks.
                low_fit = _fit_pulse([time for time, _ in kicks])
                if low_fit:
                    kick = fit_kick_pulse(kicks, [60 / low_fit[0], *seeds], duration, kick_hop)
                    if kick is not None:
                        kick_seed = 'kick_intervals'
        except Exception:
            result['warnings'].append('The kick-band analysis did not finish; using onset evidence when available.')
    if kick is None and fit is None:
        result['tempo'].update(fallback)
        if fallback.get('bpm') is not None:
            result['warnings'].append('Tempo-only estimate from recurring onsets across multiple audio windows; beat phase is unverified, so beat grid and automatic cues are withheld. Half/double-time ambiguity remains.')
        elif result['grid']['status'] != 'error' and result['tempo']['status'] != 'error':
            result['warnings'].append('No stable, well-supported pulse found; tempo, beat grid and automatic cues withheld.')
        return result

    if kick is not None:
        period, offset, supported, quality = kick.period, kick.offset, kick.beats, kick.support
        evidence = {'method': 'kick_band_phase_fit', 'timing_resolution_seconds': kick.hop,
                    'tempo_seed': kick_seed,
                    'phase_concentration': round(kick.phase_concentration, 3),
                    'quarter_support': [round(value, 3) for value in kick.quarter_support],
                    'phase_drift_seconds': round(kick.drift, 4),
                    'residual_p90_seconds': round(kick.residual_p90, 4)}
        if kick_seed == 'kick_intervals' and fallback.get('bpm') is not None:
            evidence['full_mix_tempo_hint'] = fallback['bpm']
        result['tempo']['source'] = 'studio_kick_phase'
    else:
        assert fit is not None
        period, offset, supported, quality = fit
        evidence = {'method': 'transient_interval_consensus_and_global_phase_fit',
                    'timing_resolution_seconds': hop}
    beats = [round(time, 4) for time in supported]
    confidence = round(min(.88, quality * .88), 3)
    result['tempo'].update(bpm=round(60 / period, 3), confidence=confidence, status='estimated')
    result['grid'].update(status='estimated', beat_times_seconds=beats,
                          offset_seconds=round(offset, 4), confidence=confidence)
    result['grid']['evidence'].update(supported_onset_count=len(beats),
                                     phase_support=round(quality, 3),
                                     period_seconds=round(period, 6),
                                     **evidence)
    result['warnings'].append('Estimated pulse only: half/double tempo, downbeats and musical phrases require listening; meter is unknown.')
    cues = []
    cue_failure = False
    try:
        cues = _cues(energy, hop, beats, period, confidence)
    except Exception:
        cue_failure = True
        result['warnings'].append('Rhythmic cue suggestions did not finish.')
    if kick is not None:
        try:
            mix_cues = _mix_window_cues(beats, period, duration, confidence)
        except Exception:
            mix_cues = []
            cue_failure = True
            result['warnings'].append('Mix-window cue suggestions did not finish.')
        for mix_cue in mix_cues:
            # The useful launch cue replaces the redundant first-transient
            # marker and takes precedence over an adjacent energy hint.
            cues = [cue for cue in cues
                    if abs(cue['time_seconds'] - mix_cue['time_seconds']) > period * 2]
            cues.append(mix_cue)
    result['cues'] = sorted(cues, key=lambda cue: cue['time_seconds'])
    result['cue_status'] = ('partial' if cues else 'error') if cue_failure else ('ready' if cues else 'unavailable')
    return result


def _read_power(path: Path) -> tuple[list[float], float]:
    with wave.open(str(path), 'rb') as wav:
        rate, channels = wav.getframerate(), wav.getnchannels()
        if wav.getsampwidth() != 2 or channels not in (1, 2) or wav.getcomptype() != 'NONE':
            raise ValueError('use normalized mono/stereo PCM16 WAV')
        if not 1000 <= rate <= 192000 or wav.getnframes() > rate * 1800:
            raise ValueError('supported limits are 1–192 kHz and 30 minutes')
        frame_size = max(1, round(rate * .01))
        envelope = []
        while raw := wav.readframes(frame_size):
            values = array('h', raw)
            if sys.byteorder != 'little':
                values.byteswap()
            envelope.append(math.sqrt(sum(value * value for value in values) / len(values)) / 32768)
        return envelope, frame_size / rate


def _onsets(energy: list[float], hop: float) -> list[float]:
    if not energy or max(energy) < .003:
        return []
    rise = [max(0., value - (energy[i - 1] if i else 0.)) for i, value in enumerate(energy)]
    floor = max(.001, max(rise) * .08)
    peaks: list[int] = []
    for i, value in enumerate(rise):
        if value < floor or (i and value < rise[i - 1]) or (i + 1 < len(rise) and value <= rise[i + 1]):
            continue
        if peaks and (i - peaks[-1]) * hop < .18:
            if value > rise[peaks[-1]]:
                peaks[-1] = i
        else:
            peaks.append(i)
    return [i * hop for i in peaks]


def _fit_pulse(peaks: list[float]) -> tuple[float, float, list[float], float] | None:
    if len(peaks) < 16 or peaks[-1] - peaks[0] < 8:
        return None
    intervals = [b - a for a, b in zip(peaks, peaks[1:])]
    eligible = [dt for dt in intervals if 60 / 180 <= dt <= 60 / 70]
    if not eligible:
        return None
    # A compact histogram bounds candidate work even on long files.
    buckets: dict[int, list[float]] = {}
    for dt in eligible:
        buckets.setdefault(round(dt / .02), []).append(dt)
    best = max(buckets, key=lambda key: sum(len(buckets.get(key + shift, [])) for shift in (-1, 0, 1)))
    cluster = [dt for shift in (-1, 0, 1) for dt in buckets.get(best + shift, [])]
    if len(cluster) / len(intervals) < .65:
        return None
    period = median(cluster)
    indices = [0]
    for dt in intervals:
        indices.append(indices[-1] + max(1, round(dt / period)))
    mean_x, mean_y = sum(indices) / len(indices), sum(peaks) / len(peaks)
    denominator = sum((x - mean_x) ** 2 for x in indices)
    period = sum((x - mean_x) * (y - mean_y) for x, y in zip(indices, peaks)) / denominator
    offset = mean_y - period * mean_x
    if not 70 <= 60 / period <= 180:
        return None
    tolerance = min(.04, period * .09)
    supported = [time for x, time in zip(indices, peaks) if abs(time - (offset + x * period)) <= tolerance]
    quality = len(supported) / len(peaks)
    if quality < .88 or len(supported) / (indices[-1] + 1) < .70:
        return None
    # Reject a local match disguised as a global grid.
    for quarter in range(4):
        lo = peaks[0] + (peaks[-1] - peaks[0]) * quarter / 4
        hi = peaks[0] + (peaks[-1] - peaks[0]) * (quarter + 1) / 4
        local = [time for time in peaks if lo <= time <= hi]
        if not local or sum(lo <= time <= hi for time in supported) / len(local) < .75:
            return None
    return period, max(0., offset), supported, quality


def _tempo_without_phase(energy: list[float], hop: float) -> dict[str, Any]:
    """Bounded autocorrelation fallback; tempo evidence never implies phase.

    Compare up to three disjoint 32-second windows. Clipped positive energy
    differences reduce outlier hits, and correlations at four period multiples
    tolerate subdivisions. Every window must support the same candidate and the
    aggregate must beat alternative tempos. Scores are heuristic, not calibrated
    probabilities. No filename, tags, known-track BPM or preferred 120 BPM prior.
    """
    unavailable: dict[str, Any] = {'candidates': []}
    if len(energy) * hop < 24 or max(energy, default=0.) < .003:
        return unavailable
    rises = [max(0., value - (energy[i - 1] if i else 0.)) for i, value in enumerate(energy)]
    ordered = sorted(rises)
    cap = ordered[int((len(ordered) - 1) * .98)]
    if cap < .0005:
        return unavailable
    count = 3 if len(energy) * hop >= 48 else 2
    window = min(round(32 / hop), len(energy) // count)
    starts = [i * len(energy) // count for i in range(count)]
    bpms = [70 + i / 10 for i in range(1101)]
    all_scores = []
    for start in starts:
        data = [min(value, cap) for value in rises[start:start + window]]
        mean = sum(data) / len(data)
        centered = [value - mean for value in data]
        squared = [0.]
        for value in centered:
            squared.append(squared[-1] + value * value)
        if squared[-1] < .00001:
            return unavailable
        max_lag = math.ceil(60 / 70 / hop * 4) + 1
        correlation = [0.]
        for lag in range(1, max_lag + 1):
            numerator = sum(centered[i] * centered[i + lag] for i in range(len(centered) - lag))
            norm = math.sqrt(squared[-lag - 1] * (squared[-1] - squared[lag]))
            correlation.append(numerator / norm if norm > 1e-12 else 0.)
        scores = []
        for bpm in bpms:
            score = 0.
            for multiple in (1, 2, 3, 4):
                lag = 60 / bpm / hop * multiple
                index = int(lag)
                fraction = lag - index
                score += (correlation[index] * (1 - fraction) + correlation[index + 1] * fraction) / multiple
            scores.append(score / (1 + 1 / 2 + 1 / 3 + 1 / 4))
        all_scores.append(scores)
    aggregate = [median(scores[i] for scores in all_scores) for i in range(len(bpms))]
    selected: list[int] = []
    for index in sorted(range(len(bpms)), key=lambda i: aggregate[i], reverse=True):
        if all(abs(bpms[index] - bpms[other]) > 3 for other in selected):
            selected.append(index)
        if len(selected) == 3:
            break
    candidates = [{'bpm': round(bpms[i], 1), 'periodicity_score': round(max(0., aggregate[i]), 3)} for i in selected]
    best, second = selected[:2]
    support = sum(scores[best] >= max(.1, max(scores) - max(.045, max(scores) * .15)) for scores in all_scores)
    evidence = {'window_count': count, 'supporting_windows': support,
                'window_seconds': round(window * hop, 2), 'method': 'clipped_onset_multilag_autocorrelation',
                'approximate_bpm_resolution': .5, 'phase_verified': False}
    required_margin = max(.035, aggregate[best] * .20)
    if aggregate[best] < .14 or aggregate[best] - aggregate[second] < required_margin or support != count:
        return {'candidates': candidates, 'evidence': evidence}
    confidence = min(.75, .4 + aggregate[best] * .5)
    return {'bpm': round(bpms[best], 1), 'confidence': round(confidence, 3),
            'source': 'studio_onset_autocorrelation', 'status': 'tempo_only',
            'candidates': candidates, 'evidence': evidence}


def _cues(energy: list[float], hop: float, beats: list[float], period: float, confidence: float) -> list[dict]:
    def cue(label: str, time: float, reason: str, score: float) -> dict:
        return {'label': label, 'time_seconds': time, 'confidence': round(score, 3), 'reason': reason,
                'metadata': {'requires_review': True, 'beat_aligned': True, 'phrase_verified': False,
                             'heuristic': 'studio_observed_pulse'}}

    selected = [cue('first_pulse', beats[0], 'First supported transient in the estimated pulse; not a verified downbeat or mix-in.', min(.6, confidence))]
    # Integrated beat energy, rather than adjacent RMS peaks, suppresses individual
    # drum hits. Four-beat comparison windows are smoothing only, NOT inferred bars.
    power_prefix = [0.]
    for value in energy:
        power_prefix.append(power_prefix[-1] + value * value)
    levels = []
    for time in beats:
        start, end = max(0, int(time / hop)), min(len(energy), int((time + period) / hop))
        levels.append((power_prefix[end] - power_prefix[start]) / max(1, end - start))
    candidates = []
    for i in range(4, len(beats) - 4):
        if beats[i + 4] - beats[i - 4] > period * 8.5:
            continue
        before, after = levels[i - 4:i], levels[i:i + 4]
        left, right = sum(before) / 4, sum(after) / 4
        if min(left, right) < 1e-7 or max(left, right) / min(left, right) < 2.5:
            continue
        # Both sides must be sustained, not a single exceptional hit.
        if max(before) / max(min(before), 1e-9) > 2 or max(after) / max(min(after), 1e-9) > 2:
            continue
        candidates.append((abs(math.log(right / left)), i, 'rise' if right > left else 'fall'))
    for _, i, direction in sorted(candidates, reverse=True):
        time = beats[i]
        if any(abs(time - item['time_seconds']) < max(8., 16 * period) for item in selected):
            continue
        selected.append(cue(f'energy_{direction}', time,
                            f'Sustained energy {direction} at an observed pulse; possible section change, phrase and mix suitability unverified.', min(.55, confidence)))
        if len(selected) == 4:
            break
    return sorted(selected, key=lambda item: item['time_seconds'])


def _mix_window_cues(beats: list[float], period: float, duration: float, confidence: float) -> list[dict]:
    """Suggest full, locally supported early/late 32-beat rehearsal windows."""
    count = 32
    span = period * count
    edge_guard = .12
    if duration < span * 2:
        return []
    starts = []
    for index, start in enumerate(beats):
        # Leave onset context at a cut file edge. The observed beat remains
        # available in the grid even when it is too close to be a launch cue.
        if start < edge_guard:
            continue
        end = start + span
        if end > duration - edge_guard:
            break
        right = bisect_left(beats, end - .06)
        if right - index < math.ceil(count * .80):
            continue
        within = beats[index:right]
        if (within[-1] < end - period - .06
                or max((b - a for a, b in zip(within, within[1:])), default=0.) > period * 3.2):
            continue
        starts.append(start)
    early = next((time for time in starts if time <= duration * .30), None)
    late = next((time for time in reversed(starts)
                 if time >= duration - min(duration * .30, span * 2)), None)
    cues = []
    for label, time, description in (
        ('mix_in', early, 'Early starting point'),
        ('mix_out', late, 'Late starting point'),
    ):
        if time is not None:
            cues.append({'label': label, 'time_seconds': time, 'confidence': min(.65, confidence),
                         'reason': f'{description} for a 32-beat audition with measured kick support. Check the musical phrase by ear.',
                         'metadata': {'requires_review': True, 'beat_aligned': True, 'phrase_verified': False,
                                      'window_beats': count, 'heuristic': 'kick_supported_mix_window'}})
    return cues
