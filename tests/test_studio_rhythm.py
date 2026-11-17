import hashlib
import math
import struct
import wave

import pytest

from magik_cue_genie.studio_rhythm import analyze_studio_rhythm


def audio(tmp_path, times, duration=32, shift=None, alternate=False):
    path = tmp_path / 'synthetic.wav'
    rate = 8000
    samples = [0] * int(duration * rate)
    for beat_index, time in enumerate(times):
        level = 0.7 if shift is None or time >= shift else 0.16
        if alternate and beat_index % 2:
            level *= .45
        for i in range(240):
            index = int(time * rate) + i
            if index < len(samples):
                samples[index] = int(30000 * level * math.exp(-i / 75) * math.sin(i * 0.7))
    with wave.open(str(path), 'wb') as wav:
        wav.setparams((1, 2, rate, 0, 'NONE', 'not compressed'))
        wav.writeframes(struct.pack('<' + 'h' * len(samples), *samples))
    return path


@pytest.mark.parametrize('bpm,offset', [(97, .237), (128, .173), (143, .321)])
def test_non_default_tempo_and_phase_from_audio(tmp_path, bpm, offset):
    times = [offset + n * 60 / bpm for n in range(int((32 - offset) * bpm / 60))]
    path = audio(tmp_path, times)
    original = hashlib.sha256(path.read_bytes()).hexdigest()
    result = analyze_studio_rhythm(path)
    assert result['tempo']['bpm'] == pytest.approx(bpm, abs=.15)
    assert result['grid']['status'] == 'estimated'
    assert result['grid']['offset_seconds'] == pytest.approx(offset, abs=.02)
    assert result['grid']['beat_times_seconds'][-1] == pytest.approx(times[-1], abs=.025)
    assert result['grid']['meter'] is None
    assert not result['grid']['downbeat_verified']
    assert len(result['cues']) <= 1  # No periodic cue factory on unchanged audio.
    assert original == hashlib.sha256(path.read_bytes()).hexdigest()


def test_cue_stage_failure_preserves_observed_rhythm(tmp_path, monkeypatch):
    import magik_cue_genie.studio_rhythm as rhythm

    def fail(*args):
        raise RuntimeError("cue planner failed")

    path = audio(tmp_path, [.23 + n * .5 for n in range(60)])
    monkeypatch.setattr(rhythm, "_cues", fail)
    result = analyze_studio_rhythm(path)
    assert result["tempo"]["bpm"] == pytest.approx(120., abs=.15)
    assert result["grid"]["status"] == "estimated"
    assert len(result["grid"]["beat_times_seconds"]) > 50
    assert result["cue_status"] == "error"
    assert result["cues"] == []


@pytest.mark.parametrize('times', [[], [.3, 1.17, 1.49, 3.2, 4.31, 4.57, 7.9, 9.4], [.2]])
def test_silence_and_ambiguous_rhythm_abstain(tmp_path, times):
    result = analyze_studio_rhythm(audio(tmp_path, times))
    assert result['tempo']['bpm'] is None
    assert result['grid']['beat_times_seconds'] == []
    assert result['cues'] == []


def test_sustained_energy_transition_is_review_candidate_on_observed_beat(tmp_path):
    times = [.23 + n * 60 / 128 for n in range(67)]
    boundary = times[32]
    result = analyze_studio_rhythm(audio(tmp_path, times, shift=boundary))
    shifts = [cue for cue in result['cues'] if cue['label'] == 'energy_rise']
    assert len(shifts) == 1
    assert shifts[0]['time_seconds'] == pytest.approx(boundary, abs=.025)
    assert shifts[0]['metadata']['requires_review']
    assert not shifts[0]['metadata']['phrase_verified']


def test_changing_tempo_does_not_invent_fixed_grid(tmp_path):
    times = [.2 + n * .5 for n in range(30)] + [15.5 + n * .6 for n in range(27)]
    result = analyze_studio_rhythm(audio(tmp_path, times))
    assert result['grid']['status'] == 'unavailable'
    assert result['tempo']['bpm'] is None


def test_constant_tone_does_not_create_beats(tmp_path):
    path = tmp_path / 'tone.wav'
    rate = 8000
    with wave.open(str(path), 'wb') as wav:
        wav.setparams((1, 2, rate, 0, 'NONE', 'not compressed'))
        wav.writeframes(struct.pack('<' + 'h' * (rate * 12),
                                   *(int(12000 * math.sin(2 * math.pi * 220 * i / rate)) for i in range(rate * 12))))
    result = analyze_studio_rhythm(path)
    assert result['tempo']['bpm'] is None
    assert result['cues'] == []


def test_opposite_stereo_phase_keeps_rhythm(tmp_path):
    path = audio(tmp_path, [.23 + n * 60 / 128 for n in range(65)])
    with wave.open(str(path), 'rb') as wav:
        raw = wav.readframes(wav.getnframes())
    samples = struct.unpack('<' + 'h' * (len(raw) // 2), raw)
    stereo_path = tmp_path / 'stereo.wav'
    with wave.open(str(stereo_path), 'wb') as wav:
        wav.setparams((2, 2, 8000, 0, 'NONE', 'not compressed'))
        wav.writeframes(b''.join(struct.pack('<hh', sample, -sample) for sample in samples))
    result = analyze_studio_rhythm(stereo_path)
    assert result['tempo']['bpm'] == pytest.approx(128, abs=.15)


def test_long_non_integer_tempo_fit_does_not_accumulate_drift(tmp_path):
    bpm, offset, duration = 127.3, .287, 181
    times = [offset + n * 60 / bpm for n in range(int((duration - offset) * bpm / 60))]
    result = analyze_studio_rhythm(audio(tmp_path, times, duration=duration))
    assert result['tempo']['bpm'] == pytest.approx(bpm, abs=.02)
    assert result['grid']['beat_times_seconds'][-1] == pytest.approx(times[-1], abs=.02)
    assert len(result['cues']) == 1


def test_subdivision_pulse_can_estimate_tempo_without_claiming_phase(tmp_path):
    times = [.23 + n * 60 / 256 for n in range(132)]
    result = analyze_studio_rhythm(audio(tmp_path, times, alternate=True))
    assert result['tempo']['bpm'] == pytest.approx(128, abs=1)
    assert result['tempo']['status'] == 'tempo_only'
    assert result['tempo']['candidates']
    assert result['grid']['status'] == 'unavailable'
    assert result['grid']['beat_times_seconds'] == []
    assert result['cues'] == []


def test_phase_failure_can_still_return_tempo_without_an_observed_grid(tmp_path, monkeypatch):
    import magik_cue_genie.studio_rhythm as rhythm

    def fail(_peaks):
        raise RuntimeError("phase fitter failed")

    path = audio(tmp_path, [.23 + n * 60 / 256 for n in range(132)], alternate=True)
    monkeypatch.setattr(rhythm, "_fit_pulse", fail)
    result = analyze_studio_rhythm(path)
    assert result['tempo']['status'] == 'tempo_only'
    assert result['tempo']['bpm'] == pytest.approx(128, abs=1)
    assert result['grid']['status'] == 'error'
    assert result['grid']['beat_times_seconds'] == []
    assert result['cues'] == []


def test_irregular_dense_transients_do_not_get_confident_fallback(tmp_path):
    import random
    rng = random.Random(37)
    times = []
    time = .23
    while time < 31:
        times.append(time)
        time += rng.uniform(.19, .73)
    result = analyze_studio_rhythm(audio(tmp_path, times))
    assert result['tempo']['bpm'] is None
    assert result['grid']['status'] == 'unavailable'


def test_equal_subdivisions_preserve_competing_tempo_ambiguity(tmp_path):
    times = [.23 + n * 60 / 256 for n in range(132)]
    result = analyze_studio_rhythm(audio(tmp_path, times))
    assert result['tempo']['bpm'] is None
    assert len(result['tempo']['candidates']) > 1
    assert result['cues'] == []


def kick_with_percussion(tmp_path, times, duration):
    path = tmp_path / 'kick-and-percussion.wav'
    rate = 8000
    samples = [0.] * round(duration * rate)
    for start in times:
        for index in range(round(rate * .12)):
            time = index / rate
            phase = math.tau * (54 * time + .55 * (1 - math.exp(-time / .018)))
            position = round(start * rate) + index
            if position < len(samples):
                samples[position] += .65 * math.exp(-time / .037) * math.sin(phase)
        for delay in (.123, .272):
            for index in range(round(rate * .04)):
                time = index / rate
                position = round((start + delay) * rate) + index
                if position < len(samples):
                    samples[position] += .78 * math.exp(-time / .016) * math.sin(math.tau * 1450 * time)
    with wave.open(str(path), 'wb') as wav:
        wav.setparams((1, 2, rate, 0, 'NONE', 'not compressed'))
        wav.writeframes(struct.pack(f'<{len(samples)}h', *(round(value * 32767) for value in samples)))
    return path


def test_kick_grid_uses_observed_beats_and_proposes_two_rehearsal_points(tmp_path):
    duration, first, period = 52, .062, 60 / 127
    times = [first + i * period for i in range(int((duration - first) / period))]
    result = analyze_studio_rhythm(kick_with_percussion(tmp_path, times, duration))
    grid = result['grid']
    assert grid['evidence']['method'] == 'kick_band_phase_fit'
    assert result['tempo']['bpm'] == pytest.approx(127, abs=.1)
    assert grid['beat_times_seconds'][0] == pytest.approx(first, abs=.03)
    assert grid['beat_times_seconds'][-1] == pytest.approx(times[-1], abs=.03)
    cues = {cue['label']: cue for cue in result['cues']}
    assert cues['mix_in']['time_seconds'] == pytest.approx(times[1], abs=.03)
    assert 32 * period <= duration - cues['mix_out']['time_seconds'] < 34 * period
    for label in ('mix_in', 'mix_out'):
        cue = cues[label]
        assert cue['time_seconds'] in grid['beat_times_seconds']
        assert cue['metadata']['window_beats'] == 32
        assert cue['metadata']['requires_review']
        assert not cue['metadata']['phrase_verified']


@pytest.mark.parametrize('broadband_hint', [None, 127.7])
def test_kicks_can_recover_a_grid_without_a_matching_full_mix_tempo(tmp_path, monkeypatch, broadband_hint):
    import magik_cue_genie.studio_rhythm as rhythm

    bpm, duration, first = 113, 18, .23
    times = [first + i * 60 / bpm for i in range(int((duration - first) * bpm / 60))]
    removed = times.pop(12)
    if broadband_hint:
        monkeypatch.setattr(rhythm, '_tempo_without_phase', lambda *_: {
            'bpm': broadband_hint, 'confidence': .66, 'status': 'tempo_only', 'candidates': [],
        })
    path = kick_with_percussion(tmp_path, times, duration)
    result = analyze_studio_rhythm(path)
    grid = result['grid']
    assert result['tempo']['bpm'] == pytest.approx(bpm, abs=.10)
    assert grid['status'] == 'estimated'
    assert grid['evidence']['tempo_seed'] == 'kick_intervals'
    assert len(grid['beat_times_seconds']) >= len(times) - 1
    assert all(min(abs(beat - observed) for observed in times) <= .025 for beat in grid['beat_times_seconds'])
    assert all(abs(beat - removed) > .1 for beat in grid['beat_times_seconds'])


def test_kick_phase_drift_is_not_a_fixed_grid(tmp_path):
    duration = 50
    times = [.237 + i * .5 for i in range(49)] + [25.11 + i * .5 for i in range(49)]
    result = analyze_studio_rhythm(kick_with_percussion(tmp_path, times, duration))
    assert result['grid']['status'] == 'unavailable'
    assert result['grid']['beat_times_seconds'] == []
    assert not result['cues']


def test_kick_phase_can_ignore_strong_offbeat_attacks():
    from magik_cue_genie.studio_kick import fit_kick_pulse

    period = 60 / 128
    attacks = [.127 + index * period for index in range(170)]
    events = [(time, 1.) for time in attacks]
    events.extend((time + .122, 2.5) for time in attacks[::2])
    fit = fit_kick_pulse(sorted(events), [128.], 80., .005)
    assert fit is not None
    assert fit.beats == pytest.approx(attacks)
    assert 60 / fit.period == pytest.approx(128., abs=.01)


def test_kick_phase_survives_a_sparse_break_without_filling_missing_attacks():
    from magik_cue_genie.studio_kick import fit_kick_pulse

    attacks = [.127 + index * .5 for index in range(160)]
    observed = [time for index, time in enumerate(attacks)
                if not 80 <= index < 120 or index % 5 < 2]
    fit = fit_kick_pulse([(time, 1.) for time in observed], [120.], 80., .005)
    assert fit is not None
    assert fit.beats == pytest.approx(observed)
    assert fit.quarter_support == pytest.approx([1., 1., .4, 1.])
