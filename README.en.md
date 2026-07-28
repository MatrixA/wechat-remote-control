# wechat-remote-control

> Drive Claude Code and Codex — running in tmux on your own machine — from Telegram or WeChat. Walk away from the desk; the work keeps moving.

English · [中文](./README.md)

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen)](https://nodejs.org/)
[![Claude Code Skill](https://img.shields.io/badge/Claude%20Code-Skill-8a4cf2)](https://docs.claude.com/en/docs/claude-code/skills)

---

## What it solves

An agent is mid-task in your terminal — long refactor, batch analysis, slow tool calls — and you want to leave, yet still redirect it, check progress, or add a follow-up.

- Messages you send in the IM are injected into the agent's pane via `tmux send-keys`
- The agent's replies (tool summaries, errors, diffs) are forwarded back through hooks
- What you type **at the terminal** is never broadcast outward

IM: **Telegram** (recommended, full feature set) or **WeChat**. Agents: **Claude Code** and **Codex CLI**, auto-detected at `attach`.

---

## Install

```bash
npx skills add MatrixA/wechat-remote-control      # recommended
```

Manual clone — Claude reads `~/.claude/skills/`, Codex reads `~/.agents/skills/`:

```bash
git clone https://github.com/MatrixA/wechat-remote-control.git \
  "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/wechat-remote-control"
# update: git -C <that path> pull
```

Then, inside a tmux-hosted agent session:

```
/wechat-remote-control login --telegram   # first-time login (drop the flag for WeChat QR)
/wechat-remote-control attach             # register this session as the remote target (the default with no arg)
/wechat-remote-control sync               # print the conversation since last attach, for context
/wechat-remote-control uninstall          # remove hooks / status line / daemon, keep credentials
```

Two notes:

- Driving both Claude and Codex? Run attach **once under each agent** — only attach installs hooks.
- **Codex reads `hooks.json` only at startup** — restart it after the first hook install (`codex resume --last` keeps the conversation).

---

## Telegram (recommended)

Create a bot via **@BotFather**, paste the token into `login --telegram`, then send the bot `/start`. **The first chat to message the bot is locked as the only authorized one** — the token grants terminal control, so keep it secret.

**Forum Topics mode.** Create a supergroup with Topics enabled, add the bot as an admin with *Manage Topics*, and send `/bind`. From then on **every tmux session gets its own topic**, isolated like a Slack channel: messages typed in a topic go to that session, and replies, status and quizzes stay there. Session renames propagate to the topic — and **renaming a topic in the Telegram UI syncs back** (the pane's tmux window is renamed and pinned, so rescans keep it). A closed session's topic is archived and reused if the session returns. The General topic and the private chat remain the lobby.

**Focus mode (`/fc`).** Once you have many panes the topic list explodes. `/fc` lists your tmux sessions (one ≈ one project) with tap-to-focus buttons; focusing keeps topics only for that session's panes and **deletes every other topic** — Telegram has no true per-topic hide (closing merely greys one out while it still takes up space), so focus deletes, and **topic history goes with it**. Focus is **sticky**: there is no "show all", and with several sessions and none focused the default route's session is auto-focused. Switching, or re-focusing the same session after manually deleting its topic, recreates topics and **replays the last few rounds** as context. Focus only filters visibility — the default route is untouched and in-flight turns keep running (a busy session's topic is deleted only after its turn ends; output for an already-deleted topic falls back to General, tagged with the session name).

**Native capabilities** (WeChat falls back to numbered text menus):

| | |
|---|---|
| Command menu | `/ls` `/sw` `/fc` `/model` `/rename` `/rnt` `/esc` `/reset` `/bind` `/start` |
| Live turn status | One message edited in place: elapsed time, tool count, current tool, plus a **⏹ interrupt button** |
| Reactions | 👀 injected · 👍 answered · 💔 abandoned |
| Inline keyboards | `/ls` `/sw` `/fc` `/model`; `AskUserQuestion` renders as option buttons (multi-select supported) |
| Long replies | Medium ones collapse into an expandable quote; over 8k chars arrives as a Markdown file |
| Also | Per-topic typing indicator, markdown-rendered output, automatic `retry_after` backoff |

> If a session is stuck on "busy" and stops accepting messages, send `/reset` — it clears only the in-flight turn state; **queued messages are kept** and redelivered.

Credentials live in `~/.wechat-remote-control/telegram/account.json` (locked chat id + bound group id); WeChat files are untouched. WeChat stays functional in degraded mode: single active session, numbered text menus.

---

## Fully concurrent multi-session

The bridge auto-discovers **every** tmux pane running claude / codex. Each session owns an independent message queue, in-flight turn and live status — drive session B while A is mid-task, and every reply lands in the conversation that asked for it. Hook events route authoritatively by tmux pane id (`TMUX_PANE`), so same-cwd sessions never cross-talk. `/sw` only moves the private chat's **default route** pointer; it never interrupts in-flight work.

---

## Architecture

```
Telegram / WeChat  ⇄  cloud long-poll  ⇄  bridge daemon  ⇄ tmux send-keys ⇄  tmux pane (agent)
                                                ↑
                                  Unix socket /tmp/cc_wechat_hook.sock
                                                ↑
                                        agent hooks (hook.py)
```

- **Bridge daemon** (`src/index.js`): long-polls the IM and injects messages into the agent's pane
- **Hook server**: listens on the Unix socket; the agent's PreToolUse / Stop / Notification (Claude) / UserPromptSubmit (Codex) events arrive via `hook.py`
- **Response forwarding**: on Stop, reads the transcript, finds the reply to the message that came *from the IM*, and forwards it. Terminal-initiated turns are not broadcast.
- **Live interim forwarding**: long prose between tool calls within a turn (≥200 chars by default) goes out at PreToolUse gaps instead of waiting for the turn to end, with an end-of-turn flush as backstop — deduped and strictly ordered. `WRC_FORWARD_INTERIM=0` disables it; `WRC_INTERIM_MIN_LEN` tunes the threshold.

All state lives in `~/.wechat-remote-control/`: `accounts/` and `telegram/` (credentials), `state.json` / `sessions.json` / `sessions_state.json` (attach target / session registry / in-flight turns), `bridge.pid`, `history.jsonl`, and `logs/bridge-YYYY-MM-DD.log` (30-day retention).

---

## Operations: `bin/wrc`

The daemon is a long-lived singleton and **does not restart on `git pull`**. `WCC_TRANSPORT` / `WRC_AUTO_APPROVE` / `WRC_FORWARD_INTERIM` / `WRC_INTERIM_MIN_LEN` are read once at startup, so changing one needs a restart. `bin/wrc` needs no agent — run it from any plain terminal:

```bash
SKILL="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/wechat-remote-control"
# Codex users: SKILL=~/.agents/skills/wechat-remote-control

bash "$SKILL/bin/wrc" status                    # up or not, PID, start time, transport, registered sessions
bash "$SKILL/bin/wrc" start | stop | restart
bash "$SKILL/bin/wrc" logs -f                   # tail logs/bridge-*.log
bash "$SKILL/bin/wrc" login --telegram          # QR / token both work over ssh
bash "$SKILL/bin/wrc" hooks install --agent both
```

Put it on your PATH — a wrapper rather than a symlink, so a clone that lost its executable bit still works:

```bash
mkdir -p ~/.local/bin
printf '#!/bin/sh\nexec bash "%s/bin/wrc" "$@"\n' "$SKILL" > ~/.local/bin/wrc
chmod +x ~/.local/bin/wrc
```

**After an update**: `git -C "$SKILL" pull && wrc restart && wrc status`. `dist/` is committed and comes down with the pull, so `npm run build` is **normally not needed** — only if you edited `src/*.ts` yourself (`npm install && npm run build`).

Restarting is safe and **does not require re-running `attach`**: the daemon unlinks its socket synchronously on exit, recovers in-flight turns from `sessions_state.json`, rediscovers tmux sessions on its 30s scan, and leaves the hooks (one-time config) alone.

> IM behaviour looking stale — new features missing, old bugs still there? Suspect an un-restarted daemon first: if `wrc status`'s start time predates `git -C "$SKILL" log -1 --format=%cd`, run `wrc restart`.

**Bootstrapping a headless box**: `wrc login` → `wrc hooks install --agent both` → `wrc start`, then start the agent in tmux as usual — the 30s scan finds and registers it. You only need `attach` inside an agent to pin which session is the default route (it locates the pane by walking process ancestry, which a plain terminal cannot do).

> Starting the daemon by hand has two traps. **Kill before you start** — the socket singleton makes the new process exit immediately while the old one lives, yet `nohup` still prints a PID that looks like success. And **never `pkill -f .../src/index.js`** — agents wrap commands in `bash -c "..."`, so that pattern matches the wrapping shell itself. `bridge.pid` is the only safe handle.

---

## Sub-commands

| | |
|---|---|
| `login` | Authenticate the IM. WeChat prints a QR (auto-refreshed about every 60s); Telegram takes a BotFather token. |
| `attach` | Register this session as the remote target: `detect.py` walks the `/proc` (Linux) or `ps` (macOS) ancestry to the real agent process and verifies it lives in a tmux pane → writes the registry → starts the daemon in the background → sends a welcome message. Claude's status line then shows `💬 已连微信 (遥控中)` or `(#sw 可切入)`; under Telegram it reads "TG". |
| `sync` | Render `history.jsonl` as a readable transcript so a fresh session can pick up the context. |
| `uninstall` | Precisely removes wrc's hooks (matched by the `wechat-remote-control/hook.py` marker — other tools' hooks and unrelated settings survive), removes the status line (only if it still points at this skill), stops the daemon and deletes runtime state. **Keeps** credentials, `history.jsonl` and `logs/`. To drop credentials too: `rm -rf ~/.wechat-remote-control`. |

> With remote control off, the hooks attach installed already no-op — `hook.py` exits 0 immediately when the socket is absent — so normal usage is barely affected.

---

## Requirements

macOS or Linux with `tmux`, **Node ≥ 18**, **Python 3** (`detect.py` for the ancestry walk, `hook.py` for hook events), and the agent running inside a tmux pane.

> ❌ Cloud / remote Claude Code (`CLAUDE_CODE_REMOTE=true`) is not supported — the bridge needs local tmux + Unix sockets.

**Behind a proxy**: export `HTTPS_PROXY` / `HTTP_PROXY` in the **same shell** you launch the skill from. The login process and the daemon both carry `NODE_USE_ENV_PROXY=1`, so Node's built-in `fetch` picks them up. Note that `fetch` support for that flag requires **Node ≥ 24 (or ≥ 22.21)** — older versions silently ignore it. For WeChat, the proxy must allow `ilinkai.weixin.qq.com` and `novac2c.cdn.weixin.qq.com`.

---

## Security

- **Local-only state** — credentials and session data never leave `~/.wechat-remote-control/`; nothing is uploaded but IM API traffic
- **Terminal isolation** — local input is never forwarded; only replies to messages that came from the IM go back
- **Process safety** — Python `/proc` scanning instead of `pgrep -f`, which would match the `bash -c "..."` wrapper shell and could kill the wrong process
- **Auto-approve scope** — when on, hooks approve tool calls inline. Convenient, but it means anyone with access to your IM can trigger actions on your machine. Treat this skill like SSH access.

---

## Repository layout

```
SKILL.md            # skill entry: full runbook for login / attach / sync / uninstall
src/  dist/         # TypeScript source / pre-built JS (dist is committed; SKILL.md references it)
bin/wrc             # terminal ops entry: daemon lifecycle / login / hooks, no agent needed
detect.py           # cross-platform /proc + ps agent-in-tmux detector
hook.py             # agent hook entry — relays events to the bridge
format_history.py   # history.jsonl → readable text
status.sh           # one-shot bridge / account / session status
```

---

## License & contributing

MIT — see [LICENSE](./LICENSE).

Issues and PRs welcome. For bugs, please include `bash status.sh` output, the last 50 lines of `logs/bridge-*.log`, and your `tmux -V` / `node --version` / OS. For new features (image or voice forwarding, group chat support), open an issue first.

After changing `src/*.ts`, run `npm install && npm run build` and commit the regenerated `dist/` — CI verifies the two match.
