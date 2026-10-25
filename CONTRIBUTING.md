# Contributing

Thanks for taking a look. This is a hobby robot built around one set of hardware, so reports from
people who have built something similar are the most useful kind of help.

## Reporting a problem

Open an [issue](https://github.com/nicedreamzapp/CemaniHomesteadRobot/issues/new/choose). The things
that make it quick to look into:

- which part it is about (`teensy-robot`, `esp32-robot-controller`, `vps-server`, `robot-brain`,
  the Jetson folders or `mac-visualizer`)
- your hardware: board, motor driver, battery, sensors and cameras
- what the robot did, what you expected, and whether the Xbox controller could stop it
- serial output from the Teensy or ESP32, or the server or brain log around the time it happened

If the robot moved when it should not have, say so at the top of the issue.

## Running it locally

Read [CLAUDE.md](CLAUDE.md) and the safety notes before powering the motors. Keep the Xbox controller
within reach and keep your hands clear of the robot.

```bash
# Control server (listens on port 3001)
cd vps-server
npm install
cp auth.example.json auth.json   # set your own username and password
node server.js

# Robot brain (on the Jetson)
pip install -r robot-brain/requirements.txt
cd robot-brain && bash start.sh

# Firmware, after replacing the placeholders listed in the README
pio run -d teensy-robot
pio run -d esp32-robot-controller
```

The README's Setup section lists every placeholder (`YOUR_VPS_IP`, `YOUR_JETSON_IP`,
`YOUR_CAMERA_PASSWORD`, `config.example.json` files) you need to fill in first.

## Tests

There are no automated tests yet. Check changes by hand: build both firmware projects with `pio run`,
start the server and brain, and test movement with the wheels off the ground first. Confirm the Xbox
controller still stops the motors right away.

## Pull requests

Small and focused is easiest to review. Say what hardware you tested on. For big changes, open an
issue first so we can talk it through. Any change that touches motor commands, the watchdogs or the
Xbox override needs a clear note on how you tested it safely.

Please follow the [code of conduct](CODE_OF_CONDUCT.md).
