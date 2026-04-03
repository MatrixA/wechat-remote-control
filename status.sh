#!/usr/bin/env bash
# WeChat Remote Control status indicator for Claude Code status line.
# Prints "💬 已连微信" (green) only when THIS specific CC session is attached to WeChat.
# Detection: walks up the process tree to find the 'claude' ancestor, compares with cc_pid.

BRIDGE_JSON="$HOME/.wechat-bridge/bridge.json"

# 1. Bridge config must exist
[[ -f "$BRIDGE_JSON" ]] || exit 0

# 2. Bridge daemon must be running
found=0
for cmdline_file in /proc/*/cmdline; do
    if tr '\0' ' ' < "$cmdline_file" 2>/dev/null | grep -q "wechat-remote-control"; then
        found=1; break
    fi
done
[[ "$found" -eq 1 ]] || exit 0

# 3. Walk up the process tree to find the 'claude' ancestor PID
CC_PID_FILE="$HOME/.wechat-bridge/cc_pid"
[[ -f "$CC_PID_FILE" ]] || exit 0
BRIDGE_PID=$(cat "$CC_PID_FILE" 2>/dev/null | tr -d '[:space:]')
[[ -z "$BRIDGE_PID" ]] && exit 0

pid=$$
cc_ancestor=""
for _ in $(seq 1 10); do
    ppid=$(awk '/^PPid:/{print $2}' "/proc/$pid/status" 2>/dev/null)
    [[ -z "$ppid" || "$ppid" -le 1 ]] && break
    cmd=$(tr '\0' ' ' < "/proc/$ppid/cmdline" 2>/dev/null)
    if echo "$cmd" | grep -qE "^claude( |$)"; then
        cc_ancestor=$ppid
        break
    fi
    pid=$ppid
done

[[ "$cc_ancestor" == "$BRIDGE_PID" ]] || exit 0

printf '💬 \033[32m已连微信\033[0m'
