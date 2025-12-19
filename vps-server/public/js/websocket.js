// ============ DUAL WEBSOCKET ARCHITECTURE ============
const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
const ws = new WebSocket(wsProtocol + '//' + location.host);
ws.binaryType = 'arraybuffer';

// PTZ via /ptz path
let ptzWs = null;
let ptzConnected = false;

function connectPtzWs() {
  const ptzUrl = wsProtocol + '//' + location.host + '/ptz';
  ptzWs = new WebSocket(ptzUrl);

  ptzWs.onopen = () => {
    ptzConnected = true;
    ptzWs.send(JSON.stringify({ type: 'ptz_browser_hello' }));
  };

  ptzWs.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data.type === 'ptz_relay_status') {
        console.log('[PTZ] Relay:', data.connected ? 'OK' : 'DISCONNECTED');
      }
    } catch (err) {}
  };

  ptzWs.onclose = () => {
    ptzConnected = false;
    setTimeout(connectPtzWs, 2000);
  };

  ptzWs.onerror = () => {};
}

connectPtzWs();

// ============ AUDIO PLAYER ============
let audioContext = null;
let isMuted = false;   // Default to unmuted
let isMuted2 = false;  // Default to unmuted

function initAudio() {
  if (audioContext) return;
  audioContext = new (window.AudioContext || window.webkitAudioContext)();
}

async function playAudioChunk(data) {
  if (!audioContext) return;
  try {
    const audioBuffer = await audioContext.decodeAudioData(data.buffer.slice(0));
    const source = audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(audioContext.destination);
    source.start(0);
  } catch (err) {
    console.log('[AUDIO] Error playing chunk:', err);
  }
}

// ============ CAMERA PLAYERS ============
let cam1Image = null;
let cam2Image = null;
let cam3Image = null;  // V380 Light Bulb Cam
let cam1Active = false;
let cam2Active = false;
let cam3Active = false;
let v380LightState = -1;  // -1 = unknown, 0 = off, 1 = on, 2 = auto

function initCam1() {
  const container = document.getElementById('cam1-video');
  if (!cam1Image) {
    cam1Image = document.createElement('img');
    cam1Image.style.width = '100%';
    cam1Image.style.height = '100%';
    cam1Image.style.objectFit = 'contain';
    cam1Image.style.background = '#000';
    container.innerHTML = '';
    container.appendChild(cam1Image);
  }
}

function initCam2() {
  const container = document.getElementById('cam2-video');
  if (!cam2Image) {
    cam2Image = document.createElement('img');
    cam2Image.style.width = '100%';
    cam2Image.style.height = '100%';
    cam2Image.style.objectFit = 'contain';
    cam2Image.style.background = '#000';
    container.innerHTML = '';
    container.appendChild(cam2Image);
  }
}

function initCam3() {
  const container = document.getElementById('cam3-video');
  if (!container) return;
  if (!cam3Image) {
    cam3Image = document.createElement('img');
    cam3Image.style.width = '100%';
    cam3Image.style.height = '100%';
    cam3Image.style.objectFit = 'cover';  // Cover for circular crop
    cam3Image.style.background = '#000';
    container.innerHTML = '';
    container.appendChild(cam3Image);
  }
}

let pendingFrameUrl = { 1: null, 2: null, 3: null };

function displayFrame(blob, camId) {
  if (pendingFrameUrl[camId]) {
    URL.revokeObjectURL(pendingFrameUrl[camId]);
  }

  const url = URL.createObjectURL(blob);
  pendingFrameUrl[camId] = url;

  if (camId === 1) {
    if (!cam1Image) initCam1();
    cam1Image.src = url;
    cam1Image.onload = () => {
      URL.revokeObjectURL(url);
      if (pendingFrameUrl[1] === url) pendingFrameUrl[1] = null;
    };
    if (!cam1Active) {
      cam1Active = true;
      updateCamStatus(1, true, true);
    }
  } else if (camId === 2) {
    if (!cam2Image) initCam2();
    cam2Image.src = url;
    cam2Image.onload = () => {
      URL.revokeObjectURL(url);
      if (pendingFrameUrl[2] === url) pendingFrameUrl[2] = null;
    };
    if (!cam2Active) {
      cam2Active = true;
      updateCamStatus(2, true, true);
      updateJetsonStatus(true);
    }
  } else if (camId === 3) {
    if (!cam3Image) initCam3();
    if (cam3Image) {
      cam3Image.src = url;
      cam3Image.onload = () => {
        URL.revokeObjectURL(url);
        if (pendingFrameUrl[3] === url) pendingFrameUrl[3] = null;
      };
      if (!cam3Active) {
        cam3Active = true;
        updateCamStatus(3, true, true);
      }
    }
  }
}

function updateCamStatus(camId, connected, streaming) {
  const el = document.getElementById('cam' + camId + '-status');
  const txt = document.getElementById('cam' + camId + 'StatusText');
  const card = document.getElementById('cam' + camId + 'Card');

  if (!el) return;  // Element not found, skip update

  // V380 (cam3) keeps light-cam-live class for CSS targeting
  const badgeClass = (camId === 3) ? 'cam-status-badge light-cam-live' : 'cam-status-badge';

  if (streaming) {
    el.textContent = 'LIVE';
    el.className = badgeClass + ' live';
    el.style.background = '';  // Use CSS default (green)
    if (txt) txt.textContent = 'Live';
    if (card) card.className = 'device-chip online';
  } else {
    el.textContent = 'OFFLINE';
    el.className = badgeClass;
    el.style.background = '';  // Use CSS default (red)
    if (txt) txt.textContent = 'Offline';
    if (card) card.className = 'device-chip';
  }
}

function updateCam1Status(connected, streaming) {
  updateCamStatus(1, connected, streaming);
}

function updateJetsonStatus(online) {
  const statusEl = document.getElementById('jetsonStatus');
  const versionEl = document.getElementById('jetsonVersion');
  const cardEl = document.getElementById('jetsonCard');

  if (statusEl) statusEl.textContent = online ? 'Online' : 'Offline';
  if (cardEl) cardEl.className = 'device-chip' + (online ? ' online' : '');
  if (versionEl && online) versionEl.textContent = 'Ubuntu 22.04';
}

// ============ PTZ ============
const PTZ_SPEED = 1.0;
let ptzMoving = { 1: false, 2: false };

function sendPtz(data) {
  if (ptzWs && ptzWs.readyState === WebSocket.OPEN) {
    ptzWs.send(JSON.stringify(data));
    return true;
  }
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
    return false;
  }
  return false;
}

function ptzMove(camId, pan, tilt) {
  ptzMoving[camId] = true;
  sendPtz({ type: 'cam_ptz', camera: camId, action: 'move', pan, tilt, zoom: 0 });
}

function ptzStop(camId) {
  if (!ptzMoving[camId]) return;
  sendPtz({ type: 'cam_ptz', camera: camId, action: 'stop' });
  ptzMoving[camId] = false;
}

// Camera 1 PTZ - bind both old .ptz-btn and new PTZ pad elements
document.querySelectorAll('[data-ptz]').forEach(btn => {
  const action = btn.dataset.ptz;
  if (!action) return;

  btn.onmousedown = btn.ontouchstart = function(e) {
    e.preventDefault();
    switch(action) {
      case 'up': ptzMove(1, 0, PTZ_SPEED); break;
      case 'down': ptzMove(1, 0, -PTZ_SPEED); break;
      case 'left': ptzMove(1, -PTZ_SPEED, 0); break;
      case 'right': ptzMove(1, PTZ_SPEED, 0); break;
    }
  };
  btn.onmouseup = btn.ontouchend = btn.onmouseleave = function() {
    if (['up','down','left','right'].includes(action)) ptzStop(1);
  };
});

// Camera 2 PTZ
document.querySelectorAll('[data-ptz2]').forEach(btn => {
  const action = btn.dataset.ptz2;
  if (!action) return;

  btn.onmousedown = btn.ontouchstart = function(e) {
    e.preventDefault();
    switch(action) {
      case 'up': ptzMove(2, 0, PTZ_SPEED); break;
      case 'down': ptzMove(2, 0, -PTZ_SPEED); break;
      case 'left': ptzMove(2, -PTZ_SPEED, 0); break;
      case 'right': ptzMove(2, PTZ_SPEED, 0); break;
    }
  };
  btn.onmouseup = btn.ontouchend = btn.onmouseleave = function() {
    if (['up','down','left','right'].includes(action)) ptzStop(2);
  };
});

// ============ WEBSOCKET MESSAGE HANDLER ============
ws.onopen = () => {
  ws.send(JSON.stringify({type: 'get_status'}));
  setTimeout(() => { if (!cam1Active) initCam1(); }, 1000);
};

ws.onmessage = function(e) {
  // Binary frames
  if (e.data instanceof ArrayBuffer) {
    const data = new Uint8Array(e.data);
    if (data.length < 2) return;

    const packetType = data[0];
    const payload = data.slice(1);
    const cameraId = Math.floor(packetType / 2) + 1;
    const isVideo = packetType % 2 === 0;

    if (isVideo) {
      displayFrame(new Blob([payload], {type: 'image/jpeg'}), cameraId);
    } else {
      if (cameraId === 1 && !isMuted) {
        playAudioChunk(payload);
      } else if (cameraId === 2 && !isMuted2) {
        playAudioChunk(payload);
      }
    }
    return;
  }
  if (e.data instanceof Blob) {
    e.data.arrayBuffer().then(buffer => {
      const data = new Uint8Array(buffer);
      if (data.length < 2) return;
      const packetType = data[0];
      const payload = data.slice(1);
      const cameraId = Math.floor(packetType / 2) + 1;
      const isVideo = packetType % 2 === 0;
      if (isVideo) {
        displayFrame(new Blob([payload], {type: 'image/jpeg'}), cameraId);
      } else {
        // Audio packet
        if (cameraId === 2 && !isMuted2) {
          playAudioChunk(payload);
        } else if (cameraId === 1 && !isMuted) {
          playAudioChunk(payload);
        }
      }
    });
    return;
  }

  var d = JSON.parse(e.data);

  if(d.type === 'serial') {
    // Check if this is TELEM data and parse it (but don't display in serial monitor)
    var telemData = parseTelemFromSerial(d.data);
    if (telemData) {
      updateDriverTelemetry(telemData);
      return;  // Don't show TELEM in serial monitor - it's just noise
    }

    // Don't show TEENSY_VERSION in serial monitor either
    if (d.data && d.data.startsWith('TEENSY_VERSION,')) {
      return;
    }

    // Check for Xbox controller status from ESP32
    if (d.data && (d.data.includes('Xbox Connected') || d.data.includes('Xbox connected') || d.data.includes('XBOX_CONNECTED'))) {
      updateXboxStatus(true);
    }
    if (d.data && (d.data.includes('Xbox Disconnected') || d.data.includes('Xbox disconnected') || d.data.includes('XBOX_DISCONNECTED'))) {
      updateXboxStatus(false);
    }

    // Show other serial messages
    var serialDiv = document.getElementById('serial');
    serialDiv.innerHTML += d.data + '<br>';
    var lines = serialDiv.innerHTML.split('<br>');
    if (lines.length > 50) {
      serialDiv.innerHTML = lines.slice(-50).join('<br>');
    }
    serialDiv.scrollTop = serialDiv.scrollHeight;
  }

  if(d.type === 'status') {
    // Update header status indicator
    document.getElementById('status').textContent = d.connected ? 'ONLINE' : 'OFFLINE';
    document.getElementById('status').className = 'status-text ' + (d.connected ? 'online' : '');

    // Update status dot
    const statusDot = document.getElementById('statusDot');
    if (statusDot) {
      statusDot.className = 'status-dot ' + (d.connected ? 'online' : 'offline');
    }

    // Update mini status cards in header
    const esp32Mini = document.getElementById('esp32StatusMini');
    const teensyMini = document.getElementById('teensyStatusMini');
    if (esp32Mini) esp32Mini.textContent = d.connected ? 'OK' : '--';
    if (teensyMini) teensyMini.textContent = d.teensyConnected ? 'OK' : '--';

    // Update ESP32 status card
    document.getElementById('esp32Status').textContent = d.connected ? 'Online' : 'Offline';
    document.getElementById('esp32Card').className = 'device-chip' + (d.connected ? ' online' : '');

    // Update Teensy status card
    if(d.teensyConnected !== undefined) {
      document.getElementById('teensyStatus').textContent = d.teensyConnected ? 'Online' : 'Offline';
      document.getElementById('teensyCard').className = 'device-chip' + (d.teensyConnected ? ' online' : '');
    }
    if(d.teensyVersion) {
      document.getElementById('teensyVersion').textContent = 'v' + d.teensyVersion;
    }

    if(d.connected) {
      if(d.wifi && d.wifi !== 'unknown') document.getElementById('wifi').textContent = d.wifi;
      if(d.rssi) document.getElementById('rssi').textContent = d.rssi + ' dBm';
      if(d.ip && d.ip !== 'unknown') document.getElementById('ip').textContent = d.ip;
      if(d.version && d.version !== 'unknown') {
        document.getElementById('version').textContent = 'v' + d.version;
        // Also show ESP32 version on its card
        document.getElementById('esp32Version').textContent = 'v' + d.version;
      }
      if(d.uptime) {
        var mins = Math.floor(d.uptime / 60);
        document.getElementById('uptime').textContent = mins + 'm';
      }
    } else {
      document.getElementById('wifi').textContent = '--';
      document.getElementById('rssi').textContent = '--';
      document.getElementById('ip').textContent = '--';
      document.getElementById('version').textContent = '--';
      document.getElementById('uptime').textContent = '--';
    }

    if(d.camera) {
      updateCam1Status(d.camera.connected, d.camera.streaming);
      if(d.camera.streaming && !cam1Active) initCam1();
    }

    // Check for Xbox controller status from ESP32
    // If robot is disconnected, controller is also disconnected
    if(!d.connected) {
      updateXboxStatus(false);
    } else if(d.controller) {
      updateXboxStatus(d.controller === 'connected');
    }
  }

  if(d.type === 'camera_status') {
    updateCam1Status(d.connected, d.streaming);
    if(d.streaming && !cam1Active) initCam1();
  }

  if(d.type === 'camera_streams') {
    if(d.cameras) {
      if(d.cameras[1] && !d.cameras[1].streaming) {
        cam1Active = false;
        updateCamStatus(1, false, false);
      }
      if(d.cameras[2] && !d.cameras[2].streaming) {
        cam2Active = false;
        updateCamStatus(2, false, false);
        updateJetsonStatus(false);
      }
    }
  }

  // Driver telemetry
  if(d.type === 'telemetry' || d.type === 'driver_status' || d.type === 'teensy_telemetry') {
    updateDriverTelemetry(d);
  }

  // V380 music ended - reset button state
  if(d.type === 'v380_music_ended') {
    console.log('[MUSIC] Song ended, resetting button');
    musicPlaying = false;
    const btn = document.getElementById('musicBtn');
    if (btn) btn.classList.remove('playing');
  }
};

ws.onclose = () => {
  document.getElementById('status').textContent = 'DISCONNECTED';
  document.getElementById('status').className = 'status-text';

  // Update status dot
  const statusDot = document.getElementById('statusDot');
  if (statusDot) {
    statusDot.className = 'status-dot offline';
  }

  // Reset mini status cards
  const esp32Mini = document.getElementById('esp32StatusMini');
  const teensyMini = document.getElementById('teensyStatusMini');
  if (esp32Mini) esp32Mini.textContent = '--';
  if (teensyMini) teensyMini.textContent = '--';

  updateCam1Status(false, false);
  updateJetsonStatus(false);
};

// ============ AUDIO TOGGLE ============
function toggleMute() {
  initAudio();
  isMuted = !isMuted;
  const btn = document.getElementById("speakerBtn");
  if (isMuted) {
    btn.innerHTML = "&#128264;";
    btn.style.color = "#ff4444";
    btn.style.opacity = "0.5";
  } else {
    btn.innerHTML = "&#128266;";
    btn.style.color = "#44ff44";
    btn.style.opacity = "0.7";
  }
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({type: "audio_mute", muted: isMuted}));
  }
}

document.addEventListener('click', function() {
  initAudio();
}, { once: true });

function toggleMute2() {
  initAudio();
  isMuted2 = !isMuted2;
  const btn = document.getElementById("speakerBtn2");
  if (isMuted2) {
    btn.innerHTML = "🔇";
    btn.classList.add("muted");
  } else {
    btn.innerHTML = "🔊";
    btn.classList.remove("muted");
  }
  console.log('[AUDIO] Cam2 muted:', isMuted2);
}

// ============ V380 LIGHT CONTROL ============
function v380Light(state) {
  // state: 0 = off, 1 = on, 2 = auto
  v380LightState = state;
  console.log('[V380] Light command:', state, '(0=off, 1=on, 2=auto)');

  // Update button states if they exist
  const lightOnBtn = document.getElementById('lightOnBtn');
  const lightAutoBtn = document.getElementById('lightAutoBtn');
  const lightOffBtn = document.getElementById('lightOffBtn');
  if (lightOnBtn) lightOnBtn.classList.toggle('active', state === 1);
  if (lightAutoBtn) lightAutoBtn.classList.toggle('active', state === 2);
  if (lightOffBtn) lightOffBtn.classList.toggle('active', state === 0);

  // Send to server via WebSocket
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'v380_light', state: state }));
    console.log('[V380] Sent via WebSocket');
  } else {
    console.log('[V380] WebSocket not ready, state:', ws ? ws.readyState : 'null');
  }
}

// Initialize V380 cam on load
setTimeout(() => {
  if (!cam3Active) initCam3();
}, 1500);

// ============ V380 TALK (MIC) ============
let talkActive = false;
let mediaRecorder = null;
let audioStream = null;
let audioChunks = [];
let talkCountdown = 5;
let countdownInterval = null;
const MAX_TALK_SECONDS = 5;

function startTalk() {
  if (talkActive) return;
  talkActive = true;
  audioChunks = [];
  talkCountdown = MAX_TALK_SECONDS;

  const wrapper = document.querySelector('.mic-btn-wrapper');
  const countdownEl = document.getElementById('micCountdown');
  const hintEl = document.querySelector('.mic-hint');

  if (wrapper) wrapper.classList.add('recording');
  if (countdownEl) countdownEl.textContent = talkCountdown;
  if (hintEl) hintEl.textContent = 'Recording...';

  // Start countdown
  countdownInterval = setInterval(() => {
    talkCountdown--;
    if (countdownEl) countdownEl.textContent = talkCountdown;
    if (talkCountdown <= 0) {
      stopTalk();  // Auto-stop at 5 seconds
    }
  }, 1000);

  // Request microphone access
  navigator.mediaDevices.getUserMedia({ audio: true })
    .then(stream => {
      audioStream = stream;

      // Create MediaRecorder to capture audio
      const options = { mimeType: 'audio/webm;codecs=opus' };
      try {
        mediaRecorder = new MediaRecorder(stream, options);
      } catch (e) {
        mediaRecorder = new MediaRecorder(stream);
      }

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunks.push(event.data);
        }
      };

      mediaRecorder.onstop = () => {
        // Combine all chunks into one blob
        const audioBlob = new Blob(audioChunks, { type: mediaRecorder.mimeType });
        sendTalkAudio(audioBlob);
      };

      mediaRecorder.start(100);  // Collect chunks every 100ms
      console.log('[TALK] Started recording (max 5s)');
    })
    .catch(err => {
      console.error('[TALK] Mic access denied:', err);
      resetTalkUI();
    });
}

function stopTalk() {
  if (!talkActive) return;
  talkActive = false;

  // Stop countdown
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }

  // Stop recording
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }

  // Stop mic stream
  if (audioStream) {
    audioStream.getTracks().forEach(track => track.stop());
    audioStream = null;
  }

  console.log('[TALK] Stopped recording');
}

function sendTalkAudio(audioBlob) {
  const wrapper = document.querySelector('.mic-btn-wrapper');
  const countdownEl = document.getElementById('micCountdown');
  const hintEl = document.querySelector('.mic-hint');

  // Show sending state
  if (wrapper) {
    wrapper.classList.remove('recording');
    wrapper.classList.add('sending');
  }
  if (countdownEl) countdownEl.textContent = '...';
  if (hintEl) hintEl.textContent = 'Sending, expect delay...';

  console.log('[TALK] Sending audio blob:', audioBlob.size, 'bytes');

  // Convert blob to base64 and send
  const reader = new FileReader();
  reader.onloadend = () => {
    const base64data = reader.result.split(',')[1];  // Remove data:audio/webm;base64, prefix

    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'v380_talk_audio',
        audio: base64data,
        mimeType: audioBlob.type,
        volume: currentVolume
      }));
      console.log('[TALK] Audio sent to server');
    }

    // Reset UI after short delay
    setTimeout(resetTalkUI, 2000);
  };
  reader.readAsDataURL(audioBlob);
}

function resetTalkUI() {
  talkActive = false;
  const wrapper = document.querySelector('.mic-btn-wrapper');
  const countdownEl = document.getElementById('micCountdown');
  const hintEl = document.querySelector('.mic-hint');

  if (wrapper) {
    wrapper.classList.remove('recording');
    wrapper.classList.remove('sending');
  }
  if (countdownEl) countdownEl.textContent = '5';
  if (hintEl) hintEl.textContent = 'Hold to talk (5s max, expect delay)';
}

// ============ V380 MUSIC PLAYER ============
let musicPlaying = false;
let currentVolume = 25;

function playMusic() {
  musicPlaying = !musicPlaying;

  const btn = document.getElementById('musicBtn');
  if (btn) {
    if (musicPlaying) {
      btn.classList.add('playing');
    } else {
      btn.classList.remove('playing');
    }
  }

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'v380_music',
      action: musicPlaying ? 'play' : 'stop',
      volume: currentVolume
    }));
  }

  console.log('[MUSIC]', musicPlaying ? 'Playing' : 'Stopped', 'at', currentVolume + '%');
}

let volumeDebounceTimer = null;

function updateVolume(value) {
  currentVolume = parseInt(value);
  const volumeValue = document.getElementById('volumeValue');
  const volumeIcon = document.querySelector('.volume-icon');

  if (volumeValue) volumeValue.textContent = currentVolume + '%';

  // Update icon based on volume level
  if (volumeIcon) {
    if (currentVolume <= 10) {
      volumeIcon.textContent = '🔈';
    } else if (currentVolume <= 50) {
      volumeIcon.textContent = '🔉';
    } else {
      volumeIcon.textContent = '🔊';
    }
  }

  console.log('[VOLUME]', currentVolume + '%');
}

// Called when slider is released - volume will be used on next play
function applyVolume() {
  // Don't restart music while playing - just store volume for next play
  // This prevents glitchy audio from restarting the stream
  console.log('[VOLUME] Set to', currentVolume + '% (applies on next play)');
}
