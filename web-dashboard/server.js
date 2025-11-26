const express = require('express');
const WebSocket = require('ws');
const http = require('http');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static('public'));

let robotSocket = null;

wss.on('connection', (ws, req) => {
  ws.on('message', msg => {
    const data = JSON.parse(msg);
    if(data.type==='robot_hello'){ robotSocket=ws; ws.isRobot=true; broadcast({type:'status',connected:true}); }
    if(data.type==='serial' && ws.isRobot) broadcast({type:'serial',data:data.data}, ws);
    if(data.type==='command' && robotSocket) robotSocket.send(JSON.stringify({type:'command',data:data.data}));
  });
  ws.on('close', () => { if(ws.isRobot){ robotSocket=null; broadcast({type:'status',connected:false}); }});
});

function broadcast(d, skip=null){ wss.clients.forEach(c=>{ if(c!==skip && c.readyState===WebSocket.OPEN) c.send(JSON.stringify(d)); }); }

server.listen(3001, '0.0.0.0', () => console.log('Robot server on port 3001'));
