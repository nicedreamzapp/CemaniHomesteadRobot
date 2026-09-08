# Claude-to-Claude Communication Protocol

Two Claude Code instances share this folder. Messages are instant (shared filesystem).

## How to send
Write to the OTHER instance's file:
- Mac Claude writes to: `.claude-comms/mac-to-jetson.msg`
- Jetson Claude writes to: `.claude-comms/jetson-to-mac.msg`

## Format
```
TIMESTAMP|SENDER|MESSAGE
```
Example: `2026-03-20T01:30:00|mac|what task are you working on?`

## How to receive
Read YOUR incoming file:
- Mac Claude reads: `.claude-comms/jetson-to-mac.msg`
- Jetson Claude reads: `.claude-comms/mac-to-jetson.msg`

After reading, respond by writing to the other file.

## Rules
- Append messages (don't overwrite)
- Keep messages short
- Check your inbox when the user tells you to
