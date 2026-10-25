# Security policy

## Reporting a vulnerability

Please do not open a public issue for security problems.

Report them privately through GitHub: go to the **Security** tab of this repo and click **Report a vulnerability** ([direct link](https://github.com/nicedreamzapp/CemaniHomesteadRobot/security/advisories/new)). Only the maintainer sees the report.

Helpful details: what you found, how to reproduce it, which commit, which part of the robot it affects (firmware, server, brain, Jetson services), and whether it could make the robot move.

I aim to reply within 3 days and to ship a fix or a clear plan within 30 days, depending on severity. You will be credited in the advisory unless you ask not to be.

## Supported versions

Fixes go into the latest code on `main`. Please update before reporting if you are on an older commit.

## What matters most here

The parts where a mistake could hurt someone:

- anything that can make the motors move: `teensy-robot/src/safety.cpp` and `movement.cpp`, the Xbox override in `esp32-robot-controller/`, and the movement commands in `robot-brain/brain.py`
- the control server in `vps-server/server.js`, which listens on `0.0.0.0:3001`, uses basic auth from `auth.json` and runs with no login if that file is missing
- firmware compile and flash over the network in `vps-server/compile.js` and `flash-teensy.js`
- the brain's HTTP API on port 5000 in `robot-brain/brain.py`, and `robot-brain/start.sh`, which fetches `ANTHROPIC_API_KEY` over SSH
- camera passwords and WiFi credentials in the gitignored `config.json` and `credentials.h` files
