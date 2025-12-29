// ============ ULTRASONIC SONAR DISPLAY ============
// Handles sonar wave visualization and distance display

let sonarTimeouts = { FL: null, FR: null, RL: null, RR: null };
let sonarHistory = { FL: [], FR: [], RL: [], RR: [] };
let sonarSmoothed = { FL: 0, FR: 0, RL: 0, RR: 0 };

function smoothReading(sensor, rawCm) {
  const history = sonarHistory[sensor];
  if (rawCm > 0) {
    history.push(rawCm);
    if (history.length > 3) history.shift();
  }
  if (history.length === 0) return 0;
  const avg = history.reduce((a, b) => a + b, 0) / history.length;
  if (Math.abs(avg - sonarSmoothed[sensor]) > 5 || sonarSmoothed[sensor] === 0) {
    sonarSmoothed[sensor] = avg;
  }
  return sonarSmoothed[sensor];
}

function parseSonarData(data) {
  const parts = data.split(',');
  if (parts.length < 5) return;

  const fl = parseFloat(parts[1]) || 0;
  const fr = parseFloat(parts[2]) || 0;
  const rl = parseFloat(parts[3]) || 0;
  const rr = parseFloat(parts[4]) || 0;

  updateSonarDisplay('FL', fl);
  updateSonarDisplay('FR', fr);
  updateSonarDisplay('RL', rl);
  updateSonarDisplay('RR', rr);

  // Update 3D view badges and cones
  updateUltrasonicBadges('FL', fl);
  updateUltrasonicBadges('FR', fr);
  updateUltrasonicBadges('RL', rl);
  updateUltrasonicBadges('RR', rr);

  if (window.lidar3dModule) {
    window.lidar3dModule.updateUltrasonic3D('FL', fl);
    window.lidar3dModule.updateUltrasonic3D('FR', fr);
    window.lidar3dModule.updateUltrasonic3D('RL', rl);
    window.lidar3dModule.updateUltrasonic3D('RR', rr);
  }
}

function updateSonarDisplay(sensor, distCm) {
  const labelEl = document.getElementById('dist' + sensor);
  const waveEl = document.getElementById('sonar' + sensor);
  if (!labelEl || !waveEl) return;

  distCm = smoothReading(sensor, distCm);

  let distFt = distCm > 0 ? (distCm / 30.48).toFixed(1) : '--';
  labelEl.textContent = distFt + 'ft';

  waveEl.classList.add('active');

  if (sonarTimeouts[sensor]) clearTimeout(sonarTimeouts[sensor]);
  sonarTimeouts[sensor] = setTimeout(() => {
    waveEl.classList.remove('active');
    labelEl.textContent = '-- ft';
  }, 2000);

  const waves = waveEl.querySelectorAll('.sonar-wave');

  waves.forEach(w => {
    w.classList.remove('triggered', 'color-red', 'color-pink', 'color-orange', 'color-yellow');
  });

  if (distCm > 0 && distCm < 160) {
    let colorClass = '';
    if (distCm < 45) colorClass = 'color-red';
    else if (distCm < 75) colorClass = 'color-pink';
    else if (distCm < 105) colorClass = 'color-orange';
    else colorClass = 'color-yellow';

    let triggerUpTo = Math.ceil(distCm / 15.24);
    if (triggerUpTo > 10) triggerUpTo = 10;
    if (triggerUpTo < 1) triggerUpTo = 1;

    for (let i = 1; i <= triggerUpTo; i++) {
      const wave = waveEl.querySelector('.w' + i);
      if (wave) {
        wave.classList.add('triggered', colorClass);
      }
    }
  }

  const posMap = { FL: 'front-left', FR: 'front-right', RL: 'rear-left', RR: 'rear-right' };
  waveEl.className = 'sonar-wave-group ' + posMap[sensor] + ' active';

  let labelColor = '';
  if (distCm <= 0) labelColor = '';
  else if (distCm < 60) labelColor = 'danger';
  else if (distCm < 120) labelColor = 'warning';
  else labelColor = 'clear';
  labelEl.className = 'sonar-dist-label ' + posMap[sensor] + '-label' + (labelColor ? ' ' + labelColor : '');

  // Update bar graph
  const barEl = document.getElementById('bar' + sensor);
  const readingEl = document.getElementById('reading' + sensor);
  if (barEl && readingEl) {
    const maxCm = 600;
    const pct = distCm > 0 ? Math.min((distCm / maxCm) * 100, 100) : 0;
    barEl.style.width = pct + '%';

    if (distCm <= 0) {
      barEl.style.background = 'rgba(100,100,100,0.3)';
      barEl.style.borderColor = '#666';
      barEl.style.boxShadow = 'none';
    } else if (distCm < 60) {
      barEl.style.background = 'linear-gradient(to top, #f33, rgba(255,50,50,0.3))';
      barEl.style.borderColor = '#f33';
      barEl.style.boxShadow = '0 0 8px #f33';
    } else if (distCm < 150) {
      barEl.style.background = 'linear-gradient(to top, #fc0, rgba(255,200,0,0.3))';
      barEl.style.borderColor = '#fc0';
      barEl.style.boxShadow = '0 0 8px #fc0';
    } else {
      barEl.style.background = 'linear-gradient(to top, #0c6, rgba(0,200,100,0.3))';
      barEl.style.borderColor = '#0c6';
      barEl.style.boxShadow = '0 0 8px #0c6';
    }

    readingEl.textContent = distCm > 0 ? (distCm / 30.48).toFixed(1) + 'ft' : '--';
  }
}

function updateUltrasonicBadges(sensor, distCm) {
  const badge = document.getElementById('usBadge' + sensor);
  if (!badge) return;
  const ft = distCm > 0 ? (distCm / 30.48).toFixed(1) : '--';
  badge.textContent = sensor + ': ' + ft + 'ft';
  badge.classList.remove('danger', 'warning');
  if (distCm > 0 && distCm < 50) badge.classList.add('danger');
  else if (distCm > 0 && distCm < 100) badge.classList.add('warning');
}

// Test function for console
window.testSonar = function(distCm) {
  console.log('[SONAR TEST] Testing with distance:', distCm, 'cm');
  updateSonarDisplay('FL', distCm);
  updateSonarDisplay('FR', distCm);
  updateSonarDisplay('RL', distCm);
  updateSonarDisplay('RR', distCm);
};

// Export module
window.sonarDisplayModule = {
  parseSonarData,
  updateSonarDisplay,
  updateUltrasonicBadges,
  getSmoothed: () => sonarSmoothed
};
