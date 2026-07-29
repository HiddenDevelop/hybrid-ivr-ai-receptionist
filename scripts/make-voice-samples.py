"""Voice audition: download candidate Piper Spanish voices and render the
real greeting + re-prompt copy with each, so a human can pick PIPER_VOICE
BEFORE tts/cache.js caches anything (re-caching = re-testing the call flow).

Each voice produces two files in speech/samples/:
  <voice>.wav      native rate — how good the voice can sound
  <voice>.8k.wav   8 kHz — what callers will actually hear over the phone

Rendered at the TTS_LENGTH_SCALE pace in effect (1.0 = the voice's native
rate, higher = slower), so the audition matches what callers hear. Re-run
this after changing the pace to re-judge it by ear.

Run:  .venv/bin/python scripts/make-voice-samples.py
"""

import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "speech"))

from piper.download_voices import download_voice  # noqa: E402
from tts import VOICES_DIR, PiperSynthesizer, length_scale_from_env  # noqa: E402

SAMPLES_DIR = REPO / "speech" / "samples"

# Target register: the neutral female Latin-American announcer voice PR
# callers know from carrier voicemail greetings. There is no es_PR Piper
# voice, so the closest candidates are the female LatAm voices (listed
# first); the Castilian voices stay in for contrast.
CANDIDATE_VOICES = [
    "es_MX-claude-high",
    "es_AR-daniela-high",
    "es_MX-ald-medium",
    "es_ES-sharvard-medium",
    "es_ES-davefx-medium",
]

# Real prompt copy (same wording as src/server/prompts.js) plus one
# voicemail-register sentence, so the audition is judged in exactly the
# announcer style the clinic wants to match. The read-back sentences at the
# end are the pace-critical ones: a date and a digit-by-digit phone number
# are what an elderly caller has to catch on one hearing.
SAMPLE_TEXT = (
    "Gracias por llamar a la Clínica de Cirugía General. "
    "Si es paciente nuevo, oprima uno. Para una cita de seguimiento, oprima dos. "
    "Si le operaron recientemente, oprima tres. Si llama por un referido médico, oprima cuatro. "
    "Si prefiere hablar con una persona, oprima cero en cualquier momento. "
    "La persona a la que llama no está disponible. "
    "Después del tono, deje su mensaje. "
    "Perdón, no le entendí bien. ¿Podría repetirlo, por favor? "
    "Entendí que nació el 12 de marzo de 1938. "
    "Entendí que su teléfono es 7 8 7, 4 9 0, 2 0 8 1. "
    "¿Es correcto? Oprima uno si está bien, o dos si lo tengo que corregir."
)


def main():
    VOICES_DIR.mkdir(parents=True, exist_ok=True)
    SAMPLES_DIR.mkdir(parents=True, exist_ok=True)
    print(f"speaking pace: length_scale={length_scale_from_env()} (1.0 = native)")

    failures = []
    for voice in CANDIDATE_VOICES:
        try:
            if not (VOICES_DIR / f"{voice}.onnx").exists():
                print(f"downloading {voice} ...")
                download_voice(voice, VOICES_DIR)
            synth = PiperSynthesizer(voice)

            native = synth.synthesize(SAMPLE_TEXT, sample_rate=synth._voice.config.sample_rate)
            (SAMPLES_DIR / f"{voice}.wav").write_bytes(native)

            telephone = synth.synthesize(SAMPLE_TEXT, sample_rate=8000)
            (SAMPLES_DIR / f"{voice}.8k.wav").write_bytes(telephone)

            print(f"  wrote samples/{voice}.wav and samples/{voice}.8k.wav")
        except Exception as exc:
            failures.append((voice, exc))
            print(f"  FAILED {voice}: {exc}")

    print()
    print(f"done: {len(CANDIDATE_VOICES) - len(failures)}/{len(CANDIDATE_VOICES)} voices rendered")
    print("listen to the .8k.wav files (telephone quality), pick one, and set")
    print("PIPER_VOICE=<voice name> in .env")
    if failures:
        sys.exit(1)


if __name__ == "__main__":
    main()
