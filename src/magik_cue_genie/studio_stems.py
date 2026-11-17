"""Local Demucs bridge. Takes decoded deck PCM and returns four aligned stereo layers."""

import argparse
from hashlib import sha256
import json
from pathlib import Path
import struct
import wave


RATE = 44_100
STEMS = ('vocals', 'drums', 'bass', 'other')
WEIGHT_NAME = '955717e8-8726e21a.th'
WEIGHT_SHA256 = '8726e21a993978c7ba086d3872e7608d7d5bfca646ca4aca459ffda844faa8b4'


def _source_audio(path, np):
    try:
        with wave.open(str(path), 'rb') as audio:
            frames = audio.getnframes()
            if (audio.getnchannels(), audio.getsampwidth(), audio.getframerate()) != (2, 2, RATE):
                raise ValueError('Stem separation needs stereo 44.1 kHz PCM from the loaded deck.')
            if not 2 * RATE <= frames <= 6 * 60 * RATE:
                raise ValueError('Choose a track between 2 seconds and 6 minutes for this stem preview.')
            samples = np.frombuffer(audio.readframes(frames), dtype='<i2')
            if samples.size != 2 * frames:
                raise ValueError('The stem input is incomplete.')
    except (wave.Error, EOFError) as error:
        raise ValueError('Studio could not read the stem input.') from error
    return np.ascontiguousarray(samples.reshape(-1, 2).T, dtype=np.float32) / 32768


def alignment_metrics(original, reconstructed, np):
    """Measure reconstruction lag on an energetic slice of each third."""
    if original.shape != reconstructed.shape or not np.isfinite(reconstructed).all():
        raise ValueError('The stem audio does not match the deck timeline.')
    numerator = float(np.einsum('ij,ij->', original, original, dtype=np.float64))
    estimated_energy = float(np.einsum('ij,ij->', reconstructed, reconstructed, dtype=np.float64))
    overlap = float(np.einsum('ij,ij->', original, reconstructed, dtype=np.float64))
    residual = numerator + estimated_energy - 2 * overlap
    snr = 10 * np.log10(max(numerator, 1e-12) / max(residual, 1e-12))
    frames = original.shape[1]
    block = 4096
    radius = 256
    lags = []
    for third in range(3):
        start = max(radius, frames * third // 3)
        end = min(frames - radius, frames * (third + 1) // 3)
        windows = original[:, start:start + (end - start) // block * block].reshape(2, -1, block)
        energies = np.einsum('ijk,ijk->ij', windows, windows)
        channel, index = np.unravel_index(energies.argmax(), energies.shape)
        if energies[channel, index] <= 1e-4:
            continue
        offset = start + index * block
        reference = original[channel, offset:offset + block]
        around = reconstructed[channel, offset - radius:offset + block + radius]
        correlation = np.correlate(around, reference, mode='valid')
        lags.append(int(np.argmax(correlation)) - radius)
    return snr, lags


def _local_separator(weights, device):
    path = weights / WEIGHT_NAME
    try:
        with path.open('rb') as stream:
            digest = sha256()
            for data in iter(lambda: stream.read(1024 * 1024), b''):
                digest.update(data)
    except OSError as error:
        raise ValueError('Install the verified local htdemucs checkpoint before preparing stems.') from error
    if digest.hexdigest() != WEIGHT_SHA256:
        raise ValueError('The local htdemucs checkpoint does not match its expected checksum.')
    try:
        import numpy as np
        import torch
        from demucs.apply import apply_model
        from demucs.pretrained import get_model
    except (ImportError, OSError) as error:
        raise ValueError('Install the optional Demucs and PyTorch runtime for local stem separation.') from error
    if device == 'cuda' and not torch.cuda.is_available():
        raise ValueError('This local PyTorch runtime cannot use CUDA. Select CPU for stem separation.')
    torch.set_num_threads(min(4, torch.get_num_threads()))
    model = get_model('955717e8', repo=weights)
    if model.samplerate != RATE or set(model.sources) != set(STEMS):
        raise ValueError('Studio requires the four-layer 44.1 kHz htdemucs model.')

    def separate(source):
        audio = torch.from_numpy(source)
        reference = audio.mean(0)
        mean = reference.mean()
        deviation = reference.std()
        if deviation < 1e-6:
            # A nearly cancelled stereo mean still has usable data in each channel.
            deviation = audio.std()
        if deviation < 1e-6:
            raise ValueError('This track has too little audio to separate.')
        with torch.inference_mode():
            estimated = apply_model(model, ((audio - mean) / deviation)[None], device=device,
                                    shifts=0, split=True, overlap=.25, progress=False)[0]
            estimated.mul_(float(deviation)).add_(float(mean) / len(STEMS))
            estimates = estimated.to('cpu').numpy()
        return tuple(estimates[model.sources.index(name)] for name in STEMS)

    return np, separate


def write_stem_pack(source, estimates, output, np):
    frames = source.shape[1]
    if len(estimates) != len(STEMS):
        raise ValueError('The stem audio does not match the deck timeline.')
    rebuilt = np.zeros_like(source)
    for estimate in estimates:
        if estimate.shape != (2, frames) or not np.isfinite(estimate).all():
            raise ValueError('The stem audio does not match the deck timeline.')
        np.add(rebuilt, estimate, out=rebuilt)
    snr, lags = alignment_metrics(source, rebuilt, np)
    if not lags or max(abs(lag) for lag in lags) > 2 or snr < 12:
        raise ValueError('The separated audio failed the alignment check. The deck will keep using the full mix.')
    with output.open('xb') as stream:
        stream.write(struct.pack('<4sII', b'MGS1', RATE, frames))
        for estimate in estimates:
            np.ascontiguousarray(estimate, dtype='<f4').tofile(stream)
    return {'frames': frames, 'snr_db': round(float(snr), 2), 'offset_samples': lags}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--weights', type=Path, required=True)
    parser.add_argument('--device', choices=('cpu', 'cuda'), default='cpu')
    args = parser.parse_args()
    try:
        np, separate = _local_separator(args.weights, args.device)
        source = _source_audio(args.input, np)
        result = write_stem_pack(source, separate(source), args.output, np)
    except ValueError as error:
        print(json.dumps({'error': str(error)}))
        return 2
    print(json.dumps(result))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
