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
- What you type **at the terminal** is never broadcast outward — only replies to messages that came from the IM go back

IM: **Telegram** (recommended, full feature set) or **WeChat**. Agents: **Claude Code** and **Codex CLI**, auto-detected at `attach`.

---

## Install

```bash
npx skills@latest add MatrixA/wechat-remote-control -g -y
```

> Don't drop `@latest`: installers older than 1.5.18 have a bug ([#1603](https://github.com/vercel-labs/skills/issues/1603)) that misclassifies a skill with `SKILL.md` at the repository root as a single-file skill and **installs only `SKILL.md`**, losing `bin/`, `dist/` and `src/` — the symptom is every command below failing with "no such file".

Check the install immediately; all three must be there:

```bash
WRC="$HOME/.agents/skills/wechat-remote-control"
ls -d "$WRC/bin/wrc" "$WRC/dist" "$WRC/src/index.js"
```

If only `SKILL.md` exists and the rest say `No such file`, you hit that bug — re-run the install command with `@latest`. **Do not run `npm run build`**: the files were never downloaded, so compiling cannot help.

You can also clone manually — Claude reads `~/.claude/skills/`, Codex reads `~/.agents/skills/`, and cloning into the wrong one means the agent never sees the skill at all:

```bash
# Codex users: change the target to "$HOME/.agents/skills/wechat-remote-control"
git clone https://github.com/MatrixA/wechat-remote-control.git \
  "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/wechat-remote-control"
```

If you clone manually, replace the `WRC=` line at the top of every command block below with your clone path.

Then, inside a tmux-hosted agent session:

```
/wechat-remote-control login --telegram   # first-time login (drop the flag for WeChat QR)
/wechat-remote-control attach             # register this session as the remote target (the default with no arg)
/wechat-remote-control sync               # print the conversation since last attach, for context
```

Two notes:

- Driving both Claude and Codex? Run **`attach` once under each agent** — only attach installs hooks. The daemon rescans tmux every 30s, and a session it discovers looks perfectly healthy in `status` and accepts messages, but **without hooks its replies are never sent out** — indistinguishable from a network problem.
- **Codex reads `hooks.json` only at startup** — restart it after the first hook install: `/quit`, then `codex resume --last` (keeps the conversation). Skip the restart and the IM shows "typing" forever with no reply ever arriving, and nothing in the logs explains it.

---

## Commands

`bin/wrc` needs no agent — run it from any plain terminal, including an ssh session on a headless box. The one exception is `attach`, which locates the pane by walking process ancestry and cannot work from a plain shell.

**`wrc` is never added to your PATH.** Every block below carries its own path and depends on no other block, so it runs as-is in a fresh terminal. The opening `WRC=` line is the canonical `npx` install location (`~/.claude/skills/…` is just a symlink to it); if you cloned manually somewhere else, swap in your own path.

| Operation | When you need it |
|---|---|
| [Check the install](#check-the-install) | After installing or updating, or when any command says "no such file" |
| [Log in](#log-in) | First run, or switching bot / WeChat account |
| [attach](#attach) | Make an agent session the default route target |
| [Status](#status) | Is the daemon up, which sessions are registered |
| [Logs](#logs) | Messages not arriving, replies not coming back |
| [Update](#update) | Pull new code — **always followed by a restart** |
| [Restart](#restart) | After changing an env var, or when IM behaviour looks stale |
| [Uninstall](#uninstall) | Stop remote control, keep credentials |
| [Full purge](#full-purge) | Delete the credentials too |

#### Check the install

```bash
WRC="$HOME/.agents/skills/wechat-remote-control"
ls -d "$WRC/bin/wrc" "$WRC/dist" "$WRC/src/index.js"
```

#### Log in

```bash
WRC="$HOME/.agents/skills/wechat-remote-control"
bash "$WRC/bin/wrc" login --telegram   # drop --telegram for the WeChat QR (auto-refreshed about every 60s)
```

#### attach

Type this inside the tmux-hosted agent session — this step has to happen in the agent:

```
/wechat-remote-control attach
```

On a headless box there is no interactive agent to use, so run these three first, then start the agent in tmux as usual — the 30s scan finds and registers it:

```bash
WRC="$HOME/.agents/skills/wechat-remote-control"
bash "$WRC/bin/wrc" login --telegram
bash "$WRC/bin/wrc" hooks install --agent both
bash "$WRC/bin/wrc" start
```

Do not skip the middle step — without `hooks install` you get a session that registers fine but whose replies are never forwarded.

#### Status

```bash
WRC="$HOME/.agents/skills/wechat-remote-control"
bash "$WRC/bin/wrc" status
```

Prints the start time, transport and registered sessions (`*` marks the default route). It **exits 3** when the daemon is down, so don't chain it after `&&`.

#### Logs

```bash
WRC="$HOME/.agents/skills/wechat-remote-control"
bash "$WRC/bin/wrc" logs -f   # 50 lines by default; -n 200 for more history
```

#### Update

The daemon is a long-lived singleton and **does not restart on `git pull`**, so an update is always two steps: pull, then restart. First check which install you have:

```bash
WRC="$HOME/.agents/skills/wechat-remote-control"
test -d "$WRC/.git" && echo "git clone -> use A" || echo "npx install -> use B"
```

**A. Installed with `git clone`**: `dist/` is committed and comes down with the pull, so **`npm run build` is not needed** (only if you edited `src/*.ts` yourself).

```bash
WRC="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/wechat-remote-control"   # swap in your clone path
git -C "$WRC" pull
bash "$WRC/bin/wrc" restart
bash "$WRC/bin/wrc" status
```

**B. Installed with `npx skills add`**: the result is a file copy, not a git checkout (the installer excludes `.git`), so `git pull` fails with `not a git repository` — you update by re-running the install. **Pin `@latest` here too**: `npx skills update <name>` merely re-runs `add` internally and never upgrades the installer itself, so anything below 1.5.18 will once again install nothing but `SKILL.md`.

```bash
npx skills@latest add MatrixA/wechat-remote-control -g -y
WRC="$HOME/.agents/skills/wechat-remote-control"
ls -d "$WRC/bin/wrc" "$WRC/dist" "$WRC/src/index.js"   # confirm it landed complete
bash "$WRC/bin/wrc" restart
bash "$WRC/bin/wrc" status
```

#### Restart

`WCC_TRANSPORT` / `WRC_AUTO_APPROVE` / `WRC_FORWARD_INTERIM` / `WRC_INTERIM_MIN_LEN` are read once at daemon startup — changing one takes effect only after a restart.

```bash
WRC="$HOME/.agents/skills/wechat-remote-control"
bash "$WRC/bin/wrc" restart
bash "$WRC/bin/wrc" status
```

Restarting is safe and **does not require re-running `attach`**: in-flight turns are recovered, tmux sessions are rediscovered on the 30s scan, and hooks are one-time config in a file.

#### Uninstall

```bash
WRC="$HOME/.agents/skills/wechat-remote-control"
bash "$WRC/bin/wrc" hooks uninstall --agent both
bash "$WRC/bin/wrc" stop
```

Removes only wrc's own hooks, matched by the `wechat-remote-control/hook.py` marker — **other tools' hooks and unrelated settings survive** — and removes the status line only if it still points at this skill. Credentials, `history.jsonl` and `logs/` are all **kept**, so a later attach needs no re-login. Running `/wechat-remote-control uninstall` inside the agent is equivalent.

#### Full purge

This is the step that deletes your credentials and bound group — run it and you will have to log in again.

```bash
rm -rf ~/.wechat-remote-control
```

---

## What you can do from the IM

Create a bot via **@BotFather**, paste the token into `login --telegram`, then send the bot `/start`. **The first chat to message the bot is locked in as the only authorized one** (so a second person's messages being ignored is not a bug), and the token grants terminal control, so keep it secret.

**Forum Topics mode.** Create a supergroup with Topics enabled, add the bot as an **admin with the *Manage Topics* right** (without it topic creation fails and the whole multi-session UX silently degrades to the lobby), and send `/bind` in the group. From then on every tmux pane gets its own topic, isolated like a Slack channel: messages typed in a topic go to that session, and replies, status and quizzes stay there. Session renames propagate to the topic, and renaming a topic in the Telegram UI syncs back to the tmux window name. The General topic and the private chat remain the lobby.

**Focus mode (`/fc`).** Once you have many panes the topic list explodes. `/fc` lists your tmux sessions with tap-to-focus buttons; focusing keeps that session's topics and **deletes every other one — their history goes with them** (Telegram has no true per-topic hide; closing merely greys one out while it still takes up space). Focus is **sticky**, there is no "show all", and with several sessions and none focused the bridge focuses the default route's session **on its own** — so the deletion can happen without you ever typing `/fc`. Switching back recreates that session's topics and replays the last few rounds as context; focus only filters visibility, leaving the default route and in-flight turns alone.

**Fully concurrent multi-session.** The bridge auto-discovers every tmux pane running claude / codex, each with its own queue, in-flight turn and live status — drive session B while A is mid-task, and every reply lands in the conversation that asked for it. Hook events route authoritatively by tmux pane id, so same-cwd sessions never cross-talk. `/sw` only moves the private chat's **default route** pointer; it never interrupts in-flight work.

**Command menu:** `/ls` `/sw` `/fc` `/model` `/rename` `/rnt` `/esc` `/reset` `/bind` `/start`

Telegram also gives you: a live turn-status message edited in place (with a ⏹ interrupt button), reactions (👀 injected · 👍 answered · 💔 abandoned), inline keyboards, `AskUserQuestion` rendered as option buttons, and very long replies delivered as a Markdown file. WeChat stays functional in degraded mode: single active session, numbered text menus.

<details>
<summary>How it works</summary>

```
Telegram / WeChat  ⇄  cloud long-poll  ⇄  bridge daemon  ⇄ tmux send-keys ⇄  tmux pane (agent)
                                                ↑
                                  Unix socket /tmp/cc_wechat_hook.sock
                                                ↑
                                        agent hooks (hook.py)
```

The daemon long-polls the IM and injects messages into the agent's pane; the agent's hook events reach the Unix socket via `hook.py`; at the end of a turn it reads the transcript and forwards only the reply to the message that came from the IM. Long prose between tool calls within a turn is forwarded live at the gaps (`WRC_FORWARD_INTERIM=0` disables it). All runtime state lives in `~/.wechat-remote-control/` — credentials, the session registry, `history.jsonl` and `logs/` — which is also what "full purge" deletes.

</details>

---

## Troubleshooting

**`wrc: command not found`, or `bin/wrc` is missing** — it is never added to your PATH; use the `bash "$WRC/bin/wrc" …` form from the blocks above. If even the file does not `ls`, your install is incomplete or too old (`bin/wrc` was added in a fairly recent version) — run [Update](#update), then [Check the install](#check-the-install) again. With several clones on one machine, only the one `$WRC` points at counts.

**IM behaviour looks stale** (new features missing, fixed bugs still there) — suspect an un-restarted daemon first: if `status`'s start time predates your repo's latest commit, [restart](#restart).

**A session is stuck on "busy" and stops accepting messages** — send `/reset` in the IM. It clears only the in-flight turn state; **queued messages are kept** and redelivered.

**Don't kill the daemon by hand** — and especially never `pkill -f .../src/index.js`: agents wrap commands in `bash -c "…"`, so that pattern matches the wrapping shell and kills your own session. `bridge.pid` is the only safe handle, and `wrc stop` / `wrc restart` already handle it.

---

## Requirements & security

macOS or Linux with `tmux`, **Node ≥ 18**, **Python 3** (`detect.py` for the ancestry walk, `hook.py` for hook events), and the agent running inside a tmux pane.

> ❌ Cloud / remote Claude Code (`CLAUDE_CODE_REMOTE=true`) is not supported — the bridge needs local tmux + Unix sockets.

**Behind a proxy**: export `HTTPS_PROXY` / `HTTP_PROXY` in the **same shell** you launch the daemon from (it inherits the environment once, at startup). The login process and the daemon both carry `NODE_USE_ENV_PROXY=1`, but Node's built-in `fetch` only honours that flag on **Node ≥ 24 (or ≥ 22.21)** — older versions silently ignore it, and the symptom is a daemon that starts cleanly, prints a PID, and then **never receives a single message, with no error anywhere**. For WeChat, the proxy must also allow `ilinkai.weixin.qq.com` and `novac2c.cdn.weixin.qq.com`.

Four things worth knowing up front:

- **Tool calls are auto-approved by default.** This is the daemon's default behaviour, not a switch you turn on — which means **anyone who can message your bot can run commands on your machine**. Treat this skill like SSH access. To turn it off, set `WRC_AUTO_APPROVE=0` and then **restart the daemon** (env is read once at startup, so changing it without a restart does nothing); with it off the hook stops deciding and the agent's own permission flow takes over.
- **The bot token is equivalent to terminal control**, and the first chat to message the bot is locked in as the only authorized one.
- **Local-only state** — credentials and session data never leave `~/.wechat-remote-control/`; nothing is uploaded but IM API traffic.
- **Process safety** — Python `/proc` scanning instead of `pgrep -f`, which would match the `bash -c "…"` wrapper shell and could kill the wrong process.

---

## License & contributing

MIT — see [LICENSE](./LICENSE).

Issues and PRs welcome. For bugs, please include the output of `bash "$WRC/bin/wrc" status` and `bash "$WRC/bin/wrc" logs -n 50`, plus your `tmux -V` / `node --version` / OS. For new features (image or voice forwarding, group chat support), open an issue first.

After changing `src/*.ts`, run `npm install && npm run build` and commit the regenerated `dist/` — CI verifies the two match.
