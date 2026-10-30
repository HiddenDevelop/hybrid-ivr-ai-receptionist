# Hybrid IVR AI Receptionist

A Spanish-language, IVR-first phone receptionist for a small general surgery clinic. Callers navigate a touch-tone menu, and the system uses a local LLM to extract details from free speech where that helps. Speech-to-text, the language model, and text-to-speech all run on-premises. Twilio is used only as a phone-network bridge and never sees transcripts or extracted fields.

## How it works

- **Telephony:** Twilio receives the call and streams the audio over a WebSocket (Media Streams) to the Node server.
- **Orchestrator (Node.js):** Express and `ws` handle the call flow, the IVR menu, and the booking logic. Bookings are stored in SQLite.
- **Speech sidecar (Python, FastAPI):** Runs locally on `127.0.0.1` and handles speech-to-text with faster-whisper and text-to-speech with Piper.
- **LLM (Ollama):** A local model (default `qwen2.5:14b`) extracts structured fields from the caller's speech.
- **Google Calendar (optional):** Booked appointments are pushed as one-way calendar events, with the patient's name and appointment type only.

## Requirements

- Node.js
- Python 3 with the packages in `requirements.txt`
- [Ollama](https://ollama.com) running locally, with the model pulled:
  ```bash
  ollama pull qwen2.5:14b
  ```
- An NVIDIA GPU is recommended. The default config uses CUDA for Whisper. Set `WHISPER_DEVICE=cpu` on machines without one.
- A Twilio account with a phone number, and a public `wss://` tunnel to the server (for example, ngrok) for local development.

## Setup

1. Clone the repository and install Node dependencies:
   ```bash
   git clone https://github.com/HiddenDevelop/hybrid-ivr-ai-receptionist.git
   cd hybrid-ivr-ai-receptionist
   npm install
   ```
2. Create the Python environment and install the speech sidecar's dependencies:
   ```bash
   python3 -m venv .venv
   source .venv/bin/activate
   pip install -r requirements.txt
   ```
3. Copy the environment template and fill in your values:
   ```bash
   cp .env.example .env
   ```
   Never commit `.env`. The example file is tracked in git and must not contain real credentials.
4. (Optional) Set up Google Calendar sync:
   - Create an OAuth "installed app" client in Google Cloud Console and save its JSON as `credentials.json` (or the path set in `GOOGLE_CREDENTIALS_FILE`).
   - Run the one-time consent flow: `node scripts/google-auth.js`
   - Sync stays disabled, with a startup warning, until the token file exists.

## Running

Start the server:

```bash
npm start
```

For development, use the dev script:

```bash
npm run dev
```

Run the tests:

```bash
npm test
```

Then point your Twilio number's voice webhook at your public tunnel URL so incoming calls reach the `/media` endpoint.

## Configuration

Key settings in `.env` (see `.env.example` for the full list and comments):

| Variable | Purpose |
| --- | --- |
| `PORT` | Port for the Express server and Media Streams WebSocket (default `3000`) |
| `DB_PATH` | SQLite database path (default `var/clinic.db`) |
| `SPEECH_HOST` / `SPEECH_PORT` | Address of the speech sidecar (default `127.0.0.1:8081`) |
| `WHISPER_MODEL`, `WHISPER_DEVICE`, `WHISPER_COMPUTE` | Speech-to-text model and hardware settings |
| `TTS_ENGINE`, `PIPER_VOICE`, `TTS_LENGTH_SCALE` | Text-to-speech engine, voice, and speaking pace |
| `CLINIC_NAME`, `CLINIC_ADDRESS` | Used in confirmation SMS messages |
| `OLLAMA_URL`, `OLLAMA_MODEL` | Local LLM endpoint and model |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` | Twilio credentials and sending number |
| `TWILIO_STREAM_URL` | Public `wss://` URL of the `/media` endpoint |
| `SCHEDULING_NUMBER` | Optional number for the caller's "press 0 for a person" transfer |
| `GOOGLE_CALENDAR_ID`, `GOOGLE_CALENDAR_TIMEZONE` | Calendar mirror settings |

Voice samples can be generated with `scripts/make-voice-samples.py` (see the `speech/` folder). Choose the Piper voice before prompts are cached, because changing it means re-testing the call flow.

## Project structure

```
src/server/   Node.js orchestrator (call flow, IVR, bookings)
speech/       Python speech sidecar (STT, TTS)
scripts/      Dev, setup, and utility scripts (e.g. dev.sh, google-auth.js)
```

## Notes

- This project is designed for a clinic and handles patient information. Review it against the privacy and data-handling rules that apply in your jurisdiction before using it with real callers.
- The default speaking pace is slowed down (`TTS_LENGTH_SCALE=1.25`) because the caller base is mostly older adults.

