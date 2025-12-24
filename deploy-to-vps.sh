#!/bin/bash
# Deploy VPS server files to robot.marijuanaunion.com
# Run from a machine with SSH access to root@72.60.124.34

VPS="root@72.60.124.34"
SRC="$(dirname "$0")/vps-server/public"
DST="/root/vps-server/public"

echo "Deploying to VPS..."
scp "$SRC/index.html" "$VPS:$DST/"
scp "$SRC/css/styles.css" "$VPS:$DST/css/"
scp "$SRC/js/websocket.js" "$VPS:$DST/js/"
scp "$SRC/lidar-3d.html" "$VPS:$DST/"
echo "Restarting server..."
ssh "$VPS" "pm2 restart robot && pm2 logs robot --lines 5 --nostream"
echo "Done! View at https://robot.marijuanaunion.com"
