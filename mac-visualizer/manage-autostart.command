#!/bin/bash
# ============================================
# MANAGE AUTO-START FOR DEPTH PROCESSOR
# ============================================

PLIST="$HOME/Library/LaunchAgents/com.cemani.depth-processor.plist"

echo "=========================================="
echo "  DEPTH PROCESSOR AUTO-START MANAGER"
echo "=========================================="
echo ""

# Check current status
if launchctl list | grep -q "com.cemani.depth-processor"; then
    echo "Status: AUTO-START is ENABLED"
else
    echo "Status: AUTO-START is DISABLED"
fi

echo ""
echo "Options:"
echo "  1) Enable auto-start on login"
echo "  2) Disable auto-start"
echo "  3) Start depth processor now"
echo "  4) Stop depth processor"
echo "  5) View logs"
echo "  6) Exit"
echo ""
read -p "Choose option (1-6): " choice

case $choice in
    1)
        # Enable RunAtLoad
        /usr/libexec/PlistBuddy -c "Set :RunAtLoad true" "$PLIST" 2>/dev/null
        /usr/libexec/PlistBuddy -c "Set :KeepAlive true" "$PLIST" 2>/dev/null
        launchctl load "$PLIST" 2>/dev/null
        echo "Auto-start ENABLED. Will start on login."
        ;;
    2)
        launchctl unload "$PLIST" 2>/dev/null
        /usr/libexec/PlistBuddy -c "Set :RunAtLoad false" "$PLIST" 2>/dev/null
        /usr/libexec/PlistBuddy -c "Set :KeepAlive false" "$PLIST" 2>/dev/null
        echo "Auto-start DISABLED."
        ;;
    3)
        launchctl load "$PLIST" 2>/dev/null
        launchctl start com.cemani.depth-processor
        echo "Started depth processor. Check /tmp/depth-processor.log for output."
        ;;
    4)
        launchctl stop com.cemani.depth-processor 2>/dev/null
        pkill -f depth_processor.py
        echo "Stopped depth processor."
        ;;
    5)
        echo ""
        echo "=== Recent Output ==="
        tail -30 /tmp/depth-processor.log 2>/dev/null || echo "No logs yet"
        echo ""
        echo "=== Recent Errors ==="
        tail -10 /tmp/depth-processor.error.log 2>/dev/null || echo "No errors"
        ;;
    6)
        exit 0
        ;;
    *)
        echo "Invalid option"
        ;;
esac

echo ""
read -p "Press Enter to close..."
