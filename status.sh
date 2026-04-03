#!/usr/bin/env bash
# WeChat Remote Control status indicator for Claude Code status line.
# Shows "💬 已连微信" when THIS CC session is the active WeChat target.
# Cross-platform: works on Linux (/proc) and macOS (ps).

BRIDGE_PID_FILE="$HOME/.wechat-bridge/bridge.pid"
CC_PID_FILE="$HOME/.wechat-bridge/cc_pid"

# 1. Bridge daemon must be running (use PID file — no /proc scanning)
[[ -f "$BRIDGE_PID_FILE" ]] || exit 0
BRIDGE_PID=$(cat "$BRIDGE_PID_FILE" 2>/dev/null | tr -d '[:space:]')
kill -0 "$BRIDGE_PID" 2>/dev/null || exit 0

# 2. Stored CC PID must exist
[[ -f "$CC_PID_FILE" ]] || exit 0
STORED_CC_PID=$(cat "$CC_PID_FILE" 2>/dev/null | tr -d '[:space:]')
[[ -z "$STORED_CC_PID" ]] && exit 0

# 3. Check if STORED_CC_PID is an ancestor of this process.
#    Cross-platform ppid: /proc on Linux, ps -o ppid= on macOS.
get_ppid() {
    if [[ -f "/proc/$1/status" ]]; then
        awk '/^PPid:/{print $2}' "/proc/$1/status" 2>/dev/null
    else
        ps -p "$1" -o ppid= 2>/dev/null | tr -d ' '
    fi
}

pid=$$
for _ in $(seq 1 12); do
    ppid=$(get_ppid "$pid")
    [[ -z "$ppid" || "$ppid" -le 1 ]] && break
    if [[ "$ppid" == "$STORED_CC_PID" ]]; then
        printf '💬 \033[32m已连微信\033[0m'
        exit 0
    fi
    pid=$ppid
done

exit 0
