#!/usr/bin/env node
// V380 Talk Test - Exact protocol from jericjan/v380-audio-player
// Using hex.py and main.py packet formats

const net = require('net');
const crypto = require('crypto');

const CAMERA_IP = '192.168.1.200';
const CAMERA_PORT = 8800;
const DEVICE_ID = 46337958;
const USERNAME = '46337958';
const PASSWORD = 'password123#';

const V380_KEY = 'macrovideo+*#!^@';

// Magic constants from main.py
const MAGIC_1 = BigInt('0x618123462C14795C');
const MAGIC_2 = 0x82800DF0;

function generateSalt(len) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < len; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}

function aesEncrypt(key, data) {
  // Pad to 16 bytes
  const padLen = 16 - (data.length % 16);
  const padded = Buffer.concat([data, Buffer.alloc(padLen, padLen)]);
  const cipher = crypto.createCipheriv('aes-128-ecb', Buffer.from(key), null);
  cipher.setAutoPadding(false);
  return cipher.update(padded);
}

function buildLoginPacket() {
  const salt = generateSalt(16);
  const saltHex = Buffer.from(salt).toString('hex');

  // Encrypt password: first with v380_key, then with salt
  const enc1 = aesEncrypt(V380_KEY, Buffer.from(PASSWORD));
  const enc2 = aesEncrypt(salt, enc1);

  const camHex = Buffer.alloc(4);
  camHex.writeUInt32LE(DEVICE_ID);

  const date = '2025-12-19 03:45:00';
  const dateHex = Buffer.from(date).toString('hex');

  const userPadded = Buffer.alloc(32, 0);
  Buffer.from(USERNAME).copy(userPadded);

  // Build login packet exactly like hex.py
  let loginHex = '8f040000780000001f0a000000';
  loginHex += camHex.toString('hex');
  loginHex += dateHex;
  loginHex += '00000000000000000000000000';
  loginHex += userPadded.toString('hex');
  loginHex += saltHex;
  loginHex += enc2.toString('hex');

  const packet = Buffer.from(loginHex, 'hex');
  const padded = Buffer.alloc(512, 0);
  packet.copy(padded);
  return padded;
}

function buildAudioHandshake(handleBytes) {
  const camHex = Buffer.alloc(4);
  camHex.writeUInt32LE(DEVICE_ID);

  // 79010000 + cam_hex, padded to 85 bytes, handle at 8-12
  const handshake = Buffer.alloc(85, 0);
  Buffer.from([0x79, 0x01, 0x00, 0x00]).copy(handshake, 0);
  camHex.copy(handshake, 4);
  handleBytes.copy(handshake, 8);
  return handshake;
}

function buildAudioPayloadHeader(packetsSent) {
  // b40000000100160000000000000001 + seq_byte
  const header = Buffer.from([
    0xb4, 0x00, 0x00, 0x00, 0x01, 0x00, 0x16, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, (packetsSent + 1) % 256
  ]);
  return header;
}

function generateMagicKey(handleBytes) {
  // Pad handle to 16 bytes
  const key = Buffer.alloc(16, 0);
  handleBytes.copy(key, 0, 0, Math.min(4, handleBytes.length));

  // MAGIC_1 (8 bytes little-endian) at position 4-12
  key.writeBigUInt64LE(MAGIC_1, 4);

  // MAGIC_2 (4 bytes little-endian) at position 12-16
  key.writeUInt32LE(MAGIC_2, 12);

  return key;
}

// IMA-ADPCM encoder with nibble swap
const imaIndexTable = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8];
const imaStepTable = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31,
  34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143,
  157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658,
  724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024,
  3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899,
  15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767
];

function encodeAdpcmWithSwap(samples) {
  let predictor = 0;
  let stepIndex = 0;
  const nibbles = [];

  for (const sample of samples) {
    const step = imaStepTable[stepIndex];
    let diff = sample - predictor;

    let nibble = 0;
    if (diff < 0) { nibble = 8; diff = -diff; }
    if (diff >= step) { nibble |= 4; diff -= step; }
    if (diff >= step >> 1) { nibble |= 2; diff -= step >> 1; }
    if (diff >= step >> 2) { nibble |= 1; }

    let delta = step >> 3;
    if (nibble & 4) delta += step;
    if (nibble & 2) delta += step >> 1;
    if (nibble & 1) delta += step >> 2;
    if (nibble & 8) delta = -delta;

    predictor = Math.max(-32768, Math.min(32767, predictor + delta));
    stepIndex = Math.max(0, Math.min(88, stepIndex + imaIndexTable[nibble & 7]));
    nibbles.push(nibble);
  }

  // Pack with SWAPPED nibbles (like Python pyima)
  const bytes = [];
  for (let i = 0; i < nibbles.length; i += 2) {
    const first = nibbles[i] || 0;
    const second = nibbles[i + 1] || 0;
    // Swap: second nibble goes high, first goes low
    bytes.push((second << 4) | first);
  }
  return Buffer.from(bytes);
}

function generateBeep(frequency, durationMs, sampleRate) {
  const numSamples = Math.floor(sampleRate * durationMs / 1000);
  const samples = [];
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    let env = 1.0;
    const fade = numSamples * 0.05;
    if (i < fade) env = i / fade;
    if (i > numSamples - fade) env = (numSamples - i) / fade;
    samples.push(Math.floor(Math.sin(2 * Math.PI * frequency * t) * 0.8 * env * 32767));
  }
  return samples;
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

async function main() {
  console.log('=== V380 Talk Test (Exact Protocol) ===');
  console.log(`Camera: ${CAMERA_IP}:${CAMERA_PORT}\n`);

  // Step 1: Login
  console.log('[1/4] Sending login packet...');
  const socket = new net.Socket();
  socket.setTimeout(15000);
  socket.setNoDelay(true);

  await new Promise((resolve, reject) => {
    socket.connect(CAMERA_PORT, CAMERA_IP, resolve);
    socket.on('error', reject);
  });

  const loginPacket = buildLoginPacket();
  socket.write(loginPacket);

  const loginResp = await waitForData(socket, 3000);
  if (!loginResp) {
    console.error('No login response');
    process.exit(1);
  }

  // Check for 0x90 0x04 response
  if (loginResp[0] !== 0x90 || loginResp[1] !== 0x04) {
    console.log('Unexpected response:', loginResp.slice(0, 20).toString('hex'));
    process.exit(1);
  }

  const version = loginResp[12];
  const handleBytes = loginResp.slice(13, 17);
  console.log(`[2/4] Got handle: ${handleBytes.toString('hex')}, version: ${version}`);

  // Step 2: Audio handshake
  console.log('[3/4] Sending audio handshake...');
  const handshake = buildAudioHandshake(handleBytes);
  socket.write(handshake);
  await waitForData(socket, 1000);

  // Step 3: Prepare encryption
  let cipher = null;
  if (version > 30) {
    const magicKey = generateMagicKey(handleBytes);
    console.log('Using encrypted audio (version > 30)');
    cipher = crypto.createCipheriv('aes-128-ecb', magicKey, null);
    cipher.setAutoPadding(false);
  } else {
    console.log('Using unencrypted audio (version <= 30)');
  }

  // Step 4: Send audio
  console.log('[4/4] Sending 3-second beep...');
  const samples = generateBeep(800, 3000, 8000);

  // 252 bytes of ADPCM data per packet = 504 samples
  const samplesPerChunk = 504;
  let packetsSent = 0;

  for (let i = 0; i < samples.length; i += samplesPerChunk) {
    const chunk = samples.slice(i, Math.min(i + samplesPerChunk, samples.length));
    let adpcm = encodeAdpcmWithSwap(chunk);

    // Pad to 256 bytes
    if (adpcm.length < 256) {
      const padded = Buffer.alloc(256, 0);
      adpcm.copy(padded);
      adpcm = padded;
    }

    // Encrypt if needed
    if (cipher) {
      const c = crypto.createCipheriv('aes-128-ecb', generateMagicKey(handleBytes), null);
      c.setAutoPadding(false);
      adpcm = c.update(adpcm);
    }

    // Build packet: header + payload
    const header = buildAudioPayloadHeader(packetsSent);
    const packet = Buffer.concat([header, adpcm]);

    socket.write(packet);
    packetsSent++;

    // Timing: 504 samples at 8kHz = 63ms
    await new Promise(r => setTimeout(r, 60));
  }

  console.log(`Sent ${packetsSent} audio packets`);
  console.log('\n>>> LISTEN FOR THE BEEP! <<<\n');

  await new Promise(r => setTimeout(r, 1000));
  socket.destroy();
  console.log('Done!');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
