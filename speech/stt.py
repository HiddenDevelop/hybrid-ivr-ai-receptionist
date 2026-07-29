"""Spanish-only STT via faster-whisper.

language="es" is hardcoded on purpose (CLAUDE.md "Language requirement"):
this deployment serves a Spanish-speaking caller base and must never
auto-detect or fall back to English. If transcription quality is poor,
fix it HERE — model tier (WHISPER_MODEL), device, or the domain bias
prompt below — not by making language configurable.

Model/device come from env so quality/latency can be tuned per machine:
  WHISPER_MODEL    small | medium | large-v3-turbo ...   (default below)
  WHISPER_DEVICE   cpu | cuda    (cuda only if VRAM is free of the LLM —
                   qwen2.5:14b leaves ~1.8GB on the 4070 Ti, too tight for
                   turbo, so cpu is the default)
  WHISPER_COMPUTE  int8 | int8_float16 | float16 ...
"""

import ctypes
import glob
import io
import os
import time

from faster_whisper import WhisperModel


def _preload_cuda12_libs():
    """CTranslate2 dlopens libcublas.so.12 / libcudnn.so.9; the venv ships
    them as pip wheels (nvidia-cublas-cu12, nvidia-cudnn-cu12) outside the
    default linker path. Loading them RTLD_GLOBAL here makes the later
    dlopen a no-op, with no LD_LIBRARY_PATH gymnastics in launch scripts."""
    import nvidia  # noqa: F401 -- namespace package from the wheels

    for pkg in ("cublas", "cudnn"):
        for root in nvidia.__path__:
            for lib in sorted(glob.glob(os.path.join(root, pkg, "lib", "lib*.so.*"))):
                try:
                    ctypes.CDLL(lib, mode=ctypes.RTLD_GLOBAL)
                except OSError:
                    pass

WHISPER_LANGUAGE = "es"

# Per-device defaults, benchmarked on this machine (scripts/stt-benchmark.py):
#   cuda + large-v3-turbo int8_float16: ~190ms/turn, best es accuracy,
#     ~1.1GB VRAM next to qwen2.5:14b (11.6/12.3GB total — monitored, fits)
#   cpu + small int8: ~850ms/turn — the fallback; medium/turbo on CPU run
#     2.3-3.3s and bust the per-turn budget, never default to them on cpu
DEFAULT_MODEL_CUDA = "large-v3-turbo"
DEFAULT_MODEL_CPU = "small"
FALLBACK_MODEL = "small"

# Domain bias: nudges decoding toward the vocabulary this line actually
# hears (Puerto Rico, clinic intake). Big accuracy win on names of plans,
# dates, and clinical words at the cost of a few prompt tokens.
#
# The example names are load-bearing, not decoration: an utterance-initial
# name loses to a common filler of the same sound otherwise ("José Pérez"
# transcribed as "O sea, Pérez" on a real call). A spread of common Puerto
# Rico first names and surnames pulls the decoder toward name readings
# without fixating on any single one.
INITIAL_PROMPT = (
    "Llamada en español a una clínica de cirugía en Puerto Rico. "
    "El paciente da su nombre, como José Rivera, María Pérez, Carmen Rodríguez, "
    "Luis Torres, Ana Díaz o Juan Colón, su fecha de nacimiento, teléfono, "
    "plan médico como Triple-S, MCS o First Medical, y sus síntomas."
)


class SpanishTranscriber:
    def __init__(self, model_size: str | None = None):
        device = os.environ.get("WHISPER_DEVICE", "cuda")
        default_model = DEFAULT_MODEL_CUDA if device != "cpu" else DEFAULT_MODEL_CPU
        model = model_size or os.environ.get("WHISPER_MODEL", default_model)
        compute = os.environ.get(
            "WHISPER_COMPUTE", "int8" if device == "cpu" else "int8_float16"
        )
        if device != "cpu":
            _preload_cuda12_libs()
        try:
            self._model = WhisperModel(model, device=device, compute_type=compute)
            self._warmup()  # CUDA errors surface lazily at first encode
        except Exception as exc:
            if device == "cpu":
                raise
            # CUDA init/OOM: degrade to CPU rather than dying — STT slow
            # beats STT absent on a live phone line. Fall back to the CPU
            # model tier, not this one: the big models blow the latency
            # budget on CPU.
            print(f"whisper on {device} failed ({exc}); falling back to cpu {FALLBACK_MODEL} int8")
            model = FALLBACK_MODEL
            self._model = WhisperModel(model, device="cpu", compute_type="int8")
            self._warmup()
        self.model_name = model

    # Force the model through a real encode/decode so load + kernel-init
    # cost is paid at startup, not on the first caller's first answer.
    def _warmup(self):
        import wave

        buf = io.BytesIO()
        with wave.open(buf, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(8000)
            w.writeframes(b"\x00\x00" * 4000)  # 0.5s of silence
        buf.seek(0)
        segments, _ = self._model.transcribe(buf, language=WHISPER_LANGUAGE, beam_size=1)
        list(segments)

    def transcribe(self, wav_bytes: bytes) -> dict:
        started = time.monotonic()
        segments, info = self._model.transcribe(
            io.BytesIO(wav_bytes),
            language=WHISPER_LANGUAGE,
            # beam search earns its keep on exactly what this line collects —
            # names and digit strings; greedy (beam_size=1) picked the filler
            # reading of names ("o sea" over "José"). Latency cost measured
            # by scripts/stt-benchmark.py before committing to 5.
            beam_size=5,
            vad_filter=False,  # turn detection already happened upstream in Node
            initial_prompt=INITIAL_PROMPT,
        )
        text = " ".join(segment.text.strip() for segment in segments).strip()
        return {
            "text": text,
            "language": WHISPER_LANGUAGE,
            "audio_duration_ms": int(info.duration * 1000),
            "stt_ms": int((time.monotonic() - started) * 1000),
        }
