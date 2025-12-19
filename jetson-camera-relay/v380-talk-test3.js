#!/usr/bin/env node
// V380 Talk Test v3 - Two separate sockets like Python version
// Key fix: Login on socket1, close it, then audio on socket2

const net = require('net');
const crypto = require('crypto');

const CAMERA_IP = '192.168.1.200';
const CAMERA_PORT = 8800;
const DEVICE_ID = 46337958;
const USERNAME = '46337958';
const PASSWORD = 'password123#';

const V380_KEY = 'macrovideo+*#!^@';
const MAGIC_1 = BigInt('0x618123462C14795C');
const MAGIC_2 = 0x82800DF0;

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

  const date = '2025-12-19 04:00:00';
  const dateHex = Buffer.from(date).toString('hex');

  const userPadded = Buffer.alloc(32, 0);
  Buffer.from(USERNAME).copy(userPadded);

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

function generateMagicKey(handleBytes) {
  const key = Buffer.alloc(16, 0);
  handleBytes.copy(key, 0, 0, Math.min(4, handleBytes.length));
  key.writeBigUInt64LE(MAGIC_1, 4);
  key.writeUInt32LE(MAGIC_2, 12);
  return key;
}

// IMA-ADPCM encoder matching pyima exactly
const imaIndexTable = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8];
const imaStepTable = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31,
  34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143,
  157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658,
  724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024,
  3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899,
  15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767
];

class PyIma {
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

  // Encode exactly like pyima.encode_block
  encodeBlock(samples) {
    // samples should be 505 16-bit samples (1010 bytes worth)
    // First sample becomes header
    const firstSample = samples[0];
    this.encodeSample(firstSample);

    // Header: 2-byte sample + 1-byte index + 0x00
    const header = Buffer.alloc(4);
    header.writeInt16LE(firstSample, 0);
    header.writeUInt8(this.index, 2);
    header.writeUInt8(0, 3);

    const result = [header];

    // Encode remaining samples in pairs
    for (let i = 1; i < samples.length - 1; i += 2) {
      const sample1 = this.encodeSample(samples[i]);
      const sample2 = this.encodeSample(samples[i + 1] || 0);
      // Nibble swap: second << 4 | first
      result.push(Buffer.from([(sample2 << 4) | sample1]));
    }

    return Buffer.concat(result);
  }
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
    samples.push(Math.floor(Math.sin(2 * Math.PI * frequency * t) * 0.9 * env * 32767));
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
  console.log('=== V380 Talk Test v3 (Two Socket Approach) ===');
  console.log(`Camera: ${CAMERA_IP}:${CAMERA_PORT}\n`);

  // Step 1: Login on socket1, get handle, then CLOSE
  console.log('[1/5] Connecting for login...');
  const socket1 = new net.Socket();
  socket1.setTimeout(15000);

  await new Promise((resolve, reject) => {
    socket1.connect(CAMERA_PORT, CAMERA_IP, resolve);
    socket1.on('error', reject);
  });

  const loginPacket = buildLoginPacket();
  socket1.write(loginPacket);

  const loginResp = await waitForData(socket1, 3000);
  if (!loginResp) {
    console.error('No login response');
    process.exit(1);
  }

  if (loginResp[0] !== 0x90 || loginResp[1] !== 0x04) {
    console.log('Unexpected response:', loginResp.slice(0, 20).toString('hex'));
    process.exit(1);
  }

  const version = loginResp[12];
  const handleBytes = loginResp.slice(13, 17);
  console.log(`[2/5] Login OK! Handle: ${handleBytes.toString('hex')}, Version: ${version}`);

  // CLOSE socket1 like Python does
  socket1.destroy();
  console.log('[2/5] Login socket closed');

  // Wait a moment before opening socket2
  await new Promise(r => setTimeout(r, 500));

  // Step 2: Open socket2 for audio streaming
  console.log('[3/5] Connecting for audio stream...');
  const socket2 = new net.Socket();
  socket2.setTimeout(30000);
  socket2.setNoDelay(true);

  await new Promise((resolve, reject) => {
    socket2.connect(CAMERA_PORT, CAMERA_IP, resolve);
    socket2.on('error', reject);
  });

  // Listen for data in background
  let connectionAlive = true;
  socket2.on('data', (data) => {
    console.log('  [RX]', data.slice(0, 20).toString('hex'));
  });
  socket2.on('close', () => {
    console.log('  [!] Connection closed by camera');
    connectionAlive = false;
  });

  // Send audio handshake
  console.log('[4/5] Sending audio handshake...');
  const handshake = buildAudioHandshake(handleBytes);
  socket2.write(handshake);

  await new Promise(r => setTimeout(r, 500));
  if (!connectionAlive) {
    console.error('Camera rejected handshake');
    process.exit(1);
  }

  // Prepare encryption
  let useEncryption = version > 30;
  const magicKey = generateMagicKey(handleBytes);
  console.log(`[4/5] Version ${version}: ${useEncryption ? 'Encrypted' : 'Unencrypted'} audio`);

  // Step 3: Send audio
  console.log('[5/5] Sending 3-second beep...');
  const allSamples = generateBeep(800, 3000, 8000);

  // 505 samples per block like Python
  const samplesPerChunk = 505;
  const pyima = new PyIma();
  let packetsSent = 0;

  for (let i = 0; i < allSamples.length && connectionAlive; i += samplesPerChunk) {
    const chunk = allSamples.slice(i, Math.min(i + samplesPerChunk, allSamples.length));

    // Pad to exactly 505 samples
    while (chunk.length < samplesPerChunk) chunk.push(0);

    // Encode with pyima-style encoder
    let adpcm = pyima.encodeBlock(chunk);

    // Pad to 256 bytes
    if (adpcm.length < 256) {
      const padded = Buffer.alloc(256, 0);
      adpcm.copy(padded);
      adpcm = padded;
    }

    // Encrypt if needed
    if (useEncryption) {
      const c = crypto.createCipheriv('aes-128-ecb', magicKey, null);
      c.setAutoPadding(false);
      adpcm = c.update(adpcm);
    }

    // Build packet: header + payload
    const header = buildAudioPayloadHeader(packetsSent);
    const packet = Buffer.concat([header, adpcm]);

    socket2.write(packet);
    packetsSent++;

    // Timing: 505 samples at 8kHz = 63.125ms
    await new Promise(r => setTimeout(r, 60));
  }

  console.log(`Sent ${packetsSent} audio packets`);
  console.log('\n>>> LISTEN FOR THE BEEP! <<<\n');

  await new Promise(r => setTimeout(r, 1000));
  socket2.destroy();
  console.log('Done!');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
