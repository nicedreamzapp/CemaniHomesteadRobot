#!/bin/bash
# Install Mac Launcher Daemon as a LaunchAgent (auto-starts on login)

PLIST_NAME="com.cemani.mac-launcher.plist"
PLIST_PATH="$HOME/Library/LaunchAgents/$PLIST_NAME"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PYTHON_PATH="/usr/bin/python3"

# Check for Homebrew Python
if [ -f "/opt/homebrew/bin/python3" ]; then
    PYTHON_PATH="/opt/homebrew/bin/python3"
elif [ -f "/usr/local/bin/python3" ]; then
    PYTHON_PATH="/usr/local/bin/python3"
fi

echo "============================================"
echo "  Installing Mac Launcher Daemon"
echo "============================================"
echo "  Script: $SCRIPT_DIR/mac_launcher_daemon.py"
echo "  Python: $PYTHON_PATH"
echo "============================================"

# Create LaunchAgents directory if needed
mkdir -p "$HOME/Library/LaunchAgents"

# Create the plist file
cat > "$PLIST_PATH" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.cemani.mac-launcher</string>

    <key>ProgramArguments</key>
    <array>
        <string>$PYTHON_PATH</string>
        <string>-u</string>
        <string>$SCRIPT_DIR/mac_launcher_daemon.py</string>
    </array>

    <key>WorkingDirectory</key>
    <string>$SCRIPT_DIR</string>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>StandardOutPath</key>
    <string>/tmp/cemani-mac-launcher.log</string>

    <key>StandardErrorPath</key>
    <string>/tmp/cemani-mac-launcher.log</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    </dict>
</dict>
</plist>
EOF

echo ""
echo "Created: $PLIST_PATH"

# Unload if already loaded
launchctl unload "$PLIST_PATH" 2>/dev/null

# Load the daemon
launchctl load "$PLIST_PATH"

echo ""
echo "Daemon installed and started!"
echo ""
echo "Commands:"
echo "  View logs:    tail -f /tmp/cemani-mac-launcher.log"
echo "  Stop daemon:  launchctl unload $PLIST_PATH"
echo "  Start daemon: launchctl load $PLIST_PATH"
echo "  Uninstall:    rm $PLIST_PATH"
echo ""
echo "The daemon will now auto-start when you log in."
echo "Click START GPU in the web UI to begin mapping!"
