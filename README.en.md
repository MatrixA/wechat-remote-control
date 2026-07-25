# wechat-remote-control

> Chat with Claude Code from WeChat — a Claude Code Skill that bridges your personal WeChat to a local Claude Code session running in tmux.
>
> 用微信遥控你电脑里跑着的 Claude Code —— 走开了也能继续指挥 / 收回执。

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen)](https://nodejs.org/)
[![Claude Code Skill](https://img.shields.io/badge/Claude%20Code-Skill-8a4cf2)](https://docs.claude.com/en/docs/claude-code/skills)

---

## What it does / 它做什么

When you're away from your terminal but a Claude Code task is still running — long refactor, batch analysis, slow tool calls — you can register the current CC session as a "WeChat remote target" and continue interacting from your phone:

- 微信对话框里发什么，就被 `tmux send-keys` 注入到本地 CC 所在的 pane
- CC 的回复（带 tool call 摘要、报错、文件 diff）通过 hook 转发回微信
- 终端那边的本地输入 **不会** 被反向广播到微信，避免泄漏交互

---

## Architecture / 架构

```
+---------+       +-------------------+       +---------------+       +-------------+
| WeChat  | <---> |  ilink long-poll  | <---> | bridge daemon | <---> | tmux + CC   |
| (phone) |       |  (cloud)          |       | (this repo)   |  PTY  | (your Mac)  |
+---------+       +-------------------+       +-------------------+   +-------------+
                                                       ^
                                                       | Unix socket
                                                       |
                                                CC hooks (hook.py)
```

- **Bridge daemon** (`src/index.js` → `dist/...`): polls ilink WeChat API for messages and injects them into the user's tmux-hosted CC session via `tmux send-keys`.
- **Hook server**: listens on Unix socket `/tmp/cc_wechat_hook.sock`. CC hooks (PreToolUse / Stop / Notification) send events here via `hook.py`.
- **Response forwarding**: on Stop / Notification, reads the CC transcript JSONL, finds the response to the injected WeChat message, and forwards it to WeChat. Terminal-initiated responses are not forwarded.
- **Real-time interim forwarding**: long prose emitted between tool calls within a turn (explanations, findings — ≥200 chars by default) is forwarded live at PreToolUse gaps instead of waiting for the turn to end; an end-of-turn flush backstops anything missed, with dedup and strict ordering. `WRC_FORWARD_INTERIM=0` disables, `WRC_INTERIM_MIN_LEN` tunes the threshold (read at daemon startup — restart the daemon to change).
- **All state lives in one directory** — `~/.wechat-remote-control/`:
  - `accounts/<accountId>.json` — WeChat credentials
  - `state.json` / `sessions.json` — attach target & multi-session registry
  - `ilink_session.json` — long-poll cursor
  - `bridge.json` / `bridge.pid` / `cc_pid` — daemon metadata
  - `logs/bridge-YYYY-MM-DD.log` — rotated logs (30-day retention)
  - `history.jsonl` — injected messages and forwarded responses

---

## Fully concurrent multi-session

The bridge auto-discovers **every** tmux pane running claude / codex. Each session owns
an independent message queue, in-flight turn and live status — you can drive session B
while session A is mid-task, and every reply lands back in the conversation that asked
for it. Hook events route authoritatively by tmux pane id (`TMUX_PANE`), so same-cwd
sessions never cross-talk. `/sw` only moves the private-chat *default route* pointer and
never interrupts any session's in-flight work.

---

## Telegram support (recommended)

The same machinery (tmux injection, hook forwarding, multi-session, auto-approve) also
works over a **Telegram bot** — the IM layer is abstracted behind a `Transport` interface
(`src/transport/`), with WeChat and Telegram each implemented as an adapter.

- **Login**: `/wechat-remote-control login --telegram` — create a bot via **@BotFather**,
  paste the token, then send the bot `/start`. The first chat to message the bot is
  **locked** as the only authorized chat (the token grants terminal control — keep it secret).
- **Forum Topics mode (best experience)**: create a supergroup with Topics enabled, add
  the bot as an admin with *Manage Topics*, and send `/bind` in the group — **every tmux
  session automatically gets its own forum topic**, isolated like a Slack channel:
  messages typed in a topic go to that session; replies, status updates and quizzes stay
  there. Renames propagate to the topic — and **renaming a topic directly in the Telegram
  UI syncs back** (the pane's tmux window is renamed and pinned, so rescans keep it).
  A closed session's topic is archived and reused if the session comes back. The General
  topic and the private chat remain the "lobby" (the compact `/ls` tmux-session list with
  tap-to-focus buttons; the `/sw` menu with busy states and topic deep links; global
  commands; the default-route destination).
- **Focus mode (`/fc`)** for when the topic list explodes: `/fc` lists your tmux sessions
  (one tmux session ≈ one project) with tap-to-focus buttons. Focusing keeps topics only
  for panes of that tmux session and **deletes every other topic** (Telegram has no true
  per-topic hide — closing merely greys a topic out — so focus deletes; **topic history is
  deleted with it**). Focus is **sticky** — `/fc` only switches which session is focused
  (there is no "show all"); with several tmux sessions and none focused, the default
  route's session is auto-focused. Refocusing — `/fc <other>`, or `/fc` the same session
  after manually deleting a topic — recreates topics with a replay of the last few
  conversation rounds. Focus only filters topic visibility: the default
  route (`/sw`) and in-flight turns are untouched (a busy session's topic is deleted only
  after its turn ends; output for an already-deleted topic falls back to General, tagged
  with the session name).
- **Transport selection** at attach: `WCC_TRANSPORT` env > `--telegram`/`--wechat` > whichever
  credentials exist on disk.
- **Native Telegram capabilities**:
  - command menu (`/ls` `/sw` `/fc` `/model` `/rename` `/esc` `/bind` `/start`)
  - **live turn status**: one message per turn, edited in place with elapsed time, tool
    count and the current tool, plus a **⏹ interrupt button** (sends Escape to the pane)
  - **reactions** on your message: 👀 injected, 👍 answered, 💔 abandoned
  - inline keyboards for `/ls`, `/sw`, `/fc` & `/model`; quiz option buttons (multi-select supported)
  - **long replies don't wallpaper the chat**: medium ones collapse into an expandable
    quote; anything over 8k chars arrives as a Markdown **file**
  - per-topic typing indicator, markdown-rendered output, automatic `retry_after`
    backoff on rate limits
- Credentials live in `~/.wechat-remote-control/telegram/account.json` (locked chat id +
  bound group id); WeChat files are untouched. WeChat stays functional in degraded mode:
  single active session + numbered text menus, exactly as before.

---

## Requirements / 依赖

- **macOS or Linux** with `tmux` installed
- **Node.js ≥ 18** (ESM imports are used throughout the bridge)
- **Python 3** (used by `detect.py` for `/proc` / `ps` ancestry walk and by `hook.py`)
- **A working WeChat account** that can scan QR codes (the QR rotates every ~60 s; the skill auto-refreshes)
- **Claude Code** running inside a tmux pane

> ❌ Cloud / remote Claude Code sessions (those with `CLAUDE_CODE_REMOTE=true`) are not supported — the bridge needs local tmux + Unix sockets.

---

## Behind a proxy / 代理环境

If your terminal can only reach the internet through a local proxy, export the proxy in
the **same shell** you launch the skill from:

```bash
export HTTPS_PROXY=http://127.0.0.1:7890   # your proxy
export HTTP_PROXY=http://127.0.0.1:7890
# export NO_PROXY=localhost,127.0.0.1       # optional: bypass intranet hosts
```

The login process and the bridge daemon launch with `NODE_USE_ENV_PROXY=1` by default, so
Node's built-in `fetch` automatically routes through those variables — no code changes
needed. Notes:

- `fetch` support for this flag requires **Node ≥ 24** (or **≥ 22.21**); older Node silently ignores it, so the proxy won't take effect — upgrade Node first.
- With no proxy vars set the flag is a harmless no-op; direct-connection users are unaffected.
- The proxy must allow the WeChat hosts `ilinkai.weixin.qq.com` and `novac2c.cdn.weixin.qq.com`.

---

## Install as a Claude Code Skill / 作为 Claude Code Skill 安装

### Option A — `npx skills` (recommended / 推荐)

[`npx skills`](https://github.com/vercel-labs/skills) is a community package manager for agent skills that uses GitHub as its registry. One command installs this skill into `~/.claude/skills/`:

```bash
npx skills add MatrixA/wechat-remote-control
```

To target a specific agent, pass `-a`:

```bash
npx skills add MatrixA/wechat-remote-control -a claude-code
```

You can list / update / remove later with `npx skills list`, `npx skills update`, `npx skills remove`.

### Option B — manual clone

```bash
# install
git clone https://github.com/MatrixA/wechat-remote-control.git "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/wechat-remote-control"

# update
git -C "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/wechat-remote-control" pull
```

### Option C — Codex CLI

Codex loads skills from `~/.agents/skills/` (not `~/.claude/skills/`), so install there:

```bash
# install
git clone https://github.com/MatrixA/wechat-remote-control.git ~/.agents/skills/wechat-remote-control

# update
git -C ~/.agents/skills/wechat-remote-control pull
```

`attach` auto-detects the running agent: for Codex it writes hooks into
`~/.codex/hooks.json` (events `PreToolUse` / `Stop` / `UserPromptSubmit`); for Claude it
writes `~/.claude/settings.json` (`PreToolUse` / `Stop` / `Notification`). The registered
hook command is guarded — if `hook.py` is missing it silently no-ops and never blocks a
prompt.

Two notes:

- If you drive both Claude and Codex, run attach **once under each agent** (only attach installs hooks).
- Codex reads `hooks.json` only at startup: restart it after the first hook install
  (`codex resume --last` keeps the conversation context).

### Then use it

Inside a tmux-hosted Claude Code session:

```
/wechat-remote-control login      # one-time WeChat QR login
/wechat-remote-control attach     # register this CC session as the WeChat remote target
/wechat-remote-control sync       # show WeChat history since last attach (for context)
/wechat-remote-control uninstall  # remove all traces (hooks / status line / daemon), keep credentials
```

If you just type `/wechat-remote-control` with no arg, it defaults to **attach**.

> The skill itself is driven by `SKILL.md`. Read that file for the full operational runbook (environment checks, QR rotation handling, error recovery).

---

## Four sub-commands / 四个子命令

### `login`

Authenticate a WeChat account by scanning a QR code printed in the terminal. Run once before first use, or whenever the bridge reports session expiry. Credentials are saved to `~/.wechat-remote-control/accounts/<accountId>.json`. The QR auto-refreshes if you don't scan in time.

### `attach`

Registers the current Claude Code session as the WeChat remote target.

1. `detect.py` walks the `/proc` parent chain (Linux) or `ps` ancestry (macOS) up from the bash subprocess, finds the actual `claude` process, and verifies it lives inside a `tmux list-panes -a` pane.
2. Writes `state.json` / `bridge.json` / `sessions.json` so the daemon knows which pane to inject into.
3. Starts the bridge daemon in the background (single-instance — re-attaching from another session moves the target).
4. Sends a welcome message to the linked WeChat user so they know the channel is live.

### `sync`

Renders WeChat conversation history since last attach as a readable transcript, so a fresh CC session can pick up where the last one left off.

### `uninstall`

Reverses everything **attach** installed, so Claude Code / Codex return to their original behaviour:

1. Precisely removes wrc's hooks from `~/.claude/settings.json` and `~/.codex/hooks.json` (matched by the `wechat-remote-control/hook.py` marker — other tools' hooks and unrelated settings are preserved).
2. Removes the Claude status line (only when it still points at this skill's `status.sh`).
3. Stops the bridge daemon and deletes the socket plus runtime state (`bridge.pid` / `cc_pid` / `bridge.json` / `state.json` / `sessions.json`).
4. **Keeps** login credentials (`accounts/`, `telegram/`), `history.jsonl` and `logs/`, so a later `attach` needs no re-login.

> When remote-control isn't running, the hooks attach registered already no-op (`hook.py` exits 0 immediately if the socket is absent), so normal usage is barely affected; `uninstall` removes them entirely so nothing fires at all. To delete credentials too, run `rm -rf ~/.wechat-remote-control` afterwards.

---

## Repository layout / 目录结构

```
wechat-remote-control/
├── SKILL.md              # Claude Code skill entry — full runbook for login / attach / sync / uninstall
├── package.json          # node deps + build scripts
├── tsconfig.json
├── src/                  # TypeScript: bridge, tmux injection, ilink client, command router
├── dist/                 # Pre-built JS — SKILL.md references these paths directly
├── detect.py             # /proc + ps cross-platform CC-in-tmux detector
├── hook.py               # agent hook entry — Claude: PreToolUse/Stop/Notification; Codex: PreToolUse/Stop/UserPromptSubmit
├── format_history.py     # Render history.jsonl into human-readable text
├── status.sh             # Quick status check (bridge / account / session)
└── .gitignore
```

---

## Security notes / 安全说明

- **Local-only state.** All credentials and session data live in `~/.wechat-remote-control/` on your machine. Nothing is uploaded except WeChat API traffic.
- **Terminal isolation.** Local terminal input is never forwarded to WeChat. Only responses to messages that originated from WeChat are sent back.
- **Process safety.** The bridge uses Python `/proc` scanning instead of `pgrep -f` because Claude Code wraps commands in `bash -c "..."` — `pgrep -f` would match the wrapper shell and could kill the wrong process.
- **Auto-approve scope.** When `state.json` has `autoApprove: true`, hook events approve tool calls inline. This is convenient but means anyone with access to your WeChat account can trigger actions in your local CC. Treat this skill like SSH access to your machine.

---

## License / 许可证

MIT — see [LICENSE](./LICENSE).

---

## Contributing

Issues and PRs welcome. If you hit a bug, please include:

- Output of `bash status.sh`
- Last 50 lines of `~/.wechat-remote-control/logs/bridge-*.log`
- Your `tmux -V`, `node --version`, and OS

如果你想加新功能（图片 / 语音转发、群聊支持等）欢迎先开 Issue 讨论。

After changing `src/*.ts`, run `npm install && npm run build` and commit the regenerated `dist/` (CI verifies they match).
