const WebSocket = require('ws');
const ws = new WebSocket('wss://robot.marijuanaunion.com');

ws.on('open', () => {
  console.log('Connected, sending flash_prebuilt command...');
  ws.send(JSON.stringify({type: 'flash_prebuilt'}));
});

ws.on('message', (data) => {
  const msg = data.toString();
  if (msg.includes('FLASH') || msg.includes('HEX') || msg.includes('VERSION') || msg.includes('progress') || msg.includes('serial')) {
    console.log('MSG:', msg.substring(0, 400));
  }
});

ws.on('error', (e) => console.log('Error:', e.message));

setTimeout(() => {
  console.log('\nFlash command sent! Check VPS logs for progress.');
  process.exit(0);
}, 60000);
