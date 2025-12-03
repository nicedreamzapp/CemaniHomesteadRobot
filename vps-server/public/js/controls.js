// ============ NAVIGATION CONTROL ============
let selectedDir = null;
let selectedDist = null;
let commandQueue = [];
let gridOffsetX = 0;
let gridOffsetY = 0;
let robotHeading = 0;

const dirLabels = { F: 'FWD', B: 'BACK', L: 'LEFT', R: 'RIGHT' };
const PIXELS_PER_FOOT = 13;  // Scaled for display
const FEET_TO_METERS = 0.3048;

function updateDisplay() {
  document.getElementById('currentDir').textContent = selectedDir ? dirLabels[selectedDir] : '--';

  document.querySelectorAll('.compass-dir').forEach(d => {
    d.style.background = 'rgba(0, 255, 136, 0.2)';
    d.style.color = '#00ff88';
  });
  if (selectedDir) {
    const el = document.getElementById('dir' + selectedDir);
    if (el) {
      el.style.background = '#00ff88';
      el.style.color = '#000';
    }
  }

  document.querySelectorAll('.dist-btn').forEach(d => {
    d.style.background = 'rgba(81, 207, 102, 0.2)';
    d.style.color = '#51cf66';
  });
  if (selectedDist) {
    document.querySelectorAll('.dist-btn').forEach(d => {
      if (parseFloat(d.dataset.dist) === selectedDist) {
        d.style.background = '#51cf66';
        d.style.color = '#000';
      }
    });
  }

  updateQueueDisplay();

  if (commandQueue.length > 0) {
    setStatus(commandQueue.length + ' command(s) queued - Press GO', 'idle');
  } else if (selectedDir && selectedDist) {
    setStatus(selectedDist + 'ft ' + dirLabels[selectedDir] + ' - Tap again to add, or GO', 'idle');
  } else if (selectedDir) {
    setStatus('Direction: ' + dirLabels[selectedDir] + ' - Now tap distance', 'idle');
  } else {
    setStatus('Tap direction, then distance', 'idle');
  }
}

function updateQueueDisplay() {
  const queueDiv = document.getElementById('cmdQueueDisplay');
  if (!queueDiv) return;

  if (commandQueue.length === 0) {
    queueDiv.innerHTML = '<span style="color:#666">No commands queued</span>';
    return;
  }

  let html = '';
  commandQueue.forEach((cmd, i) => {
    html += '<span class="cmd-chip">' + cmd.dist + 'ft ' + (dirLabels[cmd.dir] || cmd.dir) +
            ' <span class="remove" onclick="removeFromQueue(' + i + ')">&#215;</span></span>';
  });
  queueDiv.innerHTML = html;
}

function removeFromQueue(index) {
  commandQueue.splice(index, 1);
  updateDisplay();
}

function updateRadarRobot() {
  const robot = document.getElementById('radarRobot');
  const grid = document.getElementById('radarGrid');
  robot.style.transform = `translate(-50%, -50%) rotate(${robotHeading}deg)`;
  grid.style.transform = `translate(${-gridOffsetX}px, ${-gridOffsetY}px)`;
}

function setStatus(text, type) {
  const el = document.getElementById('moveStatus');
  el.textContent = text;
  el.className = 'move-status ' + (type || 'idle');
}

function selectDirection(dir) {
  selectedDir = dir;
  updateDisplay();
}

function selectDistance(distance) {
  if (!selectedDir) {
    setStatus('Tap a direction first!', 'error');
    return;
  }

  commandQueue.push({ dir: selectedDir, dist: distance });

  const serialDiv = document.getElementById('serial');
  serialDiv.innerHTML += '<span style="color:#74c0fc">[QUEUE] Added ' + distance + 'ft ' + dirLabels[selectedDir] + '</span><br>';
  serialDiv.scrollTop = serialDiv.scrollHeight;

  selectedDir = null;
  selectedDist = null;
  updateDisplay();
}

function executeQueue() {
  if (commandQueue.length === 0) {
    setStatus('No commands queued!', 'error');
    return;
  }

  const commands = [...commandQueue];
  commandQueue = [];

  const serialDiv = document.getElementById('serial');
  serialDiv.innerHTML += '<span style="color:#51cf66">[GO] Executing ' + commands.length + ' command(s)...</span><br>';
  serialDiv.scrollTop = serialDiv.scrollHeight;

  setStatus('EXECUTING ' + commands.length + ' commands...', 'moving');

  let currentIndex = 0;

  function executeNext() {
    if (currentIndex >= commands.length) {
      setStatus('Completed ' + commands.length + ' commands', 'idle');
      selectedDir = null;
      selectedDist = null;
      updateDisplay();
      return;
    }

    const cmd = commands[currentIndex];
    setStatus('Moving ' + (currentIndex + 1) + '/' + commands.length + ': ' + cmd.dist + 'ft ' + dirLabels[cmd.dir], 'moving');

    // Convert feet to meters for the robot command
    const distanceMeters = cmd.dist * FEET_TO_METERS;
    ws.send(JSON.stringify({
      type: 'move_command',
      distance: distanceMeters,
      direction: cmd.dir
    }));

    serialDiv.innerHTML += '<span style="color:#51cf66">[MOVE] ' + cmd.dist + 'ft ' + dirLabels[cmd.dir] + '</span><br>';
    serialDiv.scrollTop = serialDiv.scrollHeight;

    const movePixels = cmd.dist * PIXELS_PER_FOOT;
    const headingRad = robotHeading * Math.PI / 180;

    if (cmd.dir === 'F') {
      gridOffsetX += Math.sin(headingRad) * movePixels;
      gridOffsetY -= Math.cos(headingRad) * movePixels;
    } else if (cmd.dir === 'B') {
      gridOffsetX -= Math.sin(headingRad) * movePixels;
      gridOffsetY += Math.cos(headingRad) * movePixels;
    } else if (cmd.dir === 'L') {
      robotHeading -= 90;
    } else if (cmd.dir === 'R') {
      robotHeading += 90;
    }
    updateRadarRobot();

    let totalTime;
    if (cmd.dir === 'L' || cmd.dir === 'R') {
      totalTime = 90 * 100 + 500;
    } else {
      totalTime = cmd.dist * 100 * 200 + 500;
    }

    currentIndex++;
    setTimeout(executeNext, totalTime);
  }

  executeNext();
  updateDisplay();
}

function emergencyStop() {
  ws.send(JSON.stringify({ type: 'emergency_stop' }));
  selectedDir = null;
  selectedDist = null;
  commandQueue = [];
  updateDisplay();
  setStatus('STOPPED', 'error');

  const serialDiv = document.getElementById('serial');
  serialDiv.innerHTML += '<span style="color:#ff6b6b">[STOP] Emergency stop sent - queue cleared</span><br>';
  serialDiv.scrollTop = serialDiv.scrollHeight;
}

function clearQueue() {
  selectedDir = null;
  selectedDist = null;
  commandQueue = [];
  gridOffsetX = 0;
  gridOffsetY = 0;
  robotHeading = 0;
  updateRadarRobot();
  updateDisplay();
  setStatus('Cleared. Tap direction to start.', 'idle');

  const serialDiv = document.getElementById('serial');
  serialDiv.innerHTML += '<span style="color:#74c0fc">[CLEAR] Queue cleared, radar reset</span><br>';
  serialDiv.scrollTop = serialDiv.scrollHeight;
}

// Direction button handlers
document.getElementById('dirF').onclick = () => selectDirection('F');
document.getElementById('dirR').onclick = () => selectDirection('R');
document.getElementById('dirB').onclick = () => selectDirection('B');
document.getElementById('dirL').onclick = () => selectDirection('L');

// Distance button handlers
document.querySelectorAll('.dist-btn').forEach(btn => {
  btn.onclick = function() {
    selectDistance(parseFloat(this.dataset.dist));
  };
});

// Initialize display
updateDisplay();
updateRadarRobot();

function reset() {
  ws.send(JSON.stringify({type:'command', data:'reset'}));
  document.getElementById('serial').innerHTML = '[RESET]<br>';
  clearQueue();
  robotHeading = 0;
  updateRadarRobot();
}

// Serial command input
document.getElementById('cmd').onkeypress = function(e) {
  if(e.key === 'Enter') {
    ws.send(JSON.stringify({type:'command', data:e.target.value}));
    e.target.value = '';
  }
};

// ============ CODE EDITOR ============
let currentTab = 'esp32';

document.querySelectorAll('.tab').forEach(tab => {
  tab.onclick = function() {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    this.classList.add('active');
    currentTab = this.dataset.tab;
    document.getElementById('editor').placeholder = '// ' + currentTab.toUpperCase() + ' code...';
  };
});

document.getElementById('compileBtn').onclick = () => {
  const code = document.getElementById('editor').value;
  if (!code.trim()) {
    alert('Please enter some code first');
    return;
  }
  ws.send(JSON.stringify({type:'compile', target:currentTab, code:code}));
  document.getElementById('serial').innerHTML += '[COMPILING ' + currentTab.toUpperCase() + '...]<br>';
  document.getElementById('serial').scrollTop = document.getElementById('serial').scrollHeight;
};

document.getElementById('flashPrebuiltBtn').onclick = () => {
  if (!confirm('Flash pre-built Teensy firmware? Robot will reboot.')) return;
  ws.send(JSON.stringify({type:'flash_prebuilt'}));
  document.getElementById('serial').innerHTML += '[FLASHING PREBUILT TEENSY...]<br>';
  document.getElementById('serial').scrollTop = document.getElementById('serial').scrollHeight;
};
