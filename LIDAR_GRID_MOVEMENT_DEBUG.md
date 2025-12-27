# LIDAR 3D Grid Movement Bug - Debug Log

## The Problem
The LIDAR 3D grid is supposed to move under the robot when the robot drives (robot-centric view where robot stays at center and world moves around it). **The grid does NOT visually move** even though all internal values show it should be moving.

## Evidence That It SHOULD Be Working
Console logs show:
- `[ANIM] z=0.75m, gridWorldZ=0.75m`
- `[ANIM] z=1.50m, gridWorldZ=1.50m`
- `[ANIM] z=5.01m, gridWorldZ=5.01m`
- Container position is being set correctly
- Grid world position matches container position
- Animation loop is running
- Render is being called

**But visually - NOTHING MOVES.**

## Architecture
- `lidar3dScene` - Three.js scene
- `lidar3dWorldContainer` - Group added to scene, contains grid and ground
- `lidar3dGrid` - GridHelper added to worldContainer
- `lidar3dRobot` - Robot model added directly to scene (stays at origin)
- Camera at (3, 4, 3) looking at origin
- OrbitControls targeting origin

When robot moves forward, `lidar3dWorldContainer.position.z` increases, which should make the grid slide backward under the robot (creating illusion robot moved forward).

## What We Tried (30+ Attempts)

### 1. Basic Position Updates
- Set `lidar3dWorldContainer.position.z = robotZ` in animation loop
- Added logging to confirm values are changing
- **Result:** Values change, no visual movement

### 2. Force Matrix Update
- Added `lidar3dWorldContainer.updateMatrixWorld(true)` after position change
- **Result:** No change

### 3. Force Render
- Added explicit `lidar3dRenderer.render(lidar3dScene, lidar3dCamera)` after position change
- **Result:** No change

### 4. odomState Scope Issues
- Changed `let odomState` to `var odomState`
- Added `window.odomState = odomState`
- Ensured animation loop reads from `window.odomState`
- **Result:** Values update correctly, no visual movement

### 5. Animation Loop Fighting
- Added `autoAnimRunning` flag to prevent normal loop from overriding test animations
- **Result:** No change

### 6. OrbitControls Interference
- Disabled OrbitControls during test: `lidar3dControls.enabled = false`
- **Result:** No change

### 7. Camera Following Container
- Verified camera is added to scene, NOT to worldContainer
- Camera should NOT move with container
- **Result:** Camera setup is correct

### 8. Test Functions Added
- `testGridMove(z)` - manually set container position from console
- `testOdomUpdate(yMM)` - simulate odometry update
- `testStop()` - resume normal operation
- **Result:** User couldn't test due to Brave browser console paste restriction

### 9. Auto Animation Test
- Added automatic animation that runs after page load
- Moves container from z=0 to z=5 over several seconds
- Adds diagonal movement (x sway) and rotation
- Changes grid color (rainbow effect) to prove animation is running
- **Result:** Animation runs (console proves it), NO visual movement

### 10. Added Red Test Box
- Created 1-meter red cube at z=-2 in worldContainer
- Should move with the container
- **Result:** Unknown if visible, user reported no movement

### 11. Diagnostic Logging
Added detailed scene structure verification:
```
[DIAG] Scene: EXISTS
[DIAG] Container: EXISTS
[DIAG] Grid: EXISTS
[DIAG] Container in scene: YES
[DIAG] Grid in container: YES
```
- **Result:** Structure is correct

### 12. Grid Color Change Test
- Animation changes grid color using HSL to create rainbow effect
- If grid exists and is rendering, color should change
- **Result:** Unknown - user didn't report on color changes

### 13. Clickable TEST GRID Button (v50)
- Added yellow "TEST GRID" button to page (no console needed)
- Added green debug display showing Container Z/X values in real-time
- Moves grid back and forth (-3m to +3m) for 4 cycles
- **Result:** User said "still not working" - unclear if values changed

### 14. Dead Reckoning Direct Update
- When `dead_reckoning` message received, immediately update container position
- Don't wait for animation loop
- **Result:** No visual change

### 15. Sign/Direction Checks
- Verified: robot forward = +Y in odom = +Z in Three.js
- Container.z = +robotZ should move grid backward (correct for robot-centric)
- **Result:** Math appears correct

## Files Modified
- `vps-server/public/js/websocket.js` (v50)
- `vps-server/public/index.html` (added TEST GRID button and debug display)

## Current State (v50)
- Yellow "TEST GRID" button in 3D view header
- Green debug box showing Container Z/X values
- Test runs 4 cycles moving grid -3m to +3m
- All test infrastructure in place

## What To Try Next

### 1. Verify Basic Three.js Rendering
Run in browser console (type "allow pasting" first in Brave):
```javascript
// Check if scene has the container
console.log('Scene children:', lidar3dScene.children.map(c => c.type));

// Check container children
console.log('Container children:', lidar3dWorldContainer.children.map(c => c.type));

// Check if grid material is visible
console.log('Grid visible:', lidar3dGrid.visible);
console.log('Grid material:', lidar3dGrid.material);
```

### 2. Try Moving Camera Instead
Instead of moving container, test moving camera:
```javascript
lidar3dCamera.position.z += 1;
```
If camera movement works but container movement doesn't, the issue is with how the container is set up.

### 3. Create Fresh Test Object
Add a simple cube directly to the scene (not container) and try moving it:
```javascript
const testGeom = new THREE.BoxGeometry(1, 1, 1);
const testMat = new THREE.MeshBasicMaterial({ color: 0xff0000 });
const testCube = new THREE.Mesh(testGeom, testMat);
testCube.position.set(0, 0.5, 0);
lidar3dScene.add(testCube);
// Then try: testCube.position.z = 2;
```

### 4. Check Three.js Version
The project loads Three.js from CDN. Check if there's a version mismatch:
```javascript
console.log('THREE.REVISION:', THREE.REVISION);
```

### 5. Check Renderer Canvas
```javascript
console.log('Renderer domElement:', lidar3dRenderer.domElement);
console.log('Canvas size:', lidar3dRenderer.domElement.width, lidar3dRenderer.domElement.height);
```

### 6. Simplify - Remove Everything Else
Create a minimal test scene with ONLY:
- Scene
- Camera
- Renderer
- One grid
- Move the grid

If this works, add things back one by one to find what breaks it.

### 7. Check for CSS/DOM Issues
The canvas might be covered by another element or have CSS that clips it:
```javascript
const canvas = document.querySelector('#lidar3dContainer canvas');
console.log('Canvas style:', getComputedStyle(canvas));
```

### 8. Check if Multiple Renderers Exist
```javascript
document.querySelectorAll('canvas').forEach((c, i) => {
  console.log('Canvas', i, c.parentElement.id, c.width, c.height);
});
```

## Key Questions Still Unanswered
1. Does the debug display show values changing when TEST GRID is clicked?
2. Does the grid color change during animation (proves grid is being rendered)?
3. Does the red test box appear at all?
4. Are there any console errors?

## The Mystery
This is a bizarre bug because:
- Position values ARE changing (proven by console logs)
- Scene structure IS correct (proven by diagnostics)
- Render IS being called (explicit calls added)
- But NO visual change occurs

Possible explanations:
1. Something is overwriting position every frame that we haven't found
2. The grid/container we're modifying isn't the one being rendered
3. CSS/DOM issue hiding the movement
4. Three.js bug with this specific configuration
5. OrbitControls or something resetting the view

## Summary
We've exhausted most obvious causes. Next session should focus on:
1. Verifying the debug display works (shows changing values)
2. Creating an isolated minimal test to prove Three.js CAN move objects
3. If minimal test works, binary search to find what's breaking it
