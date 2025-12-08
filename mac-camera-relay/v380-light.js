#!/usr/bin/env node
// V380 Light Control - With proper credentials
const net = require('net');
const crypto = require('crypto');

const CAMERA_IP = '192.168.1.200';
const CAMERA_PORT = 8800;
const DEVICE_ID = 46337958;
const USERNAME = '46337958';
const PASSWORD = 'password123#';

const V380_KEY = 'macrovideo+*#!^@';

// Light control commands (16 bytes each)
const LIGHT_ON = Buffer.from([0xc4, 0x00, 0x00, 0x00, 0xe9, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
const LIGHT_OFF = Buffer.from([0xc4, 0x00, 0x00, 0x00, 0xea, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
const LIGHT_AUTO = Buffer.from([0xc4, 0x00, 0x00, 0x00, 0xeb, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);

function generateRandomPrintable(len) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz1234567890!@#$%^&*()_+-=';
  let s = '';
  for (let i = 0; i < len; i++) {
    s += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return s;
}

function generatePassword(password) {
  const randomKey = generateRandomPrintable(16);

  // Pad password to 16 bytes
  const padLen = 16 - (password.length % 16);
  const padded = Buffer.alloc(password.length + padLen, 0);
  Buffer.from(password).copy(padded);

  // First AES-ECB encryption with static key
  const cipher1 = crypto.createCipheriv('aes-128-ecb', Buffer.from(V380_KEY), null);
  cipher1.setAutoPadding(false);
  const enc1 = cipher1.update(padded);

  // Second AES-ECB encryption with random key
  const cipher2 = crypto.createCipheriv('aes-128-ecb', Buffer.from(randomKey), null);
  cipher2.setAutoPadding(false);
  const enc2 = cipher2.update(enc1);

  // Return randomKey + encrypted password
  return Buffer.concat([Buffer.from(randomKey), enc2]);
}

function waitForData(socket, timeout = 5000) {
  return new Promise((resolve) => {
    let resolved = false;
    const handler = (data) => {
      if (!resolved) {
        resolved = true;
        socket.removeListener('data', handler);
        resolve(data);
      }
    };
    socket.on('data', handler);
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        socket.removeListener('data', handler);
        resolve(null);
      }
    }, timeout);
  });
}

async function controlLight(action) {
  console.log('V380 Light Control');
  console.log(`Camera: ${CAMERA_IP}:${CAMERA_PORT}`);
  console.log(`Action: ${action}`);

  // Step 1: Auth login with proper credentials
  const authSocket = new net.Socket();
  authSocket.setTimeout(10000);

  await new Promise((resolve, reject) => {
    authSocket.connect(CAMERA_PORT, CAMERA_IP, resolve);
    authSocket.on('error', reject);
  });

  // Build proper login packet
  const loginPacket = Buffer.alloc(256, 0);
  loginPacket.writeUInt32LE(1167, 0);  // command
  loginPacket.writeUInt32LE(1022, 4);  // unknown1 (our login type)
  loginPacket.writeUInt8(2, 8);        // unknown2
  loginPacket.writeUInt32LE(1, 9);     // unknown3
  loginPacket.writeUInt32LE(DEVICE_ID, 13); // device ID

  // Username at offset 49 (32 bytes)
  Buffer.from(USERNAME).copy(loginPacket, 49);

  // Encrypted password at offset 81 (32 bytes)
  const encPassword = generatePassword(PASSWORD);
  encPassword.copy(loginPacket, 81);

  authSocket.write(loginPacket);

  const loginResp = await waitForData(authSocket);
  if (!loginResp || loginResp.length < 16) {
    console.error('No login response');
    authSocket.destroy();
    process.exit(1);
  }

  const loginResult = loginResp.readUInt32LE(4);
  const authTicket = loginResp.readUInt32LE(13);
  console.log('Login result:', loginResult, '(1001=OK)');

  if (loginResult !== 1001) {
    console.error('Login failed:', loginResult);
    authSocket.destroy();
    process.exit(1);
  }

  authSocket.destroy();

  // Step 2: Stream socket
  const streamSocket = new net.Socket();
  streamSocket.setTimeout(10000);
  streamSocket.setNoDelay(true);

  await new Promise((resolve, reject) => {
    streamSocket.connect(CAMERA_PORT, CAMERA_IP, resolve);
    streamSocket.on('error', reject);
  });

  // Stream login (301)
  const streamLoginPacket = Buffer.alloc(256, 0);
  streamLoginPacket.writeUInt32LE(301, 0);       // command
  streamLoginPacket.writeUInt32LE(DEVICE_ID, 4); // deviceId
  streamLoginPacket.writeUInt32LE(0, 8);         // unknown1
  streamLoginPacket.writeUInt16LE(20, 12);       // fps
  streamLoginPacket.writeUInt32LE(authTicket, 14); // authTicket
  streamLoginPacket.writeUInt32LE(0, 18);        // unknown3
  streamLoginPacket.writeUInt32LE(4097, 22);     // unknown4 (4096 + 1)
  streamLoginPacket.writeUInt32LE(1, 26);        // resolution

  streamSocket.write(streamLoginPacket);

  const streamLoginResp = await waitForData(streamSocket);
  if (!streamLoginResp || streamLoginResp.length < 8) {
    console.error('No stream login response');
    streamSocket.destroy();
    process.exit(1);
  }

  const streamRespV21 = streamLoginResp.readInt32LE(4);

  // Stream start (303)
  const streamStartPacket = Buffer.alloc(256, 0);
  streamStartPacket.writeUInt32LE(303, 0);
  streamStartPacket.writeUInt32LE(streamRespV21, 4);

  streamSocket.write(streamStartPacket);

  // Wait for stream to start
  await waitForData(streamSocket, 2000);

  // Send light command
  let lightCmd;
  switch(action) {
    case 'off':
      lightCmd = LIGHT_OFF;
      console.log('Sending LIGHT OFF');
      break;
    case 'auto':
      lightCmd = LIGHT_AUTO;
      console.log('Sending LIGHT AUTO');
      break;
    default:
      lightCmd = LIGHT_ON;
      console.log('Sending LIGHT ON');
  }

  streamSocket.write(lightCmd);

  // Keep connection open briefly
  await new Promise(r => setTimeout(r, 2000));

  console.log('Done!');
  streamSocket.destroy();
  process.exit(0);
}

const action = process.argv[2] || 'on';
controlLight(action).catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
