#!/usr/bin/env node
// V380 Talk - Send audio to V380 camera speaker
// Usage: node v380-talk.js [beep|chirp|alert] [volume 0-100]

const net = require('net');
const crypto = require('crypto');

const CAMERA_IP = process.env.V380_IP || '192.168.1.200';
const CAMERA_PORT = 8800;
const DEVICE_ID = 46337958;
const USERNAME = '46337958';
const PASSWORD = 'password123#';

const V380_KEY = 'macrovideo+*#!^@';

function generateSalt(len) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < len; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}

function aesEncrypt(key, data) {
  const padLen = 16 - (data.length % 16);
  const padded = Buffer.concat([data, Buffer.alloc(padLen, padLen)]);
  const cipher = crypto.createCipheriv('aes-128-ecb', Buffer.from(key), null);
  cipher.setAutoPadding(false);
  return cipher.update(padded);
}

function buildLoginPacket() {
  const salt = generateSalt(16);
  const saltHex = Buffer.from(salt).toString('hex');
  const enc1 = aesEncrypt(V380_KEY, Buffer.from(PASSWORD));
  const enc2 = aesEncrypt(salt, enc1);

  const camHex = Buffer.alloc(4);
  camHex.writeUInt32LE(DEVICE_ID);

  const date = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const dateHex = Buffer.from(date).toString('hex');

  const userPadded = Buffer.alloc(32, 0);
  Buffer.from(USERNAME).copy(userPadded);

  let loginHex = '8f040000780000001f0a000000';
  loginHex += camHex.toString('hex') + dateHex + '00000000000000000000000000';
  loginHex += userPadded.toString('hex') + saltHex + enc2.toString('hex');

  const packet = Buffer.from(loginHex, 'hex');
  const padded = Buffer.alloc(512, 0);
  packet.copy(padded);
  return padded;
}

function buildAudioHandshake(handleBytes) {
  const camHex = Buffer.alloc(4);
  camHex.writeUInt32LE(DEVICE_ID);
  const handshake = Buffer.alloc(85, 0);
  Buffer.from([0x79, 0x01, 0x00, 0x00]).copy(handshake, 0);
  camHex.copy(handshake, 4);
  handleBytes.copy(handshake, 8);
  return handshake;
}

function buildAudioPayloadHeader(packetsSent) {
  return Buffer.from([
    0xb4, 0x00, 0x00, 0x00, 0x01, 0x00, 0x16, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, (packetsSent + 1) % 256
  ]);
}

// IMA-ADPCM encoder
const imaIndexTable = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8];
const imaStepTable = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31,
  34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143,
  157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658,
  724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024,
  3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899,
  15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767
];

class ImaEncoder {
  constructor() {
    this.predicted = 0;
    this.index = 0;
  }

  encodeSample(sample) {
    let delta = sample - this.predicted;
    let value = 0;
    if (delta < 0) { value = 8; delta = -delta; }

    const step = imaStepTable[this.index];
    let diff = step >> 3;

    if (delta > step) { value |= 4; delta -= step; diff += step; }
    if (delta > (step >> 1)) { value |= 2; delta -= (step >> 1); diff += (step >> 1); }
    if (delta > (step >> 2)) { value |= 1; diff += (step >> 2); }

    if (value & 8) this.predicted -= diff;
    else this.predicted += diff;

    this.predicted = Math.max(-0x8000, Math.min(0x7FFF, this.predicted));
    this.index = Math.max(0, Math.min(88, this.index + imaIndexTable[value & 7]));

    return value;
  }

  encodeBlock(samples) {
    const firstSample = samples[0];
    this.encodeSample(firstSample);

    const header = Buffer.alloc(4);
    header.writeInt16LE(firstSample, 0);
    header.writeUInt8(this.index, 2);
    header.writeUInt8(0, 3);

    const result = [header];
    for (let i = 1; i < samples.length - 1; i += 2) {
      const sample1 = this.encodeSample(samples[i]);
      const sample2 = this.encodeSample(samples[i + 1] || 0);
      result.push(Buffer.from([(sample2 << 4) | sample1]));
    }

    return Buffer.concat(result);
  }
}

// Sound generators
function generateTone(frequency, durationMs, volume = 0.3) {
  const sampleRate = 8000;
  const numSamples = Math.floor(sampleRate * durationMs / 1000);
  const samples = [];
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    let env = 1.0;
    const fade = numSamples * 0.05;
    if (i < fade) env = i / fade;
    if (i > numSamples - fade) env = (numSamples - i) / fade;
    samples.push(Math.floor(Math.sin(2 * Math.PI * frequency * t) * volume * env * 32767));
  }
  return samples;
}

function generateBeep(volume = 0.3) {
  return generateTone(800, 500, volume);
}

function generateChirp(volume = 0.3) {
  // Rising chirp
  const sampleRate = 8000;
  const duration = 0.3;
  const numSamples = Math.floor(sampleRate * duration);
  const samples = [];
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const freq = 400 + (t / duration) * 800;
    let env = 1.0;
    const fade = numSamples * 0.1;
    if (i < fade) env = i / fade;
    if (i > numSamples - fade) env = (numSamples - i) / fade;
    samples.push(Math.floor(Math.sin(2 * Math.PI * freq * t) * volume * env * 32767));
  }
  return samples;
}

function generateAlert(volume = 0.3) {
  // Two-tone alert
  return [
    ...generateTone(600, 200, volume),
    ...generateTone(800, 200, volume),
    ...generateTone(600, 200, volume),
    ...generateTone(800, 200, volume)
  ];
}

function waitForData(socket, timeout = 5000) {
  return new Promise((resolve) => {
    let resolved = false;
    const handler = (data) => {
      if (!resolved) { resolved = true; socket.removeListener('data', handler); resolve(data); }
    };
    socket.on('data', handler);
    setTimeout(() => {
      if (!resolved) { resolved = true; socket.removeListener('data', handler); resolve(null); }
    }, timeout);
  });
}

async function sendAudio(samples) {
  // Login
  const socket1 = new net.Socket();
  socket1.setTimeout(10000);

  await new Promise((resolve, reject) => {
    socket1.connect(CAMERA_PORT, CAMERA_IP, resolve);
    socket1.on('error', reject);
  });

  socket1.write(buildLoginPacket());
  const loginResp = await waitForData(socket1, 3000);
  if (!loginResp || loginResp[0] !== 0x90 || loginResp[1] !== 0x04) {
    socket1.destroy();
    throw new Error('Login failed');
  }

  const handleBytes = loginResp.slice(13, 17);
  socket1.destroy();

  await new Promise(r => setTimeout(r, 300));

  // Audio stream
  const socket2 = new net.Socket();
  socket2.setTimeout(30000);
  socket2.setNoDelay(true);

  await new Promise((resolve, reject) => {
    socket2.connect(CAMERA_PORT, CAMERA_IP, resolve);
    socket2.on('error', reject);
  });

  let alive = true;
  socket2.on('close', () => { alive = false; });

  socket2.write(buildAudioHandshake(handleBytes));
  await new Promise(r => setTimeout(r, 300));

  if (!alive) throw new Error('Handshake rejected');

  // Send audio
  const samplesPerChunk = 505;
  const encoder = new ImaEncoder();
  let packetsSent = 0;

  for (let i = 0; i < samples.length && alive; i += samplesPerChunk) {
    const chunk = samples.slice(i, Math.min(i + samplesPerChunk, samples.length));
    while (chunk.length < samplesPerChunk) chunk.push(0);

    let adpcm = encoder.encodeBlock(chunk);
    if (adpcm.length < 256) {
      const padded = Buffer.alloc(256, 0);
      adpcm.copy(padded);
      adpcm = padded;
    }

    socket2.write(Buffer.concat([buildAudioPayloadHeader(packetsSent), adpcm]));
    packetsSent++;
    await new Promise(r => setTimeout(r, 60));
  }

  await new Promise(r => setTimeout(r, 200));
  socket2.destroy();
  return packetsSent;
}

async function main() {
  const sound = process.argv[2] || 'beep';
  const volume = Math.min(100, Math.max(0, parseInt(process.argv[3]) || 30)) / 100;

  console.log(`V380 Talk: ${sound} at ${Math.round(volume * 100)}% volume`);

  let samples;
  switch (sound) {
    case 'chirp':
      samples = generateChirp(volume);
      break;
    case 'alert':
      samples = generateAlert(volume);
      break;
    default:
      samples = generateBeep(volume);
  }

  const packets = await sendAudio(samples);
  console.log(`Sent ${packets} packets`);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
