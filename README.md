# wechat-remote-control

> 在 Telegram / 微信 里遥控本机 tmux 中的 Claude Code 与 Codex —— 人离开工位，活照样往下推。

[English](./README.en.md) · 中文

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen)](https://nodejs.org/)
[![Claude Code Skill](https://img.shields.io/badge/Claude%20Code-Skill-8a4cf2)](https://docs.claude.com/en/docs/claude-code/skills)

---

## 它解决什么问题

终端里 agent 正在跑长任务（重构、批量分析、慢工具调用），你想走开，但还想改方向、看进度、补一句指令。

- IM 里发的消息 → `tmux send-keys` 注入 agent 所在 pane
- agent 的回复（工具摘要、报错、diff）→ 经 hook 转回 IM
- 终端里手敲的内容**不会**反向外发

IM 支持 **Telegram**（推荐，能力最全）和**微信**；agent 支持 **Claude Code** 与 **Codex CLI**，`attach` 时自动识别。

---

## 安装

```bash
npx skills add MatrixA/wechat-remote-control      # 推荐
```

手动 clone —— Claude 装 `~/.claude/skills/`，Codex 装 `~/.agents/skills/`：

```bash
git clone https://github.com/MatrixA/wechat-remote-control.git \
  "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/wechat-remote-control"
# 更新：git -C <上面那个路径> pull
```

然后在 tmux 里的 agent 会话中：

```
/wechat-remote-control login --telegram   # 首次登录（去掉 --telegram 则走微信扫码）
/wechat-remote-control attach             # 注册当前会话为遥控目标（不带参数默认就是它）
/wechat-remote-control sync               # 打印上次 attach 以来的对话，给新会话补上下文
/wechat-remote-control uninstall          # 清除 hook / 状态栏 / daemon，保留登录凭据
```

两个注意：

- Claude 和 Codex 都用时，**每种 agent 各跑一次 attach**（hook 只由 attach 安装）
- **Codex 只在启动时读 `hooks.json`** —— 首次装完 hook 要重启 Codex（`codex resume --last` 保上下文）

---

## Telegram（推荐）

在 **@BotFather** 建 bot、把 token 粘给 `login --telegram`，再给 bot 发 `/start`。**第一个跟 bot 说话的会话被锁定为唯一授权会话** —— token 等同终端控制权，请妥善保管。

**话题模式**：建一个开启「话题」的超级群，把 bot 加为管理员（勾「管理话题」），群里发 `/bind`。之后**每个 tmux 会话自动获得专属话题**，像 Slack 频道一样隔离：在话题里发消息就发到对应会话，回复、状态、问卷都留在话题里。会话改名话题跟着改，**在 Telegram 里长按话题改名也会反向同步**（重命名并固定对应 tmux 窗口，扫描不会改回去）；会话关掉话题自动归档，同名会话回来自动复用。General 话题和私聊继续当「大厅」。

**聚焦（`/fc`）**：面板一多话题列表就爆炸。`/fc` 列出 tmux 会话（≈ 一个项目）点选聚焦，**只保留该会话下各面板的话题，其余直接删除** —— Telegram 没有真正的「隐藏话题」，关闭只会灰显仍占位，所以聚焦采用删除，**历史随话题一起没**。聚焦是**粘性**的，没有「全部显示」；多会话而未聚焦时自动聚焦默认路由所在的会话。切到别的会话、或手动删掉话题后重新 `/fc` 同一个，都会重建话题并**回放最近几轮**作上下文。聚焦只影响可见性：默认路由不动，进行中的回合照跑（忙碌会话的话题等回合结束才删，删后仍有输出会转投 General 并带【会话名】前缀）。

**原生能力**（微信不支持的自动降级为文字菜单）：

| | |
|---|---|
| 命令菜单 | `/ls` `/sw` `/fc` `/model` `/rename` `/rnt` `/esc` `/reset` `/bind` `/start` |
| 实时回合状态 | 一条就地编辑的消息：耗时、已调用工具数、最近工具名，附 **⏹ 中断按钮** |
| 消息回应 | 👀 已注入 · 👍 已回复 · 💔 已放弃 |
| 内联键盘 | `/ls` `/sw` `/fc` `/model` 点选切换；`AskUserQuestion` 渲染成选项按钮（多选可勾选后「完成」） |
| 长回复不刷屏 | 中长的折叠进「展开引用」，超 8000 字符直接发成 Markdown 文件 |
| 其它 | 每话题独立打字状态、Markdown 渲染、限流按 `retry_after` 退避 |

> 会话卡在「忙碌」不动、消息发不进去时，发 `/reset` —— 只清进行中回合的状态，**排队的消息不丢**，会重新投递。

凭据存 `~/.wechat-remote-control/telegram/account.json`（含锁定的 chat id 与绑定群 id），微信文件原样不动。微信侧保持可用但降级：单活跃会话 + 数字文字菜单。

---

## 多会话完全并发

桥接自动发现 tmux 里**所有**跑着 claude / codex 的面板，每个会话有独立的消息队列、独立的进行中回合、独立的状态提示 —— A 会话跑长任务时照样可以指挥 B，各自的回复回到各自的对话里。hook 事件按 `TMUX_PANE`（面板 id）权威路由，同目录多会话也不会串。`/sw` 只移动私聊消息的**默认路由**指针，不打断任何会话的进行中工作。

---

## 架构

```
Telegram / 微信  ⇄  云端 long-poll  ⇄  bridge daemon  ⇄ tmux send-keys ⇄  tmux pane (agent)
                                            ↑
                                Unix socket /tmp/cc_wechat_hook.sock
                                            ↑
                                    agent hooks (hook.py)
```

- **bridge daemon**（`src/index.js`）：长轮询 IM，把消息注入 agent 所在面板
- **hook 服务**：监听 Unix socket，agent 的 PreToolUse / Stop / Notification(Claude) / UserPromptSubmit(Codex) 事件经 `hook.py` 送来
- **回执转发**：Stop 时读 transcript，找出「来自 IM 那条消息」对应的回复转回去；终端发起的回合不广播
- **中间长回复实时转发**：一个回合里工具调用之间的长段落（默认 ≥200 字符）在 PreToolUse 间隙就转出去，回合结束兜底补漏，不重复不乱序。`WRC_FORWARD_INTERIM=0` 关闭，`WRC_INTERIM_MIN_LEN` 调阈值

运行态集中在 `~/.wechat-remote-control/`：`accounts/` `telegram/`（凭据）、`state.json` / `sessions.json` / `sessions_state.json`（attach 目标 / 会话注册表 / 进行中回合）、`bridge.pid`、`history.jsonl`、`logs/bridge-YYYY-MM-DD.log`（留 30 天）。

---

## 运维：`bin/wrc`

daemon 是常驻单例，**不随 `git pull` 自动重启**；`WCC_TRANSPORT` / `WRC_AUTO_APPROVE` / `WRC_FORWARD_INTERIM` / `WRC_INTERIM_MIN_LEN` 也只在启动时读一次，改完必须重启。`bin/wrc` 不依赖 agent，任何普通终端都能跑：

```bash
SKILL="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/wechat-remote-control"
# Codex 用户：SKILL=~/.agents/skills/wechat-remote-control

bash "$SKILL/bin/wrc" status                    # 在不在跑、PID、启动时间、transport、已注册会话
bash "$SKILL/bin/wrc" start | stop | restart
bash "$SKILL/bin/wrc" logs -f                   # tail logs/bridge-*.log
bash "$SKILL/bin/wrc" login --telegram          # 二维码 / token 在 ssh 里也能完成
bash "$SKILL/bin/wrc" hooks install --agent both
```

挂到 PATH 上更顺手（用 wrapper 不用软链，这样 clone 丢了可执行位也不影响）：

```bash
mkdir -p ~/.local/bin
printf '#!/bin/sh\nexec bash "%s/bin/wrc" "$@"\n' "$SKILL" > ~/.local/bin/wrc
chmod +x ~/.local/bin/wrc
```

**更新后重启**：`git -C "$SKILL" pull && wrc restart && wrc status`。`dist/` 是提交进仓库的，**正常不需要** `npm run build` —— 只有你自己改过 `src/*.ts` 才要 `npm install && npm run build`。

重启是安全的，**不需要重跑 `attach`**：daemon 退出时同步删 socket，进行中回合从 `sessions_state.json` 恢复，tmux 会话由每 30s 的扫描重新发现，hook 是写在配置文件里的一次性设置。

> IM 那边行为看着「过时」（新功能没有、老 bug 还在）？先怀疑 daemon 没重启：`wrc status` 的启动时间比 `git -C "$SKILL" log -1 --format=%cd` 早，就 `wrc restart`。

**无头机器**：`wrc login` → `wrc hooks install --agent both` → `wrc start`，然后在 tmux 里正常起 agent，30s 内自动发现并注册。只有想指定「默认路由到哪个会话」时才需要进 agent 跑一次 `attach`（它靠进程父链定位 pane，普通终端做不到）。

> 手工起 daemon 时两个坑：**必须先 kill 再起** —— socket 单例锁会让新进程在旧进程还活着时立刻自杀，而 `nohup` 那行照样打印一个 PID，看着像成功了；**别用 `pkill -f .../src/index.js`** —— agent 把命令包在 `bash -c "..."` 里，这个 pattern 会匹配到包裹 shell 自己。`bridge.pid` 是唯一安全句柄。

---

## 子命令

| | |
|---|---|
| `login` | 登录 IM。微信扫码（QR 约 60s 自动刷新一张）；Telegram 粘 BotFather token |
| `attach` | 注册当前会话为遥控目标：`detect.py` 沿 `/proc`(Linux) / `ps`(macOS) 父链找到真正的 agent 进程并确认它在 tmux 里 → 写注册表 → 后台拉起 daemon → 发一条欢迎消息确认通道。Claude 状态栏随后显示 `💬 已连微信 (遥控中)` 或 `(#sw 可切入)`，Telegram 下标签为「TG」 |
| `sync` | 把 `history.jsonl` 渲染成可读对话记录，给新会话建立上下文 |
| `uninstall` | 精确移除 wrc 的 hook（按 `wechat-remote-control/hook.py` 标记匹配，别人的 hook 与其它设置原样保留）、移除状态栏（仅当它指向本 skill）、停 daemon 并删运行态；**保留**凭据、`history.jsonl`、`logs/`。想连凭据一起删，之后 `rm -rf ~/.wechat-remote-control` |

> 没开遥控时，attach 装的 hook 本就会因 socket 不存在而立即 `exit 0` 静默 no-op，对正常使用几乎零影响。

---

## 依赖

macOS / Linux + `tmux`、**Node ≥ 18**、**Python 3**（`detect.py` 走父链，`hook.py` 送 hook 事件）、agent 跑在 tmux pane 里。

> ❌ 不支持云端 / 远程 Claude Code（`CLAUDE_CODE_REMOTE=true`）—— bridge 需要本机 tmux + Unix socket。

**代理**：在启动 skill 的**同一个 shell** 里 `export HTTPS_PROXY=... HTTP_PROXY=...` 即可，登录进程与 daemon 默认带 `NODE_USE_ENV_PROXY=1`，Node 内置 `fetch` 会自动走。注意该开关的 `fetch` 支持需要 **Node ≥ 24（或 ≥ 22.21）**，更低版本会静默忽略；微信还需放行 `ilinkai.weixin.qq.com` 与 `novac2c.cdn.weixin.qq.com`。

---

## 安全

- **状态全在本机** —— 凭据和会话数据只落 `~/.wechat-remote-control/`，除 IM API 流量外不外传
- **终端隔离** —— 终端里手敲的内容不会反向转发，只有「来自 IM 的消息」的回执才回去
- **进程检测安全** —— 用 Python 扫 `/proc` 而不是 `pgrep -f`，后者会匹配到 `bash -c "..."` 包裹 shell、可能误杀
- **autoApprove 的边界** —— 开启时 hook 直接放行 tool call。方便，但意味着「拿到你 IM 的人」就能在你电脑里触发操作。请像对待 SSH 访问一样对待这个 skill

---

## 目录结构

```
SKILL.md            # skill 入口：login / attach / sync / uninstall 完整 runbook
src/  dist/         # TS 源码 / 预构建产物（dist 提交进仓库，SKILL.md 直接引用）
bin/wrc             # 终端运维入口：daemon 生命周期 / login / hooks，不依赖 agent
detect.py           # /proc + ps 双栈的 agent-in-tmux 检测器
hook.py             # agent hook 入口，事件转给 bridge
format_history.py   # history.jsonl → 可读文本
status.sh           # 一行命令查 bridge / account / session 状态
```

---

## 许可证 / 贡献

MIT —— 见 [LICENSE](./LICENSE)。

Issue 和 PR 都欢迎。报 bug 请带上 `bash status.sh` 的输出、`logs/bridge-*.log` 最后 50 行，以及 `tmux -V` / `node --version` / 系统版本。想加新功能（图片 / 语音转发、群聊支持等）欢迎先开 Issue 讨论。

改过 `src/*.ts` 后跑 `npm install && npm run build`，把重新生成的 `dist/` 一起提交（CI 会校验两者一致）。
