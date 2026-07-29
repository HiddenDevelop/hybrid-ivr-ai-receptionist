// Pure-JS G.711 mu-law codec plus minimal WAV read/write for mono 16-bit
// PCM. Twilio Media Streams carries 8kHz mono mulaw; the pipeline service
// speaks 8kHz mono 16-bit PCM WAV. This module is the only place those two
// formats meet, so nothing upstream needs to know about telephony audio.

const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32635;

function linearToMulawSample(sampleIn) {
  let sample = sampleIn;
  let sign = (sample >> 8) & 0x80;
  if (sign !== 0) sample = -sample;
  if (sample > MULAW_CLIP) sample = MULAW_CLIP;
  sample += MULAW_BIAS;

  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent -= 1, expMask >>= 1);

  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

function mulawToLinearSample(mulawByteIn) {
  const mulawByte = ~mulawByteIn & 0xff;
  const sign = mulawByte & 0x80;
  const exponent = (mulawByte >> 4) & 0x07;
  const mantissa = mulawByte & 0x0f;
  let sample = ((mantissa << 3) + MULAW_BIAS) << exponent;
  sample -= MULAW_BIAS;
  return sign !== 0 ? -sample : sample;
}

const MULAW_SILENCE_BYTE = linearToMulawSample(0);

function mulawToPcm16(mulawBuffer) {
  const pcm16 = Buffer.alloc(mulawBuffer.length * 2);
  for (let i = 0; i < mulawBuffer.length; i += 1) {
    pcm16.writeInt16LE(mulawToLinearSample(mulawBuffer[i]), i * 2);
  }
  return pcm16;
}

function pcm16ToMulaw(pcm16Buffer) {
  const sampleCount = Math.floor(pcm16Buffer.length / 2);
  const mulaw = Buffer.alloc(sampleCount);
  for (let i = 0; i < sampleCount; i += 1) {
    mulaw[i] = linearToMulawSample(pcm16Buffer.readInt16LE(i * 2));
  }
  return mulaw;
}

function pcm16ToWav(pcm16Buffer, sampleRate) {
  const header = Buffer.alloc(44);
  const dataSize = pcm16Buffer.length;

  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate (2 bytes/sample)
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcm16Buffer]);
}

// Minimal RIFF/WAVE parser: walks chunks rather than assuming fixed
// offsets, since Python's `wave` module and others may order or size
// chunks slightly differently.
function wavToPcm16(wavBuffer) {
  if (wavBuffer.toString('ascii', 0, 4) !== 'RIFF' || wavBuffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }

  let offset = 12;
  let fmt = null;
  let data = null;

  while (offset + 8 <= wavBuffer.length) {
    const chunkId = wavBuffer.toString('ascii', offset, offset + 4);
    const chunkSize = wavBuffer.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;

    if (chunkId === 'fmt ') {
      fmt = {
        audioFormat: wavBuffer.readUInt16LE(chunkStart),
        channels: wavBuffer.readUInt16LE(chunkStart + 2),
        sampleRate: wavBuffer.readUInt32LE(chunkStart + 4),
        bitsPerSample: wavBuffer.readUInt16LE(chunkStart + 14),
      };
    } else if (chunkId === 'data') {
      data = wavBuffer.subarray(chunkStart, chunkStart + chunkSize);
    }

    offset = chunkStart + chunkSize + (chunkSize % 2); // chunks are word-aligned
  }

  if (!fmt || !data) throw new Error('WAV file missing fmt or data chunk');
  if (fmt.audioFormat !== 1) throw new Error(`unsupported WAV audio format ${fmt.audioFormat}, expected PCM`);
  if (fmt.bitsPerSample !== 16) throw new Error(`unsupported bits per sample ${fmt.bitsPerSample}, expected 16`);

  return { pcm16: Buffer.from(data), sampleRate: fmt.sampleRate, channels: fmt.channels };
}

function chunkIntoFrames(buffer, frameBytes) {
  const frames = [];
  for (let i = 0; i < buffer.length; i += frameBytes) {
    const end = Math.min(i + frameBytes, buffer.length);
    let frame = buffer.subarray(i, end);
    if (frame.length < frameBytes) {
      const padded = Buffer.alloc(frameBytes, MULAW_SILENCE_BYTE);
      frame.copy(padded);
      frame = padded;
    }
    frames.push(frame);
  }
  return frames;
}

// Simple energy measure for silence detection — RMS over signed 16-bit
// samples decoded from a mulaw frame.
function frameRms(mulawFrame) {
  let sumSquares = 0;
  for (let i = 0; i < mulawFrame.length; i += 1) {
    const sample = mulawToLinearSample(mulawFrame[i]);
    sumSquares += sample * sample;
  }
  return Math.sqrt(sumSquares / mulawFrame.length);
}

module.exports = {
  mulawToPcm16,
  pcm16ToMulaw,
  pcm16ToWav,
  wavToPcm16,
  chunkIntoFrames,
  frameRms,
  MULAW_SILENCE_BYTE,
};
