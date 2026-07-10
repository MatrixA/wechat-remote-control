#!/usr/bin/env bash
# WeChat Remote Control status indicator for Claude Code status line.
# Multi-session aware: shows the indicator in EVERY tmux session registered in
# sessions.json, not just the single stored cc_pid target:
#   💬 已连微信/TG (遥控中)      — this session is the active remote target
#   💬 已连微信/TG (#sw 可切入)  — registered; the IM can switch to it
# Shows "⚠️ 会话过期" when the IM backend session needs re-login.
# Falls back to the legacy cc_pid ancestor check outside tmux.
# Cross-platform: works on Linux (/proc) and macOS (ps).

D="$HOME/.wechat-remote-control"
BRIDGE_PID_FILE="$D/bridge.pid"
CC_PID_FILE="$D/cc_pid"
STATE_FILE="$D/state.json"
SESSIONS_FILE="$D/sessions.json"

# 1. Bridge daemon must be running (use PID file — no /proc scanning)
[[ -f "$BRIDGE_PID_FILE" ]] || exit 0
BRIDGE_PID=$(cat "$BRIDGE_PID_FILE" 2>/dev/null | tr -d '[:space:]')
kill -0 "$BRIDGE_PID" 2>/dev/null || exit 0

# 2. Transport label from the daemon's environment (explicit WCC_TRANSPORT only;
#    empty/absent falls back to the WeChat label, matching the daemon's default).
LABEL="微信"
if [[ -r "/proc/$BRIDGE_PID/environ" ]]; then
    tr '\0' '\n' < "/proc/$BRIDGE_PID/environ" 2>/dev/null | grep -qx 'WCC_TRANSPORT=telegram' && LABEL="TG"
else
    ps -p "$BRIDGE_PID" -wwE 2>/dev/null | grep -q 'WCC_TRANSPORT=telegram' && LABEL="TG"
fi

expired() {
    [[ -f "$STATE_FILE" ]] && grep -q '"sessionExpired": *true' "$STATE_FILE" 2>/dev/null
}

show() {  # $1 = role: active | registered
    if expired; then
        printf '⚠️  \033[31m%s会话过期\033[0m \033[2m(运行 /wechat-remote-control 重连)\033[0m' "$LABEL"
    elif [[ "$1" == "active" ]]; then
        printf '💬 \033[32m已连%s (遥控中)\033[0m' "$LABEL"
    else
        printf '💬 \033[32m已连%s\033[0m \033[2m(#sw 可切入)\033[0m' "$LABEL"
    fi
}

# 3. Multi-session path: match this pane's tmux target against sessions.json.
if [[ -n "$TMUX_PANE" ]] && command -v tmux >/dev/null 2>&1 && [[ -f "$SESSIONS_FILE" ]]; then
    TARGET=$(tmux display-message -p -t "$TMUX_PANE" '#{session_name}:#{window_index}.#{pane_index}' 2>/dev/null)
    if [[ -n "$TARGET" ]]; then
        ROLE=$(WRC_TARGET="$TARGET" python3 - <<'PY' 2>/dev/null
import json, os
d = json.load(open(os.path.expanduser('~/.wechat-remote-control/sessions.json')))
t = os.environ['WRC_TARGET']
for name, s in (d.get('sessions') or {}).items():
    if s.get('tmux') == t:
        print('active' if d.get('active') == name else 'registered')
        break
PY
)
        [[ -n "$ROLE" ]] && show "$ROLE"
        exit 0
    fi
fi

# 4. Legacy fallback (no tmux env / no registry): stored CC PID must be an
#    ancestor of this process.
[[ -f "$CC_PID_FILE" ]] || exit 0
STORED_CC_PID=$(cat "$CC_PID_FILE" 2>/dev/null | tr -d '[:space:]')
[[ -z "$STORED_CC_PID" ]] && exit 0

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
        show active
        exit 0
    fi
    pid=$ppid
done

exit 0
