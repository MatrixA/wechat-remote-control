---
name: wechat-remote-control
version: 2.0.0
description: |
  WeChat Remote Control for Claude Code. Three sub-commands:
  - login:  Authenticate WeChat account (scan QR code). Run once before first use
            or after session expiry.
  - attach: Register this Claude Code session as the WeChat remote target.
            Bridge daemon starts in background; it watches the CC session file
            and forwards assistant output to WeChat.
  - sync:   Show WeChat conversation history since last attach, for context.
  Use when stepping away from the terminal and handing off to WeChat.
allowed-tools:
  - Bash
  - Read
  - Edit
---

# /wechat-remote-control

Determine whether the user wants **login**, **attach**, or **sync**, then follow the steps below.

If the user just says `/wechat-remote-control` with no args, default to **attach**.

**Key principle:** When any step encounters a problem, fix it directly by running commands.
Never ask the user to copy-paste and run commands themselves — handle everything here.

---

## Architecture overview (for Claude's reference)

The wechat-bridge uses a **tmux-injection** model, bundled in this skill directory.

- **Bridge daemon** (`node src/index.js`): polls ilink WeChat API for messages, injects
  them into the user's tmux-hosted CC session via `tmux send-keys`.
- **Hook server**: listens on Unix socket `/tmp/cc_wechat_hook.sock`. CC hooks (PreToolUse,
  Stop, Notification) send events here via `hook.py`.
- **Response forwarding**: on Stop/Notification hook, reads CC transcript JSONL, finds the
  response to the injected WeChat message, and forwards it to WeChat. Terminal-initiated
  responses are NOT forwarded.
- **State**: `~/.cc_wechat/state.json` (tmux target, autoApprove, transcriptPath).
- **Accounts**: `~/.wechat-bridge/accounts/<accountId>.json`.
- **Logs**: `~/.wechat-bridge/logs/bridge-YYYY-MM-DD.log` (rotated, 30-day retention).

**Critical: process kill safety.** Do NOT use `pgrep -f` or `grep` with bridge path strings
in the same bash command that does other work. Claude Code wraps commands in `bash -c "..."`,
so the pattern matches the shell itself, causing self-termination. Always use the Python
`/proc` scanner shown below, in a **separate** bash call from the start command.

---

## login — Authenticate WeChat account

Run this once before first use, or whenever the bridge reports session expiry.

### Step 1: Check if already logged in

```bash
ls ~/.wechat-bridge/accounts/*.json 2>/dev/null | head -1
```

If account files exist, note them and ask the user whether they want to re-login
or if this was triggered by a session expiry. If they're just setting up fresh, proceed.

### Step 2: Fetch QR code

```bash
node --input-type=module -e "
  import { startQrLogin } from '$HOME/.claude/skills/wechat-remote-control/dist/wechat/login.js';
  const { qrcodeUrl, qrcodeId } = await startQrLogin();
  console.log(JSON.stringify({ qrcodeUrl, qrcodeId }));
"
```

Parse the JSON. Then generate and display the QR code in terminal:

```bash
npx --yes qrcode-terminal "<qrcodeUrl>" --small
```

If `npx` or `qrcode-terminal` fail, display the URL directly and tell the user to
open it in a browser or scan it with WeChat.

After displaying the QR, tell the user: "Please scan the QR code with WeChat and confirm..."

### Step 3: Wait for scan confirmation

```bash
node --input-type=module -e "
  import { waitForQrScan } from '$HOME/.claude/skills/wechat-remote-control/dist/wechat/login.js';
  const result = await waitForQrScan('<QRCODE_ID>');
  console.log(JSON.stringify({ status: 'confirmed', accountId: result.accountId }));
"
```

Replace `<QRCODE_ID>` with the `qrcodeId` from Step 2. Allow up to 3 minutes.
If it throws "expired", go back to Step 2 to refresh.

### Step 4: Verify and report

```bash
ls ~/.wechat-bridge/accounts/*.json 2>/dev/null
```

If no files: retry from Step 2. Otherwise confirm login success.

---

## attach — Register this session as WeChat remote target

### Step 1: Pre-flight checks (run all in one bash call)

```bash
echo "=== bridge installed ==="
test -f $HOME/.claude/skills/wechat-remote-control/src/index.js && echo "OK" || echo "NOT_FOUND"
echo "=== account ==="
ls ~/.wechat-bridge/accounts/*.json 2>/dev/null | head -1 || echo "NOT_FOUND"
echo "=== tmux ==="
echo "SESSION:$(tmux display-message -p '#S' 2>/dev/null); WINDOW:$(tmux display-message -p '#I' 2>/dev/null); PANE:$(tmux display-message -p '#P' 2>/dev/null)" || echo "NOT_IN_TMUX"
echo "=== existing attach ==="
cat ~/.cc_wechat/state.json 2>/dev/null || echo "{}"
```

**If bridge NOT_FOUND:** tell user bridge is not installed, stop.
**If account NOT_FOUND:** run **login** flow first, then continue.
**If NOT_IN_TMUX:** tell user they must run CC inside tmux. Stop.

### Step 2: Check for existing attach — prompt for override

If `state.json` shows `active: true` and `injectTarget` exists, show the user:

> "WeChat Remote Control is currently attached to tmux `<session>:<window>.<pane>`
>  (since <attachedAt>). Override with this session? [Y/n]"

Default: **Y** (override). If user says no, stop.

### Step 3: Write state.json

Detect the current tmux target and transcript path automatically:

```bash
SESSION=$(tmux display-message -p '#S')
WINDOW=$(tmux display-message -p '#I')
PANE=$(tmux display-message -p '#P')
CWD=$(pwd)
ENCODED=$(echo "$CWD" | sed 's|[^a-zA-Z0-9-]|-|g')
TRANSCRIPT=$(ls -t "$HOME/.claude/projects/$ENCODED"/*.jsonl 2>/dev/null | head -1)
python3 -c "
import json, os, time
state = {
    'injectTarget': {
        'session': '$SESSION',
        'window': '$WINDOW',
        'pane': '$PANE',
        'attachedAt': int(time.time() * 1000)
    },
    'autoApprove': True,
    'active': True,
    'transcriptPath': '$TRANSCRIPT'
}
os.makedirs(os.path.expanduser('~/.cc_wechat'), exist_ok=True)
with open(os.path.expanduser('~/.cc_wechat/state.json'), 'w') as f:
    json.dump(state, f, indent=2)
print('OK: target=' + '$SESSION:$WINDOW.$PANE')
"
```

### Step 4: Configure hooks in settings.json

Read `~/.claude/settings.json`. Merge the wechat-bridge hooks — do not overwrite other settings.

Target hooks config:
```json
{
  "hooks": {
    "PreToolUse": [{"matcher": "", "hooks": [{"type": "command", "command": "python3 $HOME/.claude/skills/wechat-remote-control/hook.py pretooluse"}]}],
    "Stop": [{"matcher": "", "hooks": [{"type": "command", "command": "python3 $HOME/.claude/skills/wechat-remote-control/hook.py stop"}]}],
    "Notification": [{"matcher": "", "hooks": [{"type": "command", "command": "python3 $HOME/.claude/skills/wechat-remote-control/hook.py notification"}]}]
  }
}
```

If hooks are already present with the same commands, skip this step.

### Step 5: Start/restart the bridge daemon

**Call 1 — kill existing** (separate bash call):

```bash
python3 -c "
import os, signal
me, parent = os.getpid(), os.getppid()
for p in os.listdir('/proc'):
    if not p.isdigit(): continue
    ip = int(p)
    if ip == me or ip == parent: continue
    try:
        cmd = open(f'/proc/{p}/cmdline','rb').read().decode()
        if 'node' in cmd and ('wechat-remote-control/src/index' in cmd or 'wechat-bridge/src/index' in cmd or 'wechat-bridge/dist/main' in cmd):
            os.kill(ip, signal.SIGTERM)
            print(f'Killed {ip}')
    except: pass
print('Done')
"
```

**Call 2 — start daemon** (separate bash call):

```bash
nohup node $HOME/.claude/skills/wechat-remote-control/src/index.js >> /tmp/cc_wechat_bridge.log 2>&1 &
echo "PID=$!"
```

**Call 3 — verify** (after ~3 seconds):

```bash
kill -0 <PID> 2>/dev/null && echo "running" || echo "FAILED"
```

If FAILED: read the last 30 lines of `/tmp/cc_wechat_bridge.log` and diagnose.

### Step 6: Report success

```
WeChat Remote Control activated

Tmux target: <session>:<window>.<pane>
Auto-approve: on
Bridge: running (PID <pid>)
Transcript: <transcript path>

You can leave the terminal now. WeChat messages will be injected into this
CC session via tmux. CC responses triggered by WeChat will be forwarded back.

Terminal-initiated responses are NOT forwarded to WeChat.
```

---

## sync — Show WeChat conversation history

### Step 1: Format and show history

```bash
python3 $HOME/.claude/skills/wechat-remote-control/format_history.py 2>/dev/null \
  || (tail -20 ~/.cc_wechat/history.jsonl 2>/dev/null || echo "No WeChat history found.")
```

If no history exists, check the bridge logs:

```bash
tail -50 ~/.wechat-bridge/logs/bridge-$(date +%Y-%m-%d).log 2>/dev/null | grep -E "INFO|WARN|ERROR" | tail -20
```

### Step 2: Summarize

Give a one-line summary of what happened while the user was away.
