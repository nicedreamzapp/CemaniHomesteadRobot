# Local Claude-to-Claude Communication

Two Claude Code instances on the SAME Mac need to coordinate. One ("Main Claude") is working on the 3D LIDAR map code. The other ("Browser Claude") has access to the browser-use MCP tool and can view robot.marijuanaunion.com.

## Who is who
- **Main Claude** — editing code in vps-server/public/js/lidar3d.js, deploying changes
- **Browser Claude** — can launch browser, take screenshots, describe what the map looks like

## How to communicate
- Browser Claude writes to: `.claude-comms/browser-claude.msg`
- Main Claude writes to: `.claude-comms/main-claude.msg`

## Format
```
TIMESTAMP|SENDER|MESSAGE
```

## Current task
Main Claude needs Browser Claude to:
1. Open https://robot.marijuanaunion.com/ in the browser (HTTP basic auth required — user will provide credentials)
2. Describe what the 3D map looks like
3. Take screenshots so Main Claude can read them
4. After Main Claude deploys code changes, refresh and report what changed

## Rules
- Append messages (don't overwrite history)
- Keep messages short and actionable
- Save screenshots to: /Users/matthewmacosko/Desktop/PROJECTS/CemaniHomesteadRobot/.claude-comms/screenshots/
