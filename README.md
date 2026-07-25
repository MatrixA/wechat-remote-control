# wechat-remote-control

> 用微信遥控你电脑里跑着的 Claude Code —— 走开了也能继续指挥、收回执。

[English](./README.en.md) · 中文

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen)](https://nodejs.org/)
[![Claude Code Skill](https://img.shields.io/badge/Claude%20Code-Skill-8a4cf2)](https://docs.claude.com/en/docs/claude-code/skills)

---

## 它解决什么问题

电脑里 Claude Code 正在跑长任务（重构、批量分析、慢工具调用）—— 你想离开工位、上厕所、通勤，但又想：

- 临时改一下任务方向
- 看一眼跑到哪一步了
- 补一句 follow-up 指令
- 不用打开电脑、找 tmux pane

这个 skill 把当前 CC session 注册成「微信遥控目标」，之后从手机微信对话框里就能继续推动它干活，回执也回到微信。

- 微信发的消息会被 `tmux send-keys` 注入到本地 CC 所在的 pane
- CC 的回复（带 tool call 摘要、报错、文件 diff）通过 hook 转发回微信
- 终端那边的本地输入 **不会** 被反向广播到微信，避免泄漏交互

---

## 架构

```
+---------+       +-------------------+       +---------------+       +-------------+
|  微信   | <---> |  ilink long-poll  | <---> |  bridge daemon | <---> |  tmux + CC  |
| (手机)  |       |     (云端)        |       | (本仓库)        |  PTY  |   (本机)    |
+---------+       +-------------------+       +-------------------+   +-------------+
                                                       ^
                                                       | Unix socket
                                                       |
                                                CC hooks (hook.py)
```

- **bridge daemon** (`src/index.js` → `dist/...`)：长轮询 ilink WeChat API，通过 `tmux send-keys` 把消息注入到 CC 所在面板
- **hook 服务**：监听 Unix socket `/tmp/cc_wechat_hook.sock`，CC 的 PreToolUse / Stop / Notification hook 通过 `hook.py` 把事件发过来
- **回执转发**：Stop / Notification 触发时读 CC transcript JSONL，找到「来自微信的消息」对应的回复，转回微信。终端发起的回复不会被广播
- **中间长回复实时转发**：一个回合里工具调用之间的长段落（讲解、结论等，默认 ≥200 字符）在 PreToolUse 间隙就实时转出去，不用等回合结束；回合结束时兜底补漏，保证不重复、不乱序。`WRC_FORWARD_INTERIM=0` 关闭，`WRC_INTERIM_MIN_LEN` 调阈值（daemon 启动时读取，改动需重启 daemon）
- **运行态集中在一个目录** —— `~/.wechat-remote-control/`：
  - `accounts/<accountId>.json` —— 微信凭据
  - `state.json` / `sessions.json` —— attach 目标和多 session 注册表
  - `ilink_session.json` —— 长轮询 cursor
  - `bridge.json` / `bridge.pid` / `cc_pid` —— daemon 元数据
  - `logs/bridge-YYYY-MM-DD.log` —— 滚动日志（保留 30 天）
  - `history.jsonl` —— 注入的消息和已转发的回复

---

## 多会话完全并发

桥接会自动发现 tmux 里**所有**正在跑 claude / codex 的面板，每个会话有独立的消息队列、
独立的进行中回合、独立的状态提示——A 会话跑长任务时照样可以指挥 B 会话，各自的回复回到
各自的对话里，互不阻塞。hook 事件按 `TMUX_PANE`（面板 id）权威路由，同目录多会话也不会串。
`/sw` 只移动私聊消息的「默认路由」指针，不会打断任何会话的进行中工作。

---

## Telegram 深度支持（推荐）

同一套机制（tmux 注入、hook 转发、多 session、自动放行）可以接入 **Telegram bot**——IM 层已抽象成
`Transport` 接口（`src/transport/`），微信和 Telegram 各是一个 adapter，核心代码只面对一个不透明的回复 `target`。

- **登录**：`/wechat-remote-control login --telegram` —— 在 **@BotFather** 创建 bot、拿到 token 粘贴给我，
  再在 Telegram 里给 bot 发 `/start`。第一个跟 bot 说话的会话会被**锁定**为唯一授权会话（其他人发消息一律忽略；
  bot token 等同于终端控制权，请妥善保管）。
- **话题模式（Forum Topics，体验最佳）**：建一个开启「话题」的超级群，把 bot 加为管理员
  （勾选「管理话题」），在群里发 `/bind` —— 之后**每个 tmux 会话自动获得一个专属话题**，
  像 Slack 频道一样隔离：在话题里发消息就发到对应会话，回复、状态、问卷都留在话题里；
  会话改名话题跟着改名，**在 Telegram 里直接长按话题改名也会反向同步**（重命名对应的
  tmux 窗口并固定，扫描不会改回去）；会话关掉话题自动归档、同名会话回来自动复用。
  General 话题和私聊继续作为「大厅」：`/ls` 紧凑 tmux 会话列表（点按切换聚焦）、`/sw`
  会话菜单（带忙碌状态和话题深链）、全局命令、默认路由消息。
- **聚焦模式（`/fc`，多会话时始终生效）**：面板多了话题列表会爆炸——`/fc` 弹出 tmux 会话列表
  （每个 tmux 会话 ≈ 一个项目），点选后**只保留该 tmux 会话下各面板的话题，其余话题直接删除**
  （Telegram 没有真正的「隐藏话题」，关闭只会灰显仍占位置，所以聚焦采用删除；**历史随话题删除**）。
  聚焦是**粘性**的：`/fc` 只切换聚焦的会话，没有「全部显示」；当有多个 tmux 会话而未聚焦时
  （首次启动、或被聚焦的会话关闭后）自动聚焦默认路由所在的 tmux 会话。切到另一个会话、或在
  **手动删掉话题后重新 `/fc` 同一会话**，都会重建话题并**回放最近几轮对话**作上下文。聚焦只影响
  话题可见性：默认路由（`/sw`）不动，进行中的回合照常运行（忙碌会话的话题会等回合结束才删除，
  删除后仍有输出会转投 General 并带【会话名】前缀）。
- **启动**：`attach` 时守护进程按 `WCC_TRANSPORT` 环境变量 > `--telegram/--wechat` > 已有凭据 自动选择 IM。
- **充分利用 Telegram 原生能力**（微信不支持的能力自动回退到文字菜单）：
  - 原生命令菜单（`setMyCommands`）：`/ls` `/sw` `/fc` `/model` `/rename` `/esc` `/bind` `/start`
  - **实时回合状态**：每个回合一条实时编辑的状态消息——耗时、已调用工具数、最近工具名，
    附 **⏹ 中断按钮**（点一下向对应面板发 Escape）
  - **消息回应（reactions）**：你的消息注入后打 👀，回复送达打 👍，超时放弃打 💔——一眼看懂进展
  - `/ls`、`/sw`、`/fc`、`/model` 用**内联键盘**点选切换；`AskUserQuestion` 问卷渲染成**选项按钮**（多选可勾选后「完成」）
  - **长回复不刷屏**：中长回复自动折叠进「展开引用」，超过 8000 字符直接发成 Markdown **文件**
  - 打字状态用 `sendChatAction`（每个话题独立）；输出按 Markdown 渲染（代码块、粗体、链接、标题）；
    遇到限流自动按 `retry_after` 退避
- **数据目录**：Telegram 凭据存在 `~/.wechat-remote-control/telegram/account.json`（含锁定的 chat id 与
  绑定的话题群 id），长轮询游标存 `telegram/offset.json`；微信文件原样不动，完全向后兼容。

微信侧保持可用但降级：单活跃会话 + 数字文字菜单，行为与之前一致。

---

## 依赖

- **macOS 或 Linux**，本机装好 `tmux`
- **Node.js ≥ 18**（bridge 用了 ESM import）
- **Python 3**（`detect.py` 走 `/proc` / `ps` 父链；`hook.py` 收 hook 事件）
- **能扫码登录的微信账号**（QR 大约 60s 过期，skill 会自动刷新）
- **Claude Code 跑在 tmux pane 里**

> ❌ 云端 / 远程 Claude Code（`CLAUDE_CODE_REMOTE=true`）不支持 —— bridge 必须有本机 tmux + Unix socket。

---

## 代理环境

如果你的终端必须经本地代理才能联网，在启动 skill 的**同一个 shell** 里 export 代理地址即可：

```bash
export HTTPS_PROXY=http://127.0.0.1:7890   # 换成你的代理
export HTTP_PROXY=http://127.0.0.1:7890
# export NO_PROXY=localhost,127.0.0.1       # 可选：排除内网地址
```

skill 的登录进程与 bridge daemon 已默认带上 `NODE_USE_ENV_PROXY=1`，Node 内置 `fetch`
会自动按上述环境变量走代理，无需改代码。注意：

- 该开关的 `fetch` 支持需要 **Node ≥ 24**（或 **≥ 22.21**）；更低版本会静默忽略，代理不生效，需先升级 Node。
- 未设置任何代理变量时该开关是无副作用的 no-op，普通直连用户不受影响。
- 代理需放行微信域名 `ilinkai.weixin.qq.com` 与 `novac2c.cdn.weixin.qq.com`。

---

## 安装

### 方式一：`npx skills`（推荐）

[`npx skills`](https://github.com/vercel-labs/skills) 是社区维护的 agent skill 包管理器，把 GitHub 当作 registry，一行命令就能装到 `~/.claude/skills/`：

```bash
npx skills add MatrixA/wechat-remote-control
```

要指定 agent，加 `-a`：

```bash
npx skills add MatrixA/wechat-remote-control -a claude-code
```

之后可以用 `npx skills list` / `npx skills update` / `npx skills remove` 管理。

### 方式二：手动 clone

```bash
# 安装
git clone https://github.com/MatrixA/wechat-remote-control.git "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/wechat-remote-control"

# 更新
git -C "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/wechat-remote-control" pull
```

### Codex CLI 用户

Codex 从 `~/.agents/skills/` 读取 skill（不是 `~/.claude/skills/`），所以装到那里：

```bash
# 安装
git clone https://github.com/MatrixA/wechat-remote-control.git ~/.agents/skills/wechat-remote-control

# 更新
git -C ~/.agents/skills/wechat-remote-control pull
```

`attach` 会自动识别当前 agent：Codex 的 hook 写进 `~/.codex/hooks.json`（事件
`PreToolUse` / `Stop` / `UserPromptSubmit`），Claude 写进 `~/.claude/settings.json`
（`PreToolUse` / `Stop` / `Notification`）。注册的 hook 命令带兜底保护，找不到
`hook.py` 也只会静默跳过、绝不阻塞 prompt。

两个注意点：

- 同时用 Claude 和 Codex 时，**每种 agent 里各跑一次 attach**（hook 只由 attach 安装）
- Codex 只在启动时读 `hooks.json`：首次装完 hook 后重启 Codex 才生效（`codex resume --last` 可保留上下文）

### 然后开始用

在 tmux 里启动的 Claude Code session 内：

```
/wechat-remote-control login      # 第一次用先扫码登录微信
/wechat-remote-control attach     # 把当前 CC session 注册成微信遥控目标
/wechat-remote-control sync       # 显示上次 attach 以来的微信对话历史，给新 session 建立上下文
/wechat-remote-control uninstall  # 一键清除所有痕迹（hook / 状态栏 / daemon），保留登录凭据
```

直接 `/wechat-remote-control` 不带参数，默认走 **attach**。

> Skill 的完整执行步骤都写在 `SKILL.md` 里（环境检查、QR 旋转处理、错误恢复等）。

---

## 四个子命令

### `login`

扫码登录一个微信账号，凭据写到 `~/.wechat-remote-control/accounts/<accountId>.json`。
第一次使用、或 bridge 报 session 过期时跑一次。
QR 60s 内没扫会自动刷新一张。

### `attach`

把当前 Claude Code session 注册成微信遥控目标：

1. `detect.py` 沿 `/proc`（Linux）/ `ps`（macOS）父链找到真正的 `claude` 进程，确认它跑在 `tmux list-panes -a` 里
2. 写 `state.json` / `bridge.json` / `sessions.json`，告诉 daemon 要把消息注入哪个 pane
3. 后台拉起 bridge daemon（单实例 —— 在另一个 session 里 attach 会切走目标）
4. 给绑定的微信用户发一条欢迎消息，确认通道已建立

attach 后 Claude 状态栏显示 `💬 已连微信 (遥控中)`（当前目标）或
`💬 已连微信 (#sw 可切入)`（其他已注册 session）；Telegram 下标签为「TG」。

### `sync`

把 `history.jsonl` 渲染成可读的对话记录，方便给一个新的 CC session 建立上下文。

### `uninstall`

把 **attach** 装进去的东西全部撤销，让 Claude Code / Codex 回到原始行为：

1. 从 `~/.claude/settings.json` 和 `~/.codex/hooks.json` 里**精确移除** wrc 的 hook（按 `wechat-remote-control/hook.py` 标记匹配，别人的 hook 与其他设置原样保留）
2. 移除 Claude 状态栏（仅当它指向本 skill 的 `status.sh`）
3. 停掉 bridge daemon，删除 socket 与运行时状态（`bridge.pid` / `cc_pid` / `bridge.json` / `state.json` / `sessions.json`）
4. **保留**登录凭据（`accounts/`、`telegram/`）、`history.jsonl` 和 `logs/`，下次直接 `attach` 无需重新登录

> 没开 remote-control 时，attach 注册的 hook 本就会因 socket 不存在而立即 `exit 0` 静默 no-op，对正常使用几乎零影响；`uninstall` 则把它们彻底清掉，连触发都不再发生。
> 想连凭据一起删，跑完 `uninstall` 后手动 `rm -rf ~/.wechat-remote-control` 即可。

---

## 目录结构

```
wechat-remote-control/
├── SKILL.md              # Claude Code skill 入口，含 login / attach / sync / uninstall 完整 runbook
├── package.json          # node 依赖 + 构建脚本
├── tsconfig.json
├── src/                  # TS 源码：bridge、tmux 注入、ilink client、命令路由
├── dist/                 # 预构建产物，SKILL.md 中的运行步骤直接引用 dist/ 路径
├── detect.py             # /proc + ps 双栈的 CC-in-tmux 检测器
├── hook.py               # agent hook 入口：Claude(PreToolUse/Stop/Notification) 与 Codex(PreToolUse/Stop/UserPromptSubmit) 都转给 bridge
├── format_history.py     # 把 history.jsonl 渲染成可读文本
├── status.sh             # 一行命令查 bridge / account / session 状态
└── .gitignore
```

---

## 安全说明

- **运行态全部在本机。** 凭据和 session 数据只落在 `~/.wechat-remote-control/`，除微信 API 流量外不向任何第三方上传
- **终端隔离。** 终端里手敲的内容不会反向转发到微信，只有「来自微信」的消息的对应回执才会回去
- **进程检测安全。** 用 Python 扫 `/proc` 而不是 `pgrep -f` —— Claude Code 用 `bash -c "..."` 包命令，`pgrep -f` 会匹配到包裹 shell 自己，可能误杀进程
- **autoApprove 的边界。** `state.json` 里 `autoApprove: true` 时，hook 事件会直接放行 tool call。方便，但意味着「拿到你微信的人」就能在你电脑里触发 CC 操作。请像对待 SSH 访问一样对待这个 skill

---

## 许可证

MIT —— 见 [LICENSE](./LICENSE)。

---

## 参与贡献

Issue 和 PR 都欢迎。如果遇到 bug，请尽量带上：

- `bash status.sh` 的输出
- `~/.wechat-remote-control/logs/bridge-*.log` 的最后 50 行
- `tmux -V`、`node --version`、操作系统版本

想加新功能（图片 / 语音转发、群聊支持等）也欢迎先开 Issue 讨论。

改动 `src/*.ts` 后跑 `npm install && npm run build` 重新生成 `dist/` 一起提交（CI 会校验两者一致）。
