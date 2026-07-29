"""Benchmark Whisper model tiers on THIS machine with realistic call audio:
Piper-synthesized Puerto Rico intake sentences at 8 kHz, transcribed by each
candidate model on CPU. Prints latency + transcript so quality regressions
are visible next to the timing.

Run:  .venv/bin/python scripts/stt-benchmark.py
"""

import io
import sys
import time
import wave
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "speech"))

from faster_whisper import WhisperModel  # noqa: E402
from tts import PiperSynthesizer  # noqa: E402
from stt import INITIAL_PROMPT, WHISPER_LANGUAGE  # noqa: E402

VOICE = "es_ES-davefx-medium"  # any downloaded voice works for benchmarking
MODELS = ["small", "medium", "large-v3-turbo"]

SENTENCES = [
    "Mi nombre es Carlos Manuel Rivera Santiago.",
    "Nací el catorce de febrero del mil novecientos setenta y dos.",
    "Tengo Triple Ese Advantage, no tengo el número a mano.",
    "Me operaron el veinte de julio y estoy botando sangre por la herida.",
    "Quisiera la cita para la próxima semana, si es posible el martes.",
]


def synth_all():
    synth = PiperSynthesizer(VOICE)
    return [(s, synth.synthesize(s, sample_rate=8000)) for s in SENTENCES]


def main():
    samples = synth_all()
    for model_name in MODELS:
        print(f"\n=== {model_name} (cpu int8) ===")
        t0 = time.monotonic()
        model = WhisperModel(model_name, device="cpu", compute_type="int8")
        print(f"  load: {time.monotonic() - t0:.1f}s")
        latencies = []
        for expected, wav in samples:
            t1 = time.monotonic()
            segments, info = model.transcribe(
                io.BytesIO(wav), language=WHISPER_LANGUAGE, beam_size=1,
                vad_filter=False, initial_prompt=INITIAL_PROMPT,
            )
            text = " ".join(s.text.strip() for s in segments).strip()
            ms = int((time.monotonic() - t1) * 1000)
            latencies.append(ms)
            with wave.open(io.BytesIO(wav)) as w:
                dur = w.getnframes() / w.getframerate()
            print(f"  {ms:5d}ms ({dur:.1f}s audio)  \"{text}\"")
        latencies.sort()
        print(f"  p50={latencies[len(latencies) // 2]}ms max={latencies[-1]}ms")


if __name__ == "__main__":
    main()
