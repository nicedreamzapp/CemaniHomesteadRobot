# URGENT: LIDAR Grid Movement Bug - START HERE

## IMMEDIATE ACTION REQUIRED
When this project opens, **immediately read `LIDAR_GRID_MOVEMENT_DEBUG.md`** and continue debugging the grid movement issue. The user has been working on this for 2+ days.

## The Problem (Summary)
The 3D LIDAR grid should move under the robot when it drives. Console logs show position values ARE changing, but the grid does NOT visually move. This is a bizarre Three.js rendering mystery.

## Current State (v50)
- Yellow "TEST GRID" button added to 3D view
- Green debug display shows Container Z/X values
- All test infrastructure is deployed to VPS
- 15+ debugging attempts documented in `LIDAR_GRID_MOVEMENT_DEBUG.md`

## Next Steps
1. Read `LIDAR_GRID_MOVEMENT_DEBUG.md` for full context
2. Ask user: "When you click TEST GRID, do the numbers in the green debug box change?"
3. If yes (numbers change but no visual) → Three.js rendering issue
4. If no (numbers don't change) → JavaScript execution issue
5. Follow the "What To Try Next" section in the debug doc

## Key Files
- `vps-server/public/js/websocket.js` - 3D LIDAR visualization (lines 920-1700)
- `vps-server/public/index.html` - UI with TEST GRID button
- `LIDAR_GRID_MOVEMENT_DEBUG.md` - Full debug documentation
