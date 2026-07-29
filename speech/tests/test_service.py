"""Sidecar tests. STT tests use a synthetic WAV (tone/silence) — they check
plumbing and error handling, not transcription quality; real Spanish-audio
checks happen in the live-call test pass. TTS tests are skipped unless a
voice model is present (they need speech/voices/ populated)."""

import io
import math
import os
import struct
import sys
import wave
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import app as app_module  # noqa: E402


@pytest.fixture(scope="session")
def client():
    with TestClient(app_module.app) as test_client:
        yield test_client


def make_wav(seconds=0.5, rate=8000, freq=220.0, amplitude=0.0):
    frames = b"".join(
        struct.pack(
            "<h",
            int(amplitude * 32767 * math.sin(2 * math.pi * freq * i / rate)),
        )
        for i in range(int(seconds * rate))
    )
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(frames)
    return buf.getvalue()


def test_healthz(client):
    body = client.get("/healthz").json()
    assert body["status"] == "ok"
    assert body["stt"] is True


def test_stt_accepts_wav_and_reports_timing(client):
    resp = client.post("/stt", content=make_wav())
    assert resp.status_code == 200
    body = resp.json()
    assert body["language"] == "es"
    assert isinstance(body["text"], str)
    assert 400 <= body["audio_duration_ms"] <= 600
    assert body["stt_ms"] >= 0


def test_stt_rejects_empty_body(client):
    assert client.post("/stt", content=b"").status_code == 400


def test_stt_rejects_garbage(client):
    assert client.post("/stt", content=b"this is not audio").status_code == 422


def has_any_voice():
    voices_dir = Path(__file__).resolve().parent.parent / "voices"
    return any(voices_dir.glob("*.onnx"))


@pytest.mark.skipif(not has_any_voice(), reason="no Piper voice downloaded yet")
def test_tts_returns_8k_mono_wav(client):
    if not os.environ.get("PIPER_VOICE"):
        pytest.skip("PIPER_VOICE not set")
    resp = client.post("/tts", json={"text": "Gracias por llamar."})
    assert resp.status_code == 200
    with wave.open(io.BytesIO(resp.content), "rb") as w:
        assert w.getframerate() == 8000
        assert w.getnchannels() == 1
        assert w.getsampwidth() == 2
        assert w.getnframes() > 0


def test_tts_503_when_no_voice_configured(client):
    if app_module.state["synthesizer"] is not None:
        pytest.skip("a voice is configured in this environment")
    assert client.post("/tts", json={"text": "hola"}).status_code == 503


def wav_duration_ms(wav_bytes):
    with wave.open(io.BytesIO(wav_bytes), "rb") as w:
        return 1000 * w.getnframes() / w.getframerate()


def any_voice_name():
    voices_dir = Path(__file__).resolve().parent.parent / "voices"
    names = sorted(p.stem for p in voices_dir.glob("*.onnx"))
    return os.environ.get("PIPER_VOICE") or (names[0] if names else None)


@pytest.mark.skipif(not has_any_voice(), reason="no Piper voice downloaded yet")
def test_length_scale_actually_slows_the_voice():
    """The clinic's callers are mostly elderly — prompts are deliberately
    slower than the voice's native pace, and that has to be a real audio
    change, not just a config value nobody reads."""
    from tts import DEFAULT_LENGTH_SCALE, PiperSynthesizer

    text = "Entendí que su teléfono es 7 8 7, 4 9 0, 2 0 8 1."
    native = PiperSynthesizer(any_voice_name(), length_scale=1.0).synthesize(text)
    slowed = PiperSynthesizer(any_voice_name(), length_scale=1.5).synthesize(text)

    assert wav_duration_ms(slowed) > wav_duration_ms(native) * 1.25
    assert DEFAULT_LENGTH_SCALE > 1.0, "the default must be slower than native"


def test_length_scale_from_env(monkeypatch):
    from tts import DEFAULT_LENGTH_SCALE, length_scale_from_env

    monkeypatch.delenv("TTS_LENGTH_SCALE", raising=False)
    assert length_scale_from_env() == DEFAULT_LENGTH_SCALE

    monkeypatch.setenv("TTS_LENGTH_SCALE", "1.3")
    assert length_scale_from_env() == 1.3

    # A typo must fail loudly at startup, not silently hand callers a voice
    # at the wrong speed (or an unintelligible one).
    for bad in ("fast", "0.1", "9"):
        monkeypatch.setenv("TTS_LENGTH_SCALE", bad)
        with pytest.raises(ValueError):
            length_scale_from_env()
