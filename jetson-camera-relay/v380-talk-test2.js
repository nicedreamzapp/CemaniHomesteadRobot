#!/usr/bin/env node
// V380 Talk Test v2 - Try G.711 u-law format

const net = require('net');
const crypto = require('crypto');

const CAMERA_IP = '192.168.1.200';
const CAMERA_PORT = 8800;
const DEVICE_ID = 46337958;
const USERNAME = '46337958';
const PASSWORD = 'password123#';
const V380_KEY = 'macrovideo+*#!^@';

function generateRandomPrintable(len) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz1234567890!@#$%^&*()_+-=';
  let s = '';
  for (let i = 0; i < len; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}

function generatePassword(password) {
  const randomKey = generateRandomPrintable(16);
  const padLen = 16 - (password.length % 16);
  const padded = Buffer.alloc(password.length + padLen, 0);
  Buffer.from(password).copy(padded);
  const cipher1 = crypto.createCipheriv('aes-128-ecb', Buffer.from(V380_KEY), null);
  cipher1.setAutoPadding(false);
  const enc1 = cipher1.update(padded);
  const cipher2 = crypto.createCipheriv('aes-128-ecb', Buffer.from(randomKey), null);
  cipher2.setAutoPadding(false);
  const enc2 = cipher2.update(enc1);
  return Buffer.concat([Buffer.from(randomKey), enc2]);
}

// Generate beep as PCM
function generateBeepPCM(frequency, durationMs, sampleRate) {
  const numSamples = Math.floor(sampleRate * durationMs / 1000);
  const samples = [];
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    let envelope = 1.0;
    const fadeLen = numSamples * 0.05;
    if (i < fadeLen) envelope = i / fadeLen;
    if (i > numSamples - fadeLen) envelope = (numSamples - i) / fadeLen;
    samples.push(Math.floor(Math.sin(2 * Math.PI * frequency * t) * 0.8 * envelope * 32767));
  }
  return samples;
}

// G.711 u-law encoding
function linear2ulaw(sample) {
  const BIAS = 0x84;
  const CLIP = 32635;
  let sign = (sample >> 8) & 0x80;
  if (sign) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; !(sample & mask) && exponent > 0; mask >>= 1) exponent--;
  let mantissa = (sample >> (exponent + 3)) & 0x0F;
  return ~(sign | (exponent << 4) | mantissa) & 0xFF;
}

function waitForData(socket, timeout = 5000) {
  return new Promise((resolve) => {
    let resolved = false;
    const handler = (data) => { if (!resolved) { resolved = true; socket.removeListener('data', handler); resolve(data); } };
    socket.on('data', handler);
    setTimeout(() => { if (!resolved) { resolved = true; socket.removeListener('data', handler); resolve(null); } }, timeout);
  });
}

async function sendTestBeep() {
  console.log('=== V380 Talk Test v2 (G.711 u-law) ===');
  console.log(`Camera: ${CAMERA_IP}:${CAMERA_PORT}\n`);

  // Auth
  console.log('[1/5] Authenticating...');
  const authSocket = new net.Socket();
  authSocket.setTimeout(10000);
  await new Promise((resolve, reject) => { authSocket.connect(CAMERA_PORT, CAMERA_IP, resolve); authSocket.on('error', reject); });

  const loginPacket = Buffer.alloc(256, 0);
  loginPacket.writeUInt32LE(1167, 0);
  loginPacket.writeUInt32LE(1022, 4);
  loginPacket.writeUInt8(2, 8);
  loginPacket.writeUInt32LE(1, 9);
  loginPacket.writeUInt32LE(DEVICE_ID, 13);
  Buffer.from(USERNAME).copy(loginPacket, 49);
  generatePassword(PASSWORD).copy(loginPacket, 81);

  authSocket.write(loginPacket);
  const loginResp = await waitForData(authSocket);
  if (!loginResp || loginResp.readUInt32LE(4) !== 1001) { console.error('Login failed'); process.exit(1); }
  const authTicket = loginResp.readUInt32LE(13);
  console.log(`[2/5] Login OK, ticket: ${authTicket}`);
  authSocket.destroy();

  // Stream
  console.log('[3/5] Opening stream...');
  const streamSocket = new net.Socket();
  streamSocket.setTimeout(10000);
  streamSocket.setNoDelay(true);
  await new Promise((resolve, reject) => { streamSocket.connect(CAMERA_PORT, CAMERA_IP, resolve); streamSocket.on('error', reject); });

  const streamLogin = Buffer.alloc(256, 0);
  streamLogin.writeUInt32LE(301, 0);
  streamLogin.writeUInt32LE(DEVICE_ID, 4);
  streamLogin.writeUInt16LE(20, 12);
  streamLogin.writeUInt32LE(authTicket, 14);
  streamLogin.writeUInt32LE(4097, 22);
  streamLogin.writeUInt32LE(1, 26);
  streamSocket.write(streamLogin);
  const streamResp = await waitForData(streamSocket, 2000);
  const streamHandle = streamResp ? streamResp.readInt32LE(4) : 0;
  console.log('Stream handle:', streamHandle);

  // Start stream
  const streamStart = Buffer.alloc(256, 0);
  streamStart.writeUInt32LE(303, 0);
  streamStart.writeUInt32LE(streamHandle, 4);
  streamSocket.write(streamStart);
  await waitForData(streamSocket, 1000);

  // Enable talk
  console.log('[4/5] Enabling talk...');
  const talk = Buffer.alloc(256, 0);
  talk.writeUInt32LE(377, 0);
  talk.writeUInt32LE(streamHandle, 4);
  talk.writeUInt32LE(1, 8);
  streamSocket.write(talk);
  await waitForData(streamSocket, 500);

  // Send audio
  console.log('[5/5] Sending beep (G.711 u-law)...');
  const pcm = generateBeepPCM(800, 3000, 8000); // 3 seconds, louder
  const ulaw = pcm.map(linear2ulaw);

  const chunkSize = 160; // 20ms at 8kHz
  let sent = 0;
  for (let i = 0; i < ulaw.length; i += chunkSize) {
    const chunk = Buffer.from(ulaw.slice(i, i + chunkSize));
    
    // Try different packet formats
    const header = Buffer.alloc(8, 0);
    header.writeUInt32LE(0xB4, 0); // Audio command
    header.writeUInt32LE(chunk.length, 4);
    
    streamSocket.write(Buffer.concat([header, chunk]));
    sent++;
    await new Promise(r => setTimeout(r, 18)); // ~20ms per chunk
  }

  console.log(`Sent ${sent} G.711 packets`);
  console.log('\n>>> LISTEN FOR THE BEEP! <<<\n');
  await new Promise(r => setTimeout(r, 1000));
  streamSocket.destroy();
  console.log('Done!');
}

sendTestBeep().catch(err => { console.error('Error:', err.message); process.exit(1); });
