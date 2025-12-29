// ============ 2D LIDAR THERMAL MAP DISPLAY ============
// Canvas-based LIDAR visualization with thermal colors

let lidarCanvas = null;
let lidarCtx = null;
let lidarLastPoints = [];
let lidarHistory = [];
const LIDAR_HISTORY_SIZE = 3;

function initLidarCanvas() {
  lidarCanvas = document.getElementById('lidarCanvas');
  if (!lidarCanvas) return false;

  const container = lidarCanvas.parentElement;
  const dpr = window.devicePixelRatio || 1;
  lidarCanvas.width = container.offsetWidth * dpr;
  lidarCanvas.height = container.offsetHeight * dpr;
  lidarCanvas.style.width = container.offsetWidth + 'px';
  lidarCanvas.style.height = container.offsetHeight + 'px';
  lidarCtx = lidarCanvas.getContext('2d');
  lidarCtx.scale(dpr, dpr);
  return true;
}

function getThermalColor(dist, maxDist) {
  const ratio = Math.min(dist / maxDist, 1);
  if (ratio < 0.15) {
    const t = ratio / 0.15;
    return `rgb(255, ${Math.floor(255 - t * 30)}, ${Math.floor(255 - t * 200)})`;
  } else if (ratio < 0.3) {
    const t = (ratio - 0.15) / 0.15;
    return `rgb(255, ${Math.floor(225 - t * 150)}, ${Math.floor(55 - t * 55)})`;
  } else if (ratio < 0.5) {
    const t = (ratio - 0.3) / 0.2;
    return `rgb(${Math.floor(255 - t * 50)}, ${Math.floor(75 - t * 75)}, ${Math.floor(t * 150)})`;
  } else if (ratio < 0.7) {
    const t = (ratio - 0.5) / 0.2;
    return `rgb(${Math.floor(205 - t * 155)}, 0, ${Math.floor(150 + t * 105)})`;
  } else {
    const t = (ratio - 0.7) / 0.3;
    return `rgb(${Math.floor(50 - t * 40)}, 0, ${Math.floor(255 - t * 200)})`;
  }
}

function drawLidarPoints(points) {
  if (!lidarCtx && !initLidarCanvas()) return;
  if (!points || points.length === 0) return;

  const container = lidarCanvas.parentElement;
  const dpr = window.devicePixelRatio || 1;
  const w = container.offsetWidth;
  const h = container.offsetHeight;

  if (Math.abs(lidarCanvas.width - w * dpr) > 5) {
    lidarCanvas.width = w * dpr;
    lidarCanvas.height = h * dpr;
    lidarCanvas.style.width = w + 'px';
    lidarCanvas.style.height = h + 'px';
    lidarCtx.scale(dpr, dpr);
  }

  const ctx = lidarCtx;
  const cx = w / 2;
  const cy = h / 2;
  const maxDist = 2500;
  const scale = Math.min(w, h) / 2 / maxDist * 0.9;

  lidarHistory.push(points);
  if (lidarHistory.length > LIDAR_HISTORY_SIZE) lidarHistory.shift();

  // Merge recent frames
  const angleMap = new Map();
  for (const frame of lidarHistory) {
    for (const [angle, dist] of frame) {
      const key = Math.round(angle);
      if (!angleMap.has(key) || dist < angleMap.get(key)) {
        angleMap.set(key, dist);
      }
    }
  }
  const mergedPoints = [];
  angleMap.forEach((dist, angle) => mergedPoints.push([angle, dist]));
  mergedPoints.sort((a, b) => a[0] - b[0]);

  ctx.clearRect(0, 0, w, h);

  if (mergedPoints.length > 2) {
    // Draw wall lines
    ctx.beginPath();
    let firstPoint = true;
    let lastX, lastY;

    for (let i = 0; i < mergedPoints.length; i++) {
      const [angle, dist] = mergedPoints[i];
      const rad = (angle - 90) * Math.PI / 180;
      const x = cx + dist * scale * Math.cos(rad);
      const y = cy + dist * scale * Math.sin(rad);

      if (firstPoint) {
        ctx.moveTo(x, y);
        firstPoint = false;
      } else {
        const dx = x - lastX;
        const dy = y - lastY;
        const screenDist = Math.sqrt(dx * dx + dy * dy);
        if (screenDist < 40) {
          ctx.lineTo(x, y);
        } else {
          ctx.moveTo(x, y);
        }
      }
      lastX = x;
      lastY = y;
    }

    ctx.strokeStyle = 'rgba(0, 255, 200, 0.9)';
    ctx.lineWidth = 3;
    ctx.shadowColor = '#00ffc8';
    ctx.shadowBlur = 8;
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Draw colored points
    for (const [angle, dist] of mergedPoints) {
      const rad = (angle - 90) * Math.PI / 180;
      const x = cx + dist * scale * Math.cos(rad);
      const y = cy + dist * scale * Math.sin(rad);

      let color, glowColor;
      if (dist < 400) {
        color = '#ff3030';
        glowColor = 'rgba(255, 50, 50, 0.8)';
      } else if (dist < 800) {
        color = '#ff8800';
        glowColor = 'rgba(255, 136, 0, 0.6)';
      } else if (dist < 1200) {
        color = '#ffcc00';
        glowColor = 'rgba(255, 200, 0, 0.4)';
      } else if (dist < 1800) {
        color = '#00dd66';
        glowColor = 'rgba(0, 220, 100, 0.3)';
      } else {
        color = '#00aaff';
        glowColor = 'rgba(0, 170, 255, 0.2)';
      }

      ctx.beginPath();
      ctx.arc(x, y, dist < 600 ? 5 : 3, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.shadowColor = glowColor;
      ctx.shadowBlur = dist < 600 ? 10 : 5;
      ctx.fill();
      ctx.shadowBlur = 0;

      if (dist < 500) {
        ctx.beginPath();
        ctx.arc(x, y, 8, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255, 50, 50, 0.3)';
        ctx.fill();
      }
    }
  }

  lidarLastPoints = mergedPoints;
}

// Export module
window.lidar2dModule = {
  initLidarCanvas,
  drawLidarPoints,
  getThermalColor,
  getLastPoints: () => lidarLastPoints
};
