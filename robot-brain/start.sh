#!/bin/bash
# Start the Robot Brain
cd "$(dirname "$0")"

# Load API key from VPS (cached locally)
KEY_CACHE="$HOME/.robot-brain-env"
if [ ! -f "$KEY_CACHE" ] || [ "$(find "$KEY_CACHE" -mtime +7 2>/dev/null)" ]; then
    echo "[BRAIN] Fetching API key from VPS..."
    KEY=$(ssh -o ConnectTimeout=5 root@YOUR_VPS_IP "grep ANTHROPIC_API_KEY /root/.env" 2>/dev/null)
    if [ -n "$KEY" ]; then
        echo "$KEY" > "$KEY_CACHE"
        chmod 600 "$KEY_CACHE"
        echo "[BRAIN] API key cached"
    fi
fi

if [ -f "$KEY_CACHE" ]; then
    export $(cat "$KEY_CACHE" | head -1)
fi

echo "[BRAIN] Starting robot brain..."
exec python3 brain.py
