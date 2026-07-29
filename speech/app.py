"""Speech sidecar: STT + TTS over loopback HTTP for the Node orchestrator.

Binds 127.0.0.1 ONLY (see __main__ block) — this service handles raw call
audio and transcripts and must never be internet-reachable. Twilio traffic
terminates in the Node process; nothing here talks to the outside world.

Endpoints:
  GET  /healthz          -> {"status": "ok", "stt": bool, "tts": voice|null}
  POST /stt   (WAV body) -> {"text", "language", "audio_duration_ms", "stt_ms"}
  POST /tts   (JSON)     -> WAV bytes; {"text": str, "sample_rate": int=8000}
"""

import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request, Response
from pydantic import BaseModel, Field

from stt import SpanishTranscriber
from tts import load_synthesizer

state = {"transcriber": None, "synthesizer": None}


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Load models up front so the first call doesn't eat the load time.
    state["transcriber"] = SpanishTranscriber()
    state["synthesizer"] = load_synthesizer()
    yield


app = FastAPI(lifespan=lifespan)


class TtsRequest(BaseModel):
    text: str = Field(min_length=1)
    sample_rate: int = 8000


@app.get("/healthz")
def healthz():
    synth = state["synthesizer"]
    return {
        "status": "ok",
        "stt": state["transcriber"] is not None,
        "tts": synth.voice_name if synth else None,
        # Speaking pace actually in effect (1.0 = the voice's native rate,
        # higher = slower). Reported so the Node side can log what callers
        # will hear instead of what .env claims.
        "tts_length_scale": synth.length_scale if synth else None,
    }


@app.post("/stt")
async def stt(request: Request):
    wav_bytes = await request.body()
    if not wav_bytes:
        raise HTTPException(status_code=400, detail="empty audio body")
    try:
        return state["transcriber"].transcribe(wav_bytes)
    except Exception as exc:  # malformed WAV, decoder failure, etc.
        raise HTTPException(status_code=422, detail=f"transcription failed: {exc}")


@app.post("/tts")
def tts(req: TtsRequest):
    synth = state["synthesizer"]
    if synth is None:
        raise HTTPException(
            status_code=503,
            detail="no TTS voice configured — pick one from speech/samples/ "
            "and set PIPER_VOICE (see .env.example)",
        )
    wav = synth.synthesize(req.text, sample_rate=req.sample_rate)
    return Response(content=wav, media_type="audio/wav")


if __name__ == "__main__":
    import uvicorn

    # 127.0.0.1 is non-negotiable, not an env default someone can widen.
    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("SPEECH_PORT", "8081")))
