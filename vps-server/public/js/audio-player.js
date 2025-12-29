// ============ AUDIO PLAYER ============
// Handles Web Audio API for camera audio streams

let audioContext = null;
let isMuted = false;
let isMuted2 = true;  // Default MUTED

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

function toggleMute() {
  initAudio();
  isMuted = !isMuted;
  const btn = document.getElementById("speakerBtn");
  if (btn) {
    if (isMuted) {
      btn.innerHTML = "&#128264;";
      btn.style.color = "#ff4444";
      btn.style.opacity = "0.5";
    } else {
      btn.innerHTML = "&#128266;";
      btn.style.color = "#44ff44";
      btn.style.opacity = "0.7";
    }
  }
  if (typeof ws !== 'undefined' && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "audio_mute", muted: isMuted }));
  }
}

function toggleMute2() {
  initAudio();
  isMuted2 = !isMuted2;
  const btn = document.getElementById("speakerBtn2");
  if (btn) {
    if (isMuted2) {
      btn.innerHTML = "🔇";
      btn.classList.add("muted");
    } else {
      btn.innerHTML = "🔊";
      btn.classList.remove("muted");
    }
  }
  console.log('[AUDIO] Cam2 muted:', isMuted2);
}

// Auto-init on first click
document.addEventListener('click', function() {
  initAudio();
}, { once: true });

// Export module
window.audioPlayerModule = {
  initAudio,
  playAudioChunk,
  toggleMute,
  toggleMute2,
  isMuted: () => isMuted,
  isMuted2: () => isMuted2
};
