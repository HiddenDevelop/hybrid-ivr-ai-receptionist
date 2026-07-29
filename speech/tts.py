"""Spanish TTS behind a TTS_ENGINE switch. Piper today; MeloTTS is the
planned second engine (deps are installed, package is not — add a
MeloSynthesizer here when it lands, same synthesize() contract).

Output contract: mono 16-bit PCM WAV at the requested sample rate
(default 8000 Hz, ready for the mulaw telephony path in Node).
"""

import io
import os
import wave
from pathlib import Path

import numpy as np
from scipy.signal import resample_poly

VOICES_DIR = Path(__file__).parent / "voices"

# Piper's length_scale stretches every phoneme: 1.0 is the voice's native
# pace, higher is slower. The clinic's callers are mostly elderly, and the
# native pace of the high-quality voices is a news-anchor clip that is hard
# to follow over a phone line — especially for digits and dates, which is
# exactly the content callers have to catch. 1.25 is a deliberate default,
# not a placeholder; retune it by ear with scripts/make-voice-samples.py.
# (Started at 1.15; raised to 1.25 after feedback that callers needed a
# slower delivery. Past ~1.4 the stretched phonemes start to drag rather
# than clarify.)
#
# Changing this invalidates the cached prompts: tts/cache.js synthesizes
# them at startup, so restart the Node server after touching it.
DEFAULT_LENGTH_SCALE = 1.25
MIN_LENGTH_SCALE = 0.5
MAX_LENGTH_SCALE = 2.5


def length_scale_from_env() -> float:
    raw = os.environ.get("TTS_LENGTH_SCALE", "").strip()
    if not raw:
        return DEFAULT_LENGTH_SCALE
    try:
        value = float(raw)
    except ValueError:
        raise ValueError(
            f"TTS_LENGTH_SCALE={raw!r} is not a number (1.0 = native pace, "
            f"higher = slower)"
        )
    if not MIN_LENGTH_SCALE <= value <= MAX_LENGTH_SCALE:
        raise ValueError(
            f"TTS_LENGTH_SCALE={value} is outside "
            f"{MIN_LENGTH_SCALE}-{MAX_LENGTH_SCALE}; anything beyond that is "
            f"unintelligible, not just slow"
        )
    return value


class PiperSynthesizer:
    def __init__(self, voice_name: str, length_scale: float | None = None):
        from piper.voice import PiperVoice

        model_path = VOICES_DIR / f"{voice_name}.onnx"
        if not model_path.exists():
            raise FileNotFoundError(
                f"Piper voice model not found: {model_path}. "
                f"Run scripts/make-voice-samples.py to download voices, "
                f"then set PIPER_VOICE."
            )
        self.voice_name = voice_name
        self.length_scale = (
            length_scale_from_env() if length_scale is None else length_scale
        )
        self._voice = PiperVoice.load(model_path)

    def synthesize(self, text: str, sample_rate: int = 8000) -> bytes:
        from piper import SynthesisConfig

        native_buf = io.BytesIO()
        with wave.open(native_buf, "wb") as wav_out:
            self._voice.synthesize_wav(
                text,
                wav_out,
                syn_config=SynthesisConfig(length_scale=self.length_scale),
            )

        native_buf.seek(0)
        with wave.open(native_buf, "rb") as wav_in:
            native_rate = wav_in.getframerate()
            pcm = np.frombuffer(
                wav_in.readframes(wav_in.getnframes()), dtype=np.int16
            )

        if native_rate != sample_rate:
            resampled = resample_poly(pcm.astype(np.float64), sample_rate, native_rate)
            pcm = np.clip(resampled, -32768, 32767).astype(np.int16)

        out_buf = io.BytesIO()
        with wave.open(out_buf, "wb") as wav_out:
            wav_out.setnchannels(1)
            wav_out.setsampwidth(2)
            wav_out.setframerate(sample_rate)
            wav_out.writeframes(pcm.tobytes())
        return out_buf.getvalue()


def load_synthesizer():
    """Returns a synthesizer, or None if no voice is configured yet.

    PIPER_VOICE stays unset until the voice audition (speech/samples/) has
    been listened to and a voice picked — the sidecar still starts so STT
    work isn't blocked, and /tts reports 503 until then.

    Speaking pace comes from TTS_LENGTH_SCALE (see DEFAULT_LENGTH_SCALE).
    """
    engine = os.environ.get("TTS_ENGINE", "piper").lower()
    if engine != "piper":
        raise ValueError(
            f"TTS_ENGINE={engine!r} is not implemented yet; only 'piper' is."
        )
    voice_name = os.environ.get("PIPER_VOICE", "").strip()
    if not voice_name:
        return None
    return PiperSynthesizer(voice_name)
