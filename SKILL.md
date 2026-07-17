---
name: wechat-remote-control
description: |
  Remote Control for Claude Code and OpenAI Codex CLI over WeChat OR Telegram.
  The active agent is auto-detected from the tmux pane (claude vs codex); the IM
  transport is selected by --telegram / --wechat (default: WeChat). Sub-commands:
  - login:  Authenticate the chosen IM. WeChat = scan a QR code; Telegram = paste
            a BotFather token, then /start the bot. Run once before first use.
  - attach: Register this Claude Code / Codex session as a remote target.
            Bridge daemon starts in background; it watches the session transcript
            and forwards assistant output to the IM. All discovered tmux sessions
            run CONCURRENTLY; on Telegram, /bind a Topics supergroup to give every
            session its own forum topic (channel-per-session).
  - sync:   Show conversation history since last attach, for context.
  - uninstall: Remove every trace attach left behind (agent hooks, Claude status
            line, bridge daemon, socket, runtime state); login credentials are
            kept so a future attach needs no re-login.
  Use when stepping away from the terminal and handing off to WeChat / Telegram.
license: MIT
allowed-tools: Bash Read Edit
metadata:
  version: "1.0.0"
---

# /wechat-remote-control

Determine whether the user wants **login**, **attach**, **sync**, or **uninstall**, then
follow the steps below.

If the user just says `/wechat-remote-control` with no args, default to **attach**.

**Choosing the IM transport.** This skill bridges to **WeChat** (default) or **Telegram**.
Decide the transport from the user's request:
- "telegram" / "tg" / "--telegram" → **Telegram** (see *login — Telegram* below; the
  daemon runs with `WCC_TRANSPORT=telegram`).
- otherwise → **WeChat** (the original flow).
The bridge daemon auto-detects the transport at startup (`WCC_TRANSPORT` env > `--telegram`/
`--wechat` argv > whichever credentials exist on disk > WeChat). When both a WeChat account and
a Telegram account exist, set `WCC_TRANSPORT` explicitly so the right one starts.

**Key principle:** When any step encounters a problem, fix it directly by running commands.
Never ask the user to copy-paste and run commands themselves — handle everything here.

---

## Architecture overview (for Claude's reference)

The bridge uses a **tmux-injection** model, bundled in this skill directory. It drives two
coding agents — **Claude Code** (`claude`) and **OpenAI Codex CLI** (`codex`) — auto-detecting
which one runs in each tmux pane via process ancestry.

**Concurrent multi-session model.** Every discovered tmux session owns an independent
runtime state (message queue, in-flight turn, quiz, live status message, orphan polls),
so multiple sessions work **at the same time** — messaging session B while session A is
mid-turn just works, and each response returns to the conversation that asked for it.
Hook events route to the right session by the tmux pane id that `hook.py` self-reports
(the `TMUX_PANE` env var, recorded as `paneId` in the registry). `#sw` only moves the
*default-route* pointer for private-chat/WeChat messages — it never cancels or clears
any session's in-flight work.

**Telegram Forum Topics mode (best experience).** Bind a Topics-enabled supergroup with
`/bind` (bot must be an admin with *Manage Topics*): every session automatically gets
its own forum topic — like a Slack channel per session. Messages typed inside a topic go
to that session; its replies, status updates and quizzes stay in the topic. The group's
General topic and the private chat keep working as the "lobby" (global commands,
`/ls` dashboard, default-route messages).

- **Bridge daemon** (`node src/index.js`): polls the IM (WeChat ilink API / Telegram Bot
  API) for messages, injects them into the addressed tmux-hosted agent session via
  `tmux send-keys` (targets the stable pane id).
- **Hook server**: listens on Unix socket `/tmp/cc_wechat_hook.sock`. Agent hooks send events
  here via `hook.py` (each payload carries `_tmuxPane` for session routing). Claude Code fires
  PreToolUse / Stop / Notification; Codex fires PreToolUse / Stop / UserPromptSubmit (Codex
  has no Notification event).
- **Response forwarding**: on Stop, the bridge forwards the assistant response to the IM
  conversation it injected from. For Claude it parses the transcript JSONL; for Codex it uses
  the Stop payload's `last_assistant_message`, gated on the rollout's latest user message
  matching what was injected. Terminal-initiated responses are NOT forwarded.
- **Telegram UX**: per-turn live status message edited in place (elapsed time, current tool,
  ⏹ interrupt button), 👀/👍/💔 reactions on the user's message (received / answered /
  abandoned), long replies collapse into expandable quotes, very long replies (>8k chars)
  arrive as a Markdown file, native bot command menu (/ls /sw /model /rename /esc /bind).
- **Auto-approve**: PreToolUse returns `permissionDecision: "allow"` (plus the legacy
  `decision: "approve"`). Both agents honor this — Codex honors `permissionDecision` and
  ignores `decision`, so one payload works for both.
- **All state lives in one directory**: `~/.wechat-remote-control/`
  - `accounts/<accountId>.json` — WeChat credentials
  - `telegram/account.json` — Telegram bot token + locked `allowedChatId` + bound
    `groupChatId` (topics group); `telegram/offset.json` — Telegram long-poll cursor
  - `state.json` — tmux target, autoApprove, transcriptPath (legacy single-session)
  - `sessions.json` — multi-session registry (`active` default-route pointer +
    per-session `tmux`/`paneId`/`cwd`/`transcriptPath`/`kind`/`imTarget` (topic) +
    `closedTopics` tombstones for reopening a pruned session's topic)
  - `sessions_state.json` — per-session in-flight turns (crash-recovery)
  - `ilink_session.json` — last reply target/user (ilink long-poll session cache)
  - `get_updates_buf` — ilink sync buffer cursor
  - `bridge.json` / `bridge.pid` / `cc_pid` — daemon metadata
  - `logs/bridge-YYYY-MM-DD.log` — rotated logs (30-day retention)
  - `history.jsonl` — injected messages and forwarded responses, tagged per session

**Critical: process kill safety.** Do NOT use `pgrep -f` or `grep` with bridge path strings
in the same bash command that does other work. Claude Code wraps commands in `bash -c "..."`,
so the pattern matches the shell itself, causing self-termination. Always use the Python
`/proc` scanner shown below, in a **separate** bash call from the start command.

**Environment variables this skill respects:**
- `CLAUDE_CODE_REMOTE=true` — set in cloud sessions. The bridge cannot work in cloud
  (no local tmux), so the skill refuses early with a clear message.
- `CLAUDE_CONFIG_DIR` — relocates `~/.claude/` (undocumented but supported by Claude
  Code; see anthropics/claude-code#3833). Both `detect.py` and the bridge daemon honour
  it when looking up `<config>/projects/<encoded-cwd>/*.jsonl` transcript files, and the
  hooks/statusLine writers target `<config>/settings.json`. When set, Claude Code also
  loads skills from `<config>/skills/`, so that's where this skill should be installed.
- `CODEX_HOME` — relocates `~/.codex/` (documented by Codex). Both `detect.py` and the
  bridge daemon honour it when looking up `<home>/sessions/YYYY/MM/DD/rollout-*.jsonl`
  rollout transcripts and when merging hooks into `<home>/hooks.json`.

Every skill-dir lookup in this runbook (`find "$HOME" …`) also searches
`$CLAUDE_CONFIG_DIR` and `$CODEX_HOME` when set, so installs under a config dir located
outside `$HOME` are still found.
- `CLAUDECODE=1` — set by Claude Code only. Treated as a hint, NOT a requirement: agent
  kind is determined by process ancestry, since Codex does not set it.

**Helpers:**
- `detect.py` walks `/proc` (Linux) or `ps` (macOS) up from the bash subprocess to find a
  supported agent ancestor (`claude` or `codex`), reports `agent=<kind>`, then verifies it
  lives inside a `tmux list-panes -a` pane. Used by attach Step 1 (preflight) and Step 3
  (state-file writer).

---

## login (WeChat) — Authenticate WeChat account

Use this for the **WeChat** transport. For **Telegram**, skip to *login (Telegram)* below.

Run this once before first use, or whenever the bridge reports session expiry.

### Step 1: Check if already logged in

```bash
ls ~/.wechat-remote-control/accounts/*.json 2>/dev/null | head -1
```

If account files exist, note them and ask the user whether they want to re-login
or if this was triggered by a session expiry. If they're just setting up fresh, proceed.

### Step 2: Locate skill directory and ensure dependencies

```bash
echo "=== node/npm prereq ==="
command -v node >/dev/null && node --version || echo "NO_NODE"
command -v npm  >/dev/null && npm  --version || echo "NO_NPM"
echo "=== skill dir ==="
SKILL_DIR=$(find "$HOME" ${CLAUDE_CONFIG_DIR:+"$CLAUDE_CONFIG_DIR"} ${CODEX_HOME:+"$CODEX_HOME"} -maxdepth 7 -type f -name "login.js" 2>/dev/null \
  | grep "wechat-remote-control/dist/wechat/login.js" | head -1 \
  | sed 's|/dist/wechat/login.js||')
echo "SKILL_DIR=${SKILL_DIR:-NOT_FOUND}"
```

The QR generator is built into the skill (`dist/wechat/qrcode.js`, zero external deps),
so there is no `npm install` step for QR rendering.

**If `NO_NODE` or `NO_NPM`:** install them yourself — don't push the work onto the user.
Try the system package manager that's available, in this order, and stop on first success:

```bash
if command -v apt-get >/dev/null; then sudo -n apt-get install -y -qq nodejs npm 2>&1 | tail -3 || apt-get install -y -qq nodejs npm 2>&1 | tail -3
elif command -v dnf     >/dev/null; then sudo -n dnf     install -y    nodejs npm 2>&1 | tail -3 || dnf     install -y    nodejs npm 2>&1 | tail -3
elif command -v pacman  >/dev/null; then sudo -n pacman  -S --noconfirm nodejs npm 2>&1 | tail -3 || pacman  -S --noconfirm nodejs npm 2>&1 | tail -3
elif command -v brew    >/dev/null; then brew    install                node       2>&1 | tail -3
else                                    echo "NO_PKG_MGR"
fi
node --version 2>/dev/null && npm --version 2>/dev/null || echo "INSTALL_FAILED"
```

Then verify Node ≥ 18 with `node --version`. If it's older (e.g. Debian 11 ships
Node 12), tell the user to upgrade via nvm or NodeSource — older Node breaks ESM imports
the bridge uses. If `INSTALL_FAILED` or `NO_PKG_MGR`, ask the user to install Node ≥ 18
manually then re-run **login**.

**Proxy support check.** All login/bridge networking uses Node's built-in `fetch`, which
only honors `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` when launched with `NODE_USE_ENV_PROXY=1`
(this skill sets that flag by default). The flag's `fetch` support requires Node **≥ 24.0**
or **≥ 22.21**; on older Node it is silently ignored. Run:

```bash
NODE_VER=$(node -p 'process.versions.node' 2>/dev/null)
MAJ=${NODE_VER%%.*}; REST=${NODE_VER#*.}; MIN=${REST%%.*}
if [ "$MAJ" -ge 24 ] 2>/dev/null || { [ "$MAJ" -eq 22 ] && [ "$MIN" -ge 21 ]; } 2>/dev/null; then
  echo "PROXY_ENV_SUPPORTED=1 (Node $NODE_VER)"
else
  echo "PROXY_ENV_SUPPORTED=0 (Node $NODE_VER)"
fi
```

If `PROXY_ENV_SUPPORTED=0` **and** this terminal can only reach the internet through a
local proxy, warn the user: the built-in `fetch` on this Node version cannot use proxy
environment variables, so login/bridge will fail — they must upgrade to Node ≥ 24 (or
≥ 22.21) via nvm/NodeSource. If `=1`, no action needed: it's enabled by default, and the
user only needs to `export HTTPS_PROXY=…` (and optionally `HTTP_PROXY`/`NO_PROXY`) in the
same shell. (No proxy env vars set → the flag is a harmless no-op.)

Note the SKILL_DIR value.

### Step 3: Launch background QR-login process (auto-retries on expiry)

The QR is short-lived (~60s). To survive slow scans without forcing the user to start
over, we run the login loop in a **detached background process** that re-requests a
fresh QR whenever the previous one expires, and writes its progress to two files the
foreground polls.

Replace `SKILL_DIR` with the actual path, then run:

```bash
QR_INFO=/tmp/wrc_qr_info.json
QR_RESULT=/tmp/wrc_qr_result.json
rm -f "$QR_INFO" "$QR_RESULT"

NODE_USE_ENV_PROXY=1 nohup node --input-type=module -e "
  import { writeFileSync } from 'fs';
  import { startQrLogin, waitForQrScan } from 'SKILL_DIR/dist/wechat/login.js';
  import { renderTerminalQr } from 'SKILL_DIR/dist/wechat/qrcode.js';
  const renderQr = (url) => { try { return renderTerminalQr(url); } catch { return null; } };

  for (let attempt = 1; attempt <= 5; attempt++) {
    const { qrcodeUrl, qrcodeId } = await startQrLogin();
    const qrcodeText = renderQr(qrcodeUrl);
    writeFileSync('$QR_INFO', JSON.stringify({ qrcodeUrl, qrcodeId, qrcodeText, attempt, ts: Date.now() }));
    try {
      const result = await waitForQrScan(qrcodeId);
      writeFileSync('$QR_RESULT', JSON.stringify({ status:'confirmed', accountId: result.accountId }));
      process.exit(0);
    } catch (e) {
      if (!String(e.message).includes('expired')) {
        writeFileSync('$QR_RESULT', JSON.stringify({ status:'error', error: String(e.message) }));
        process.exit(1);
      }
      // QR expired; loop will request a fresh one.
    }
  }
  writeFileSync('$QR_RESULT', JSON.stringify({ status:'error', error:'too many QR retries' }));
  process.exit(1);
" > /tmp/wrc_qr.log 2>&1 &
echo "QR_LOGIN_PID=$!"
```

### Step 4: Display QR and poll for scan

Wait for the background process to write the QR info, then read it:

```bash
for i in 1 2 3 4 5 6; do [ -f /tmp/wrc_qr_info.json ] && break; sleep 1; done
cat /tmp/wrc_qr_info.json
```

Parse the JSON. **In the same reply**, output `qrcodeText` verbatim as a code block:

```
请在 60 秒内用微信扫描以下二维码登录（过期会自动刷新一张新的）：

​```
<qrcodeText here>
​```
```

If `qrcodeText` is null, show `qrcodeUrl` instead. Remember the `attempt` number — you'll
use it to detect QR rotation.

Then poll for the scan result. If the QR rotates (new `attempt`), re-display the new QR:

```bash
LAST_ATTEMPT=$(python3 -c "import json; print(json.load(open('/tmp/wrc_qr_info.json'))['attempt'])")
for i in $(seq 1 24); do
  if [ -f /tmp/wrc_qr_result.json ]; then
    cat /tmp/wrc_qr_result.json
    exit 0
  fi
  CUR_ATTEMPT=$(python3 -c "import json; print(json.load(open('/tmp/wrc_qr_info.json'))['attempt'])" 2>/dev/null || echo "$LAST_ATTEMPT")
  if [ "$CUR_ATTEMPT" != "$LAST_ATTEMPT" ]; then
    echo "QR_ROTATED"
    exit 0
  fi
  sleep 5
done
echo "POLL_TIMEOUT"
```

Interpret the output:

- **`{"status":"confirmed",...}`** — scan succeeded, proceed to Step 5.
- **`QR_ROTATED`** — old QR expired and a fresh one is ready. Re-read `/tmp/wrc_qr_info.json`,
  display the new `qrcodeText` to the user, and re-run this poll loop.
- **`{"status":"error",...}`** — login failed; report the error and stop.
- **`POLL_TIMEOUT`** — 2 minutes elapsed without scan or rotation; re-run the poll loop
  (the user is still scanning).

### Step 5: Verify and report

```bash
ls ~/.wechat-remote-control/accounts/*.json 2>/dev/null
```

If no files: retry from Step 3. Otherwise confirm login success.

---

## login (Telegram) — Authenticate a Telegram bot

Use this for the **Telegram** transport. A Telegram bot authenticates with a token from
**@BotFather** (no QR). After verifying the token, the user opens the bot and sends `/start`;
the first chat to message the bot is captured and **locked** as the only authorized chat.

> **Security:** the bot token grants control of the terminal. Treat it as a secret. The bridge
> only ever accepts messages from the single locked chat; anyone else who finds the bot is ignored.

### Step 1: Resolve the skill dir and ensure Node (same as WeChat login Step 2)

```bash
SKILL_DIR=$(find "$HOME" ${CLAUDE_CONFIG_DIR:+"$CLAUDE_CONFIG_DIR"} ${CODEX_HOME:+"$CODEX_HOME"} -maxdepth 7 -type f -name "login.js" 2>/dev/null \
  | grep "wechat-remote-control/dist/telegram/login.js" | head -1 \
  | sed 's|/dist/telegram/login.js||')
echo "SKILL_DIR=${SKILL_DIR:-NOT_FOUND}"
command -v node >/dev/null && node --version || echo "NO_NODE"
```

If `dist/telegram/login.js` is missing, run `npm install` in the skill dir first
(its `postinstall` runs `tsc`). If `NO_NODE`, install Node ≥ 18 as in WeChat login Step 2.

### Step 2: Get a bot token

Tell the user, then wait for them to paste the token:

> 请在 Telegram 里打开 **@BotFather**，发送 `/newbot`（或对已有 bot 用 `/token`），
> 按提示设置名称，拿到形如 `123456789:AA....` 的 **bot token**，发给我。

### Step 3: Verify the token

Replace `SKILL_DIR` and `THE_TOKEN`, then run:

```bash
NODE_USE_ENV_PROXY=1 node --input-type=module -e "
  import { verifyToken } from 'SKILL_DIR/dist/telegram/login.js';
  const r = await verifyToken(process.argv[1]);
  console.log(JSON.stringify({ ok: true, username: r.username }));
" "THE_TOKEN" 2>&1 || echo "TOKEN_REJECTED"
```

On `{"ok":true,"username":"..."}` the token is saved to
`~/.wechat-remote-control/telegram/account.json`. On `TOKEN_REJECTED`, ask the user to re-check
the token. Tell the user the bot handle: **https://t.me/<username>**.

### Step 4: Capture the authorized chat (user sends /start)

Ask the user to open `https://t.me/<username>` and send `/start` (or any message). Then run a
background capture loop that waits for that first message and locks the chat:

```bash
NODE_USE_ENV_PROXY=1 node --input-type=module -e "
  import { loadTelegramAccount } from 'SKILL_DIR/dist/telegram/auth.js';
  import { captureAuthorizedChat } from 'SKILL_DIR/dist/telegram/login.js';
  const acct = loadTelegramAccount();
  const r = await captureAuthorizedChat(acct.botToken, { timeoutMs: 180000 });
  console.log(JSON.stringify({ ok: true, chatId: r.chatId, username: r.username }));
" 2>&1 || echo "CAPTURE_TIMEOUT"
```

On `{"ok":true,"chatId":"..."}`, login is complete and the bridge is locked to that chat.
On `CAPTURE_TIMEOUT`, ask the user to send `/start` and re-run this step.

### Step 5: Verify

```bash
cat ~/.wechat-remote-control/telegram/account.json 2>/dev/null | grep -o '"allowedChatId"' || echo "NOT_LOCKED"
```

If present, confirm success and tell the user to run **attach** (with Telegram). If `NOT_LOCKED`,
re-run Step 4.

### Optional Step 6: Bind a Topics group (best multi-session experience)

With a topics group bound, **every tmux session gets its own forum topic** — an isolated
channel with its own history, status messages and quiz buttons; sessions can be driven
concurrently without any switching. Tell the user how to set it up (this happens in the
Telegram app, not the terminal):

1. Create a new Telegram **group**, then in group settings enable **Topics**
   (群设置 → 话题). This silently upgrades it to a supergroup.
2. Add the bot to the group and promote it to **admin** with the **Manage Topics**
   permission (管理话题). Admin status also lets the bot read all topic messages.
3. Send `/bind` in the group (any topic). The bridge verifies the group is
   forum-enabled, saves it, and creates one topic per discovered session within ~30s.

No re-login or re-attach is needed — `/bind` works any time the bridge daemon is running.
The private chat keeps working as a fallback (messages there go to the default-route
session; `/ls` shows a dashboard with deep links into each topic).

---

## attach — Register this session as WeChat remote target

### Step 1: Pre-flight checks (run all in one bash call)

`detect.py` walks the `/proc` parent chain (or `ps` on macOS) from the bash subprocess
to find the actual `claude` process and verifies it lives inside a tmux pane. This
replaces the old `tmux display-message` check, which was unreliable: `display-message`
returns the *focused* client window, not the pane CC lives in, and the old `||
echo NOT_IN_TMUX` guard never fired (echo always returns 0).

The skill may be installed under `~/.claude/skills/` (Claude Code) **or**
`~/.agents/skills/` (Codex), so resolve the install dir dynamically and prefer the copy
matching the detected agent — never hardcode `~/.claude/skills`.

```bash
echo "=== skill dir ==="
ALL_DIRS=$(find "$HOME" ${CLAUDE_CONFIG_DIR:+"$CLAUDE_CONFIG_DIR"} ${CODEX_HOME:+"$CODEX_HOME"} -maxdepth 7 -type f -name "detect.py" 2>/dev/null \
  | grep "wechat-remote-control/detect.py" | sed 's|/detect.py||')
SKILL_DIR=$(printf '%s\n' "$ALL_DIRS" | grep "/.claude/skills/" | head -1)
[ -z "$SKILL_DIR" ] && SKILL_DIR=$(printf '%s\n' "$ALL_DIRS" | grep "/.agents/skills/" | head -1)
[ -z "$SKILL_DIR" ] && SKILL_DIR=$(printf '%s\n' "$ALL_DIRS" | head -1)
# detect.py reports the agent kind via process ancestry; re-point at the matching install.
AGENT=$(python3 "$SKILL_DIR/detect.py" preflight 2>/dev/null | sed -n 's/^agent=//p' | head -1)
if [ "$AGENT" = "codex" ]; then
  CODEX_DIR=$(printf '%s\n' "$ALL_DIRS" | grep "/.agents/skills/" | head -1)
  [ -n "$CODEX_DIR" ] && SKILL_DIR="$CODEX_DIR"
fi
export SKILL_DIR
echo "SKILL_DIR=${SKILL_DIR:-NOT_FOUND} (agent=$AGENT)"

echo "=== bridge installed ==="
test -f "$SKILL_DIR/src/index.js" && echo "OK" || echo "NOT_FOUND"
echo "=== account ==="
WACCT=$(ls ~/.wechat-remote-control/accounts/*.json 2>/dev/null | head -1)
TGACCT=$([ -f ~/.wechat-remote-control/telegram/account.json ] && echo ~/.wechat-remote-control/telegram/account.json)
echo "wechat=${WACCT:-none} telegram=${TGACCT:-none}"
[ -z "$WACCT" ] && [ -z "$TGACCT" ] && echo "NOT_FOUND"
echo "=== detect ==="
python3 "$SKILL_DIR/detect.py" preflight
echo "=== existing attach ==="
cat ~/.wechat-remote-control/state.json 2>/dev/null || echo "{}"
```

Interpret the `status=...` line from the detect block. Also note the `agent=...` line
(`claude` or `codex`) — it drives the hooks/statusLine steps below.

- **`status=OK`** — proceed. The `agent=...`, `tmux_target=...` and `cc_pid=...` values are
  saved to `/tmp/wrc_detect.json` later in Step 3.
- **`status=REMOTE_SESSION`** — Claude Code is running as a cloud session
  (`CLAUDE_CODE_REMOTE=true`). The bridge uses local tmux + Unix sockets and cannot
  work in cloud. Stop and tell the user to use a local CC instance.
- **`status=NO_AGENT_PROCESS`** — no `claude` or `codex` ancestor was found. Stop and ask
  the user to confirm the agent was started normally (not via wrapper scripts).
- **`status=NO_TMUX`** — `tmux` is not installed. Install it yourself (don't push the
  work to the user), then fall through to the `AGENT_NOT_IN_TMUX` instructions below
  (because the user still needs to restart the agent inside a tmux session — installing
  tmux doesn't move the already-running agent into one):

  ```bash
  if command -v apt-get >/dev/null; then sudo -n apt-get install -y -qq tmux 2>&1 | tail -3 || apt-get install -y -qq tmux 2>&1 | tail -3
  elif command -v dnf     >/dev/null; then sudo -n dnf     install -y    tmux 2>&1 | tail -3 || dnf     install -y    tmux 2>&1 | tail -3
  elif command -v pacman  >/dev/null; then sudo -n pacman  -S --noconfirm tmux 2>&1 | tail -3 || pacman  -S --noconfirm tmux 2>&1 | tail -3
  elif command -v brew    >/dev/null; then brew    install               tmux 2>&1 | tail -3
  else                                    echo "NO_PKG_MGR — please install tmux manually"
  fi
  ```

- **`status=AGENT_NOT_IN_TMUX`** (or after installing tmux above) — **DO NOT silently
  create a tmux session and proceed.** The bridge injects keystrokes into the tmux
  pane where the agent actually lives; injecting into a different pane silently sends keys
  nowhere, and we cannot move an already-running agent into a new tmux session. Substitute
  the detected agent's launch command (`claude` or `codex`) into the message and output:

  > 检测到 agent（Claude Code / Codex）不在 tmux 内运行。WeChat Remote Control 必须把它跑在
  > tmux 里才能转发消息（桥接靠 `tmux send-keys` 把微信消息注入 agent 所在面板）。
  >
  > 请：
  > 1. 退出当前会话（Ctrl-D 或 `/exit`）
  > 2. 启动 tmux：`tmux new -s cc`
  > 3. 在 tmux 里重新运行 `claude`（或 `codex`）
  > 4. 重新执行 `/wechat-remote-control`

  Then stop. Do not proceed.

**Other early stops:**
- **bridge NOT_FOUND** — tell user the bridge is not installed, stop.
- **account NOT_FOUND** (both `wechat=none` and `telegram=none`) — run the matching **login**
  flow first (WeChat QR or Telegram token), then return. If only one of them is present, that
  transport will be used; the daemon launch below detects which.

### Step 2: Check for existing attach — prompt for override

If `state.json` shows `active: true` and `injectTarget` exists, show the user:

> "WeChat Remote Control is currently attached to tmux `<session>:<window>.<pane>`
>  (since <attachedAt>). Override with this session? [Y/n]"

Default: **Y** (override). If user says no, stop.

### Step 3: Write state.json, bridge.json, sessions.json

`detect.py json` returns a single JSON blob with `agent`, `cc_pid`, `cwd`, `tmux_target`,
and `transcript`. We feed that into a small writer script that updates the runtime state
files. The transcript path respects `CLAUDE_CONFIG_DIR` / `CODEX_HOME` if set, and the
session entry records `kind` (`claude` or `codex`).

```bash
# Re-resolve the agent-matching SKILL_DIR (shell state does not persist across
# separate bash calls). detect.py emits its own dir as `skill_dir`, so invoking the
# copy that matches the running agent makes that field agent-correct for Step 4.
ALL_DIRS=$(find "$HOME" ${CLAUDE_CONFIG_DIR:+"$CLAUDE_CONFIG_DIR"} ${CODEX_HOME:+"$CODEX_HOME"} -maxdepth 7 -type f -name "detect.py" 2>/dev/null \
  | grep "wechat-remote-control/detect.py" | sed 's|/detect.py||')
SKILL_DIR=$(printf '%s\n' "$ALL_DIRS" | head -1)
AGENT=$(python3 "$SKILL_DIR/detect.py" preflight 2>/dev/null | sed -n 's/^agent=//p' | head -1)
MATCH_SUB=$([ "$AGENT" = "codex" ] && echo "/.agents/skills/" || echo "/.claude/skills/")
MATCHED=$(printf '%s\n' "$ALL_DIRS" | grep "$MATCH_SUB" | head -1)
[ -n "$MATCHED" ] && SKILL_DIR="$MATCHED"
python3 "$SKILL_DIR/detect.py" json > /tmp/wrc_detect.json
test "$(python3 -c "import json; print(json.load(open('/tmp/wrc_detect.json'))['status'])")" = "OK" || { echo "DETECT_FAILED"; cat /tmp/wrc_detect.json; exit 1; }

python3 - <<'PY'
import json, os, time, datetime, subprocess
info = json.load(open('/tmp/wrc_detect.json'))
d = os.path.expanduser('~/.wechat-remote-control'); os.makedirs(d, exist_ok=True)
target = info['tmux_target']

# state.json (legacy single-session)
json.dump({
    'injectTarget': {
        'session': info['tmux_session'], 'window': info['tmux_window'], 'pane': info['tmux_pane'],
        'attachedAt': int(time.time() * 1000),
    },
    'autoApprove': True,
    'active': True,
    'transcriptPath': info.get('transcript'),
}, open(os.path.join(d, 'state.json'), 'w'), indent=2)

# bridge.json (daemon metadata)
session_id = os.path.basename(info['transcript']).replace('.jsonl', '') if info.get('transcript') else None
json.dump({
    'sessionId': session_id, 'cwd': info['cwd'], 'ccPid': info['cc_pid'],
    'attachedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
}, open(os.path.join(d, 'bridge.json'), 'w'), indent=2)

# cc_pid file (used by status.sh)
open(os.path.join(d, 'cc_pid'), 'w').write(str(info['cc_pid']))

# sessions.json — match by stable pane id (fallback: tmux coordinates); create entry
# if new; set active directly. Never set active=None — the bridge's auto-pick heuristic
# can pick the wrong CC when multiple sessions share a cwd.
sp = os.path.join(d, 'sessions.json')
sessions = json.load(open(sp)) if os.path.exists(sp) else {'active': None, 'sessions': {}}
sessions.setdefault('sessions', {})

kind = info.get('agent', 'claude')
pane_id = info.get('tmux_pane_id') or ''
matched = None
for name, s in sessions['sessions'].items():
    if (pane_id and s.get('paneId') == pane_id) or s.get('tmux') == target:
        matched = name
        s['tmux'] = target
        s['transcriptPath'] = info.get('transcript')
        s['kind'] = kind
        if pane_id:
            s['paneId'] = pane_id
        s['lastSeen'] = int(time.time() * 1000)
        break

if not matched:
    try:
        wname = subprocess.check_output(
            ['tmux', 'display-message', '-t', target, '-p', '#{window_name}'],
            stderr=subprocess.DEVNULL).decode().strip()
    except Exception:
        wname = ''
    SHELLS = {'bash', 'zsh', 'sh', 'fish', 'dash', 'tcsh', 'csh', 'ksh'}
    base = wname if (wname and wname.lower() not in SHELLS and not wname.startswith('[')) else os.path.basename(info['cwd'])
    matched = base
    suffix = 2
    while matched in sessions['sessions']:
        matched = f'{base}-{suffix}'; suffix += 1
    entry = {
        'tmux': target, 'cwd': info['cwd'],
        'transcriptPath': info.get('transcript'),
        'kind': kind,
        'lastSeen': int(time.time() * 1000),
    }
    if pane_id:
        entry['paneId'] = pane_id
    sessions['sessions'][matched] = entry

sessions['active'] = matched
json.dump(sessions, open(sp, 'w'), indent=2)
print(f'OK: target={target} active={matched} ccPid={info["cc_pid"]}')
PY
```

### Step 4: Configure agent hooks (merge-safe)

The hook config file and event set depend on the detected agent:

- **claude** → `$CLAUDE_CONFIG_DIR/settings.json` (default `~/.claude/settings.json`), events
  `PreToolUse` / `Stop` / `Notification`.
- **codex** → `$CODEX_HOME/hooks.json` (default `~/.codex/hooks.json`), events
  `PreToolUse` / `Stop` / `UserPromptSubmit` (Codex has no `Notification` event).

Both files use the same nested `hooks` schema. The writer below **merges** — it never
overwrites other settings or other tools' hook blocks. Two properties matter:

- **The command is guarded so it can NEVER block a prompt.** It is written as
  `[ -f <hook.py> ] && python3 <hook.py> <arg> 2>/dev/null; exit 0`. If `hook.py` is missing
  or python errors, the command still exits 0. This is critical for Codex: a bare
  `python3 <missing>.py` exits 2, and Codex treats a `UserPromptSubmit` hook's exit 2 as a
  **block** (surfacing stderr as the reason), which silently jams every prompt. Only
  **stderr** is redirected — stdout must still flow, because PreToolUse auto-approve is
  conveyed via the permission-decision JSON `hook.py` prints to stdout (the exit code is
  irrelevant to it), so forcing `exit 0` is safe. We never emit a deny/exit-2.
- **It migrates instead of skipping.** Any pre-existing wrc handler (old hardcoded path,
  unguarded command, or wrong install dir) is removed and replaced with the fresh guarded
  command. This makes re-running attach **self-heal** an already-broken `hooks.json` /
  `settings.json`, and is idempotent (re-runs yield a byte-identical file).

The install dir comes from `detect.py`'s emitted `skill_dir` (its own location, agent-correct
by construction), with fallbacks. The agent kind is read from the Step-3 detect blob.

> NOTE: This heredoc is the source of truth for the guarded command and per-agent event set.
> `src/hookcmd.ts` mirrors it for tests — keep the two byte-identical.

```bash
python3 - <<'PY'
import json, os, shlex
info = json.load(open('/tmp/wrc_detect.json'))
kind = info.get('agent', 'claude')

# Authoritative install dir: detect.py's own dir (matches the running agent); fall back
# to the SKILL_DIR exported by Step 1, then to the agent-aware default location.
skill_dir = info.get('skill_dir') or os.environ.get('SKILL_DIR')
if not skill_dir:
    sub = '.agents/skills' if kind == 'codex' else '.claude/skills'
    skill_dir = os.path.expanduser(f'~/{sub}/wechat-remote-control')
cmd_base = os.path.join(skill_dir, 'hook.py')

if kind == 'codex':
    cfg_dir = os.environ.get('CODEX_HOME') or os.path.expanduser('~/.codex')
    path = os.path.join(cfg_dir, 'hooks.json')
    events = {'PreToolUse': 'pretooluse', 'Stop': 'stop', 'UserPromptSubmit': 'userpromptsubmit'}
else:
    cfg_dir = os.environ.get('CLAUDE_CONFIG_DIR') or os.path.expanduser('~/.claude')
    path = os.path.join(cfg_dir, 'settings.json')
    events = {'PreToolUse': 'pretooluse', 'Stop': 'stop', 'Notification': 'notification'}

os.makedirs(cfg_dir, exist_ok=True)
cfg = json.load(open(path)) if os.path.exists(path) else {}
hooks = cfg.setdefault('hooks', {})

# Guarded command (stderr-only redirect; forced exit 0 so a missing/erroring hook.py
# never blocks a prompt). shlex.quote handles install paths containing spaces.
qbase = shlex.quote(cmd_base)
MARK = 'wechat-remote-control/hook.py'
for event, arg in events.items():
    command = f'[ -f {qbase} ] && python3 {qbase} {arg} 2>/dev/null; exit 0'
    groups = hooks.setdefault(event, [])
    # Migrate, don't skip: strip any prior wrc handler, drop emptied groups, append one
    # fresh entry. Idempotent and self-healing for already-broken configs.
    for g in groups:
        g['hooks'] = [h for h in g.get('hooks', []) if MARK not in (h.get('command') or '')]
    hooks[event] = [g for g in groups if g.get('hooks')]
    hooks[event].append({'matcher': '', 'hooks': [{'type': 'command', 'command': command}]})

with open(path, 'w') as f:
    json.dump(cfg, f, indent=2)
print(f'OK kind={kind} file={path} skill_dir={skill_dir}')
PY
```

**Codex hot-reload caveat.** Codex reads `hooks.json` ONCE at process startup — it does
not hot-reload. If `agent=codex` and the wrc hooks were not already present before this
attach (check first: `grep -c 'wechat-remote-control/hook.py' "$CODEX_HOME/hooks.json"`
→ `0` means first install; default `CODEX_HOME` is `~/.codex`), the running codex will
never fire them: its turns complete but no Stop reaches the bridge, so responses are
never forwarded (the IM shows endless "typing"). After Step 6, tell the user to restart
codex inside the same tmux pane — `/quit`, then `codex resume --last` to keep the
conversation context. No re-attach is needed; the state files already point at the pane.

Related pitfall: the bridge's session auto-discovery (`Auto-discovered … session` in the
log) only registers sessions in `sessions.json` — it never installs hooks. Attach must be
run at least once per agent kind (claude / codex) or that agent's responses are silently
dropped.

### Step 5: Configure status line (Claude only)

Codex has no status-line hook mechanism, so **skip this step entirely when `agent=codex`.**
For Claude, check if `statusLine` is already configured; if not (or if the command points
elsewhere), merge it into `$CLAUDE_CONFIG_DIR/settings.json` without overwriting other
settings:

```bash
# Run only when agent=claude.
# Re-resolve the install dir (separate bash call → shell state not preserved); read the
# authoritative skill_dir Step 3 persisted, with a find fallback.
SKILL_DIR=$(python3 -c "import json;print(json.load(open('/tmp/wrc_detect.json')).get('skill_dir',''))" 2>/dev/null)
[ -z "$SKILL_DIR" ] && SKILL_DIR=$(find "$HOME" ${CLAUDE_CONFIG_DIR:+"$CLAUDE_CONFIG_DIR"} ${CODEX_HOME:+"$CODEX_HOME"} -maxdepth 7 -type f -name status.sh 2>/dev/null | grep "wechat-remote-control/status.sh" | head -1 | sed 's|/status.sh||')
SKILL_DIR="$SKILL_DIR" python3 -c "
import json, os
path = os.path.join(os.environ.get('CLAUDE_CONFIG_DIR') or os.path.expanduser('~/.claude'), 'settings.json')
settings = json.load(open(path)) if os.path.exists(path) else {}
skill_dir = os.environ.get('SKILL_DIR') or os.path.expanduser('~/.claude/skills/wechat-remote-control')
desired = {'type': 'command', 'command': 'bash ' + os.path.join(skill_dir, 'status.sh')}
if settings.get('statusLine') == desired:
    print('ALREADY_SET')
else:
    settings['statusLine'] = desired
    with open(path, 'w') as f:
        json.dump(settings, f, indent=2)
    print('OK')
"
```

If `ALREADY_SET`, skip silently.

### Step 6: Ensure bridge daemon is running (service model)

The bridge is a singleton service. Check if it's already running via PID file before starting.
Never kill a healthy bridge just because attach was called again.

The daemon **self-enforces** singleton at the OS level by binding the hook socket
`/tmp/cc_wechat_hook.sock`: if a live daemon already owns it (even one launched from a
different install dir, e.g. `~/.agents/skills` for Codex vs `~/.claude/skills` for Claude
Code), a second `node src/index.js` detects it and exits immediately. The PID check below
is just an optimization to avoid spawning a doomed process. The daemon writes its own PID
to `bridge.pid` once it successfully binds, so that file always points at the real singleton.

**Check existing daemon:**

```bash
PID_FILE="$HOME/.wechat-remote-control/bridge.pid"
BRIDGE_RUNNING=0
if [ -f "$PID_FILE" ]; then
    STORED_PID=$(cat "$PID_FILE")
    if kill -0 "$STORED_PID" 2>/dev/null; then
        echo "already running PID=$STORED_PID"
        BRIDGE_RUNNING=1
    else
        echo "stale PID file, cleaning up"
        rm -f "$PID_FILE"
    fi
fi
echo "BRIDGE_RUNNING=$BRIDGE_RUNNING"
```

**Only if BRIDGE_RUNNING=0 — start daemon** (separate bash call):

```bash
# Re-resolve the install dir (separate bash call); read the skill_dir Step 3 persisted,
# with a find fallback. For Codex the daemon lives under ~/.agents/skills, not ~/.claude.
SKILL_DIR=$(python3 -c "import json;print(json.load(open('/tmp/wrc_detect.json')).get('skill_dir',''))" 2>/dev/null)
[ -z "$SKILL_DIR" ] && SKILL_DIR=$(find "$HOME" ${CLAUDE_CONFIG_DIR:+"$CLAUDE_CONFIG_DIR"} ${CODEX_HOME:+"$CODEX_HOME"} -maxdepth 7 -type f -name index.js 2>/dev/null | grep "wechat-remote-control/src/index.js" | head -1 | sed 's|/src/index.js||')
# Transport: explicit WCC_TRANSPORT env wins; else auto-detect (Telegram only when a
# Telegram account exists AND no WeChat account does). An empty value is a safe no-op —
# the daemon applies the same heuristic internally.
TRANSPORT="${WCC_TRANSPORT:-}"
if [ -z "$TRANSPORT" ] && [ -f "$HOME/.wechat-remote-control/telegram/account.json" ] \
   && ! ls "$HOME/.wechat-remote-control/accounts/"*.json >/dev/null 2>&1; then
  TRANSPORT=telegram
fi
WCC_TRANSPORT="$TRANSPORT" NODE_USE_ENV_PROXY=1 nohup node "$SKILL_DIR/src/index.js" >> /tmp/cc_wechat_bridge.log 2>&1 &
echo "launched PID=$! (SKILL_DIR=$SKILL_DIR transport=${TRANSPORT:-auto})"
```

To force a transport when both accounts exist, run attach in a shell with
`export WCC_TRANSPORT=telegram` (or `wechat`) set first.

Do NOT write `bridge.pid` here — the daemon writes its own PID once it wins the
singleton. (A redundant launch self-exits without touching `bridge.pid`, so the file
always points at the live daemon.)

**Verify** (after ~3 seconds) — check the live daemon, not the launched PID, since a
redundant launch self-exiting is a *success*, not a failure:

```bash
PID_FILE="$HOME/.wechat-remote-control/bridge.pid"
if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "running PID=$(cat "$PID_FILE")"
else
    echo "FAILED"
fi
```

If FAILED: read the last 30 lines of `/tmp/cc_wechat_bridge.log` and diagnose.

### Step 7: Report success

```
Remote Control activated

Agent: <Claude Code | Codex>
IM: <WeChat | Telegram>
Tmux target: <session>:<window>.<pane>
Auto-approve: on
Bridge: running (PID <pid>)
Transcript: <transcript path>

You can leave the terminal now. Messages from the IM will be injected into this
agent session via tmux. Responses they trigger will be forwarded back.

Terminal-initiated responses are NOT forwarded to the IM.
```

For Claude, a status-line indicator shows bridge state in the terminal; Codex has no
status line, so that indicator is Claude-only.

If the transport is Telegram and no topics group is bound yet
(`grep -o '"groupChatId"' ~/.wechat-remote-control/telegram/account.json` is empty),
also mention: creating a Topics-enabled supergroup, adding the bot as admin (Manage
Topics) and sending `/bind` gives every session its own channel — see *login (Telegram)
Optional Step 6*.

**Multi-session semantics.** All sessions the bridge discovers run **concurrently** —
each with its own queue, in-flight turn and status message. In the topics group, each
topic addresses its own session. In the private chat / WeChat, plain messages go to the
*default-route* session shown by `/ls`; `/sw` moves only that pointer and never cancels
another session's in-flight work. IM-side commands: `/ls` (dashboard with busy state,
grouped by tmux session), `/sw`, `/fc` (focus one tmux session — topics of all other
sessions are DELETED, history included, and recreated with a context replay on refocus),
`/rename`, `/model`, `/esc` (interrupt), `/bind`, plus the `#`-prefixed aliases.
Renaming a topic directly in the Telegram UI also syncs back: the pane's tmux window is
renamed (pinned against rescans) and illegal characters (`: . tab newline`) become `-`.

---

## verify — Manual end-to-end checklist (multi-session + Topics)

For validating a code change to the bridge itself (not a user-facing sub-command):

1. Two tmux panes, one running `claude`, one running `codex`; attach from each once.
2. Telegram: create a Topics supergroup, add the bot as admin (Manage Topics), `/bind`.
3. Confirm two topics appear within ~30s, each with a 🆕 intro message.
4. Send a long-running prompt in topic A, then immediately a prompt in topic B: both
   inject (independent queues), two status messages update independently, 👀 → 👍
   reactions land on each user message, each reply returns to its own topic.
5. Tap ⏹ on a running turn's status message → the pane receives Escape.
6. `/rename` inside a topic → tmux window, registry and the topic itself are renamed.
   Rename a topic in the Telegram UI (long-press → Edit) → the tmux window follows, a ✅
   notice appears in the topic, and the 30s rescan does NOT revert it (no rename ping-pong
   in the log). Renaming to an existing session's name snaps the topic back with a ⚠️.
7. `kill $(cat ~/.wechat-remote-control/bridge.pid)` mid-turn, relaunch the daemon →
   the in-flight turn is recovered from sessions_state.json (reply arrives or the turn
   is abandoned with ⚠️ after the grace window).
8. Delete a topic in Telegram → next send recreates it automatically.
9. Close one pane → its topic is closed within ~60s; reopen a session with the same
   name → the old topic is reopened, not duplicated.
10. `/fc` in General → grouped tmux-session menu; tap one → other sessions' topics are
    deleted (`sessions.json` gains `focusedTmuxSession`, hidden entries lose `imTarget`
    and gain `topicPurged`), busy sessions keep theirs until the turn ends. New panes in
    a hidden tmux session get a one-line notice in General instead of a topic. `/fc all`
    (or focusing back) recreates topics with a 📜 context replay. Kill the focused tmux
    session entirely → focus auto-clears on the next scan.
11. WeChat smoke test: single active session, numbered menus, `#sw` still works, `/fc`
    replies "话题模式未开启", and switching no longer clears the other session's queue.

---

## sync — Show conversation history

### Step 1: Format and show history

History entries are tagged per session; pass an optional session-name argument to filter
(substring match), e.g. `format_history.py miami-v2`.

```bash
# Resolve the install dir dynamically (Claude: ~/.claude/skills; Codex: ~/.agents/skills).
# format_history.py only reads ~/.wechat-remote-control/history.jsonl, so either copy works.
SKILL_DIR=$(find "$HOME" ${CLAUDE_CONFIG_DIR:+"$CLAUDE_CONFIG_DIR"} ${CODEX_HOME:+"$CODEX_HOME"} -maxdepth 7 -type f -name format_history.py 2>/dev/null \
  | grep "wechat-remote-control/format_history.py" | head -1 | sed 's|/format_history.py||')
python3 "$SKILL_DIR/format_history.py" 2>/dev/null \
  || (tail -20 ~/.wechat-remote-control/history.jsonl 2>/dev/null || echo "No history found.")
```

If no history exists, check the bridge logs:

```bash
tail -50 ~/.wechat-remote-control/logs/bridge-$(date +%Y-%m-%d).log 2>/dev/null | grep -E "INFO|WARN|ERROR" | tail -20
```

### Step 2: Summarize

Give a one-line summary of what happened while the user was away.

---

## uninstall — Remove all wrc traces

Reverses everything **attach** installed, so Claude Code / Codex go back to their original
behaviour. This is a single global cleanup — it does not distinguish between sessions; it
removes the shared hooks, status line, daemon, socket and runtime state outright.

**Kept on purpose:** login credentials (`accounts/`, `telegram/` — including the bound
topics group), `history.jsonl`, and `logs/`. A future **attach** therefore needs no
re-login or re-bind. Forum topics created in the Telegram group are left in place with
their history — the group is the user's, not runtime state. (To wipe local state too, the
user can `rm -rf ~/.wechat-remote-control` afterwards — mention this at the end.)

> Note on no-op hooks: even before uninstall, the hooks attach registers are harmless when
> no daemon is running — `hook.py` exits 0 immediately if the socket is absent. uninstall
> removes them entirely so nothing fires at all.

### Step 1: Remove agent hooks + status line (merge-safe, both agents)

We strip wrc's entries from **both** Claude (`settings.json`) and Codex (`hooks.json`)
regardless of which agent you're running under, since attach for either could have written
to either file over time. Only entries whose command contains `wechat-remote-control/hook.py`
are removed; all other hooks and settings are preserved. The Claude status line is removed
only when it still points at this skill's `status.sh`.

> NOTE: The hook-stripping logic below is mirrored in `src/hookuninstall.ts` for tests
> (`stripWrcHooks` / `stripWrcStatusLine`) — keep the two behaviourally identical.

```bash
python3 - <<'PY'
import json, os

HOOK_MARK = 'wechat-remote-control/hook.py'
STATUS_MARK = 'wechat-remote-control/status.sh'

def strip_hooks(cfg):
    hooks = cfg.get('hooks')
    if not isinstance(hooks, dict):
        return cfg
    for event in list(hooks.keys()):
        groups = hooks[event] if isinstance(hooks[event], list) else []
        kept = []
        for g in groups:
            inner = g.get('hooks', []) if isinstance(g, dict) else []
            filtered = [h for h in inner if HOOK_MARK not in (h.get('command') or '')]
            if filtered:                      # drop groups emptied by filtering
                g['hooks'] = filtered
                kept.append(g)
        if kept:
            hooks[event] = kept
        else:
            del hooks[event]
    if not hooks:
        del cfg['hooks']
    return cfg

def strip_statusline(cfg):
    sl = cfg.get('statusLine')
    cmd = sl.get('command', '') if isinstance(sl, dict) else ''
    if STATUS_MARK in cmd:                     # only remove a statusLine that is ours
        del cfg['statusLine']
    return cfg

# Resolve both agents' config files, honouring CLAUDE_CONFIG_DIR / CODEX_HOME.
claude_dir = os.environ.get('CLAUDE_CONFIG_DIR') or os.path.expanduser('~/.claude')
codex_dir  = os.environ.get('CODEX_HOME')        or os.path.expanduser('~/.codex')
claude_path = os.path.join(claude_dir, 'settings.json')
codex_path  = os.path.join(codex_dir,  'hooks.json')

for path, is_claude in ((claude_path, True), (codex_path, False)):
    if not os.path.exists(path):
        print(f'SKIP (absent): {path}'); continue
    try:
        cfg = json.load(open(path))
    except Exception as e:
        print(f'SKIP (unreadable {e}): {path}'); continue
    strip_hooks(cfg)
    if is_claude:
        strip_statusline(cfg)
    with open(path, 'w') as f:
        json.dump(cfg, f, indent=2)
    print(f'CLEANED: {path}')
PY
```

### Step 2: Stop the bridge daemon

**Run this in its own bash call.** Do NOT combine it with any `pgrep -f`/`grep` over the
bridge path — Claude Code wraps commands in `bash -c "..."`, so such a pattern matches the
shell itself and would kill the wrong process. The `bridge.pid` file is the safe handle.

```bash
PID_FILE="$HOME/.wechat-remote-control/bridge.pid"
if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE" 2>/dev/null)
    if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
        kill "$PID" 2>/dev/null && echo "stopped daemon PID=$PID"
    else
        echo "daemon not running (stale PID)"
    fi
else
    echo "no bridge.pid — daemon not running"
fi
```

### Step 3: Remove socket and runtime state (separate bash call)

Give the daemon a moment to exit, then remove the socket it owned plus the per-session
runtime files. Credentials, history and logs are intentionally left in place.

```bash
sleep 1
D="$HOME/.wechat-remote-control"
rm -f /tmp/cc_wechat_hook.sock \
      "$D/bridge.pid" "$D/cc_pid" "$D/bridge.json" \
      "$D/state.json" "$D/sessions.json" "$D/sessions_state.json"
echo "runtime state cleared (accounts/ and history.jsonl kept)"
```

### Step 4: Report

```
WeChat Remote Control uninstalled

Removed: agent hooks (Claude + Codex), status line, bridge daemon, socket, runtime state.
Kept:    login credentials, message history, logs.

Claude Code / Codex are back to their original behaviour. Run /wechat-remote-control attach
to set it up again (no re-login needed).

To remove everything including credentials: rm -rf ~/.wechat-remote-control
```

Re-running **uninstall** when nothing is installed is safe — every step is a no-op on
already-clean state.
