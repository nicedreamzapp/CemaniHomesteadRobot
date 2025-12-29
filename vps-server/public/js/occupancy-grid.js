// ============ OCCUPANCY GRID MAPPING SYSTEM ============
// Smart mapping like a Roomba but better - remembers everywhere it goes

const OccupancyGrid = {
  // Grid settings
  cellSize: 0.10,  // 10cm per cell
  gridRadius: 50,  // 50 meters from origin = 100m x 100m map

  // Cell states
  UNKNOWN: 0,
  FREE: 1,
  OCCUPIED: 2,

  // Current map data
  currentMap: null,
  maps: {},  // Stored maps by name

  // Initialize a new map
  createMap: function(name, originX = 0, originY = 0, gpsLat = null, gpsLng = null) {
    const gridSize = Math.ceil((this.gridRadius * 2) / this.cellSize);

    const map = {
      name: name,
      created: Date.now(),
      updated: Date.now(),
      origin: { x: originX, y: originY },
      gps: gpsLat ? { lat: gpsLat, lng: gpsLng } : null,
      cellSize: this.cellSize,
      gridSize: gridSize,
      cells: {},  // Sparse storage: "x,y" -> { state, confidence, lastSeen, type }
      paths: {},  // Named paths: "to_kitchen" -> [{x,y}, ...]
      zones: {},  // Named zones: "kitchen" -> { cells: ["x,y", ...], type: "room" }
      stats: {
        totalCells: 0,
        freeCells: 0,
        occupiedCells: 0,
        distanceTraveled: 0
      }
    };

    this.maps[name] = map;
    this.currentMap = map;
    console.log(`[MAP] Created new map: ${name} (${gridSize}x${gridSize} cells, ${this.cellSize}m resolution)`);
    return map;
  },

  // Convert world coordinates to grid cell
  worldToGrid: function(worldX, worldY) {
    if (!this.currentMap) return null;
    const gx = Math.floor((worldX - this.currentMap.origin.x + this.gridRadius) / this.cellSize);
    const gy = Math.floor((worldY - this.currentMap.origin.y + this.gridRadius) / this.cellSize);
    return { gx, gy, key: `${gx},${gy}` };
  },

  // Convert grid cell to world coordinates (center of cell)
  gridToWorld: function(gx, gy) {
    if (!this.currentMap) return null;
    const wx = (gx * this.cellSize) - this.gridRadius + this.currentMap.origin.x + (this.cellSize / 2);
    const wy = (gy * this.cellSize) - this.gridRadius + this.currentMap.origin.y + (this.cellSize / 2);
    return { x: wx, y: wy };
  },

  // Mark a cell as free (robot traveled through it)
  markFree: function(worldX, worldY, confidence = 0.9) {
    if (!this.currentMap) return;
    const cell = this.worldToGrid(worldX, worldY);
    if (!cell) return;

    const existing = this.currentMap.cells[cell.key];
    if (!existing) {
      this.currentMap.cells[cell.key] = {
        state: this.FREE,
        confidence: confidence,
        lastSeen: Date.now(),
        visits: 1,
        type: 'floor'
      };
      this.currentMap.stats.totalCells++;
      this.currentMap.stats.freeCells++;
    } else if (existing.state === this.FREE) {
      // Increase confidence with more visits
      existing.confidence = Math.min(1.0, existing.confidence + 0.05);
      existing.lastSeen = Date.now();
      existing.visits++;
    } else if (existing.state === this.UNKNOWN) {
      existing.state = this.FREE;
      existing.confidence = confidence;
      existing.lastSeen = Date.now();
      this.currentMap.stats.freeCells++;
    }
    this.currentMap.updated = Date.now();
  },

  // Mark a cell as occupied (obstacle detected)
  markOccupied: function(worldX, worldY, obstacleType = 'obstacle', confidence = 0.8) {
    if (!this.currentMap) return;
    const cell = this.worldToGrid(worldX, worldY);
    if (!cell) return;

    const existing = this.currentMap.cells[cell.key];
    if (!existing) {
      this.currentMap.cells[cell.key] = {
        state: this.OCCUPIED,
        confidence: confidence,
        lastSeen: Date.now(),
        visits: 1,
        type: obstacleType
      };
      this.currentMap.stats.totalCells++;
      this.currentMap.stats.occupiedCells++;
    } else if (existing.state === this.OCCUPIED) {
      existing.confidence = Math.min(1.0, existing.confidence + 0.05);
      existing.lastSeen = Date.now();
      existing.visits++;
      if (obstacleType !== 'obstacle') existing.type = obstacleType;
    } else {
      // Was free, now occupied - obstacle appeared
      if (existing.state === this.FREE) this.currentMap.stats.freeCells--;
      existing.state = this.OCCUPIED;
      existing.confidence = confidence;
      existing.lastSeen = Date.now();
      existing.type = obstacleType;
      this.currentMap.stats.occupiedCells++;
    }
    this.currentMap.updated = Date.now();
  },

  // Process LIDAR scan and update map
  processLidarScan: function(robotX, robotY, robotHeading, lidarPoints) {
    if (!this.currentMap || !lidarPoints) return;

    // Mark robot's current position as free
    this.markFree(robotX, robotY, 1.0);

    // Also mark cells between robot and obstacles as free (ray casting)
    for (const [angle, distMm] of lidarPoints) {
      if (distMm < 50 || distMm > 6000) continue;  // Skip invalid readings

      const distM = distMm / 1000;
      const worldAngle = robotHeading + ((angle - 90) * Math.PI / 180);

      // Obstacle position
      const obsX = robotX + distM * Math.cos(worldAngle);
      const obsY = robotY + distM * Math.sin(worldAngle);

      // Mark obstacle
      this.markOccupied(obsX, obsY, distM < 1.5 ? 'wall' : 'obstacle');

      // Ray cast - mark cells between robot and obstacle as free
      const steps = Math.floor(distM / this.cellSize);
      for (let i = 1; i < steps; i++) {
        const t = i / steps;
        const fx = robotX + (obsX - robotX) * t;
        const fy = robotY + (obsY - robotY) * t;
        this.markFree(fx, fy, 0.7);
      }
    }
  },

  // Check if a position is traversable
  isTraversable: function(worldX, worldY) {
    if (!this.currentMap) return null;  // Unknown
    const cell = this.worldToGrid(worldX, worldY);
    if (!cell) return null;

    const data = this.currentMap.cells[cell.key];
    if (!data) return null;  // Unknown
    return data.state === this.FREE;
  },

  // Get cell info
  getCellInfo: function(worldX, worldY) {
    if (!this.currentMap) return null;
    const cell = this.worldToGrid(worldX, worldY);
    if (!cell) return null;
    return this.currentMap.cells[cell.key] || null;
  },

  // Save current map to JSON
  exportMap: function(name = null) {
    const map = name ? this.maps[name] : this.currentMap;
    if (!map) return null;
    return JSON.stringify(map);
  },

  // Load map from JSON
  importMap: function(jsonString) {
    try {
      const map = JSON.parse(jsonString);
      if (!map.name || !map.cells) throw new Error('Invalid map format');
      this.maps[map.name] = map;
      console.log(`[MAP] Imported map: ${map.name} (${map.stats.totalCells} cells)`);
      return map;
    } catch (e) {
      console.error('[MAP] Import failed:', e);
      return null;
    }
  },

  // Switch to a different map
  setCurrentMap: function(name) {
    if (this.maps[name]) {
      this.currentMap = this.maps[name];
      console.log(`[MAP] Switched to map: ${name}`);
      return true;
    }
    return false;
  },

  // Save path (series of waypoints)
  savePath: function(pathName, waypoints) {
    if (!this.currentMap) return false;
    this.currentMap.paths[pathName] = {
      created: Date.now(),
      waypoints: waypoints  // [{x, y}, ...]
    };
    console.log(`[MAP] Saved path: ${pathName} (${waypoints.length} points)`);
    return true;
  },

  // Define a zone
  saveZone: function(zoneName, cellKeys, zoneType = 'area') {
    if (!this.currentMap) return false;
    this.currentMap.zones[zoneName] = {
      created: Date.now(),
      cells: cellKeys,
      type: zoneType
    };
    console.log(`[MAP] Saved zone: ${zoneName} (${cellKeys.length} cells)`);
    return true;
  },

  // Get all cells for visualization
  getAllCells: function() {
    if (!this.currentMap) return [];
    const cells = [];
    for (const [key, data] of Object.entries(this.currentMap.cells)) {
      const [gx, gy] = key.split(',').map(Number);
      const world = this.gridToWorld(gx, gy);
      cells.push({
        key: key,
        gx: gx,
        gy: gy,
        x: world.x,
        y: world.y,
        state: data.state,
        confidence: data.confidence,
        type: data.type
      });
    }
    return cells;
  },

  // Get map stats
  getStats: function() {
    if (!this.currentMap) return null;
    return {
      name: this.currentMap.name,
      totalCells: this.currentMap.stats.totalCells,
      freeCells: this.currentMap.stats.freeCells,
      occupiedCells: this.currentMap.stats.occupiedCells,
      coverage: (this.currentMap.stats.totalCells * this.cellSize * this.cellSize).toFixed(1) + ' m²',
      paths: Object.keys(this.currentMap.paths).length,
      zones: Object.keys(this.currentMap.zones).length
    };
  },

  // Clear current map
  clearMap: function() {
    if (!this.currentMap) return;
    this.currentMap.cells = {};
    this.currentMap.paths = {};
    this.currentMap.zones = {};
    this.currentMap.stats = { totalCells: 0, freeCells: 0, occupiedCells: 0, distanceTraveled: 0 };
    this.currentMap.updated = Date.now();
    console.log(`[MAP] Cleared map: ${this.currentMap.name}`);
  },

  // Get list of all maps
  getMapList: function() {
    return Object.keys(this.maps).map(name => ({
      name: name,
      cells: this.maps[name].stats.totalCells,
      created: this.maps[name].created,
      updated: this.maps[name].updated,
      hasGPS: !!this.maps[name].gps
    }));
  }
};

// Auto-create default map on load
OccupancyGrid.createMap('default');

// Export
window.OccupancyGrid = OccupancyGrid;
