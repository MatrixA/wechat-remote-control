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
- 终端里手敲的内容**不会**反向外发，只有「来自 IM 那条消息」的回执才回去

IM 支持 **Telegram**（推荐，能力最全）和**微信**；agent 支持 **Claude Code** 与 **Codex CLI**，`attach` 时自动识别。

---

## 安装

```bash
npx skills@latest add MatrixA/wechat-remote-control -g -y
```

> `@latest` 别省：安装器 < 1.5.18 有个 bug（[#1603](https://github.com/vercel-labs/skills/issues/1603)）会把根目录放 `SKILL.md` 的 skill 误判成「单文件 skill」，**只装 `SKILL.md`**，`bin/` `dist/` `src/` 全丢 —— 症状是之后每条命令都报「找不到文件」。

装完立刻自检，三个都在才算装全：

```bash
WRC="$HOME/.agents/skills/wechat-remote-control"
ls -d "$WRC/bin/wrc" "$WRC/dist" "$WRC/src/index.js"
```

只有 `SKILL.md`、其余全是 `No such file`，就是命中了上面那个 bug —— 重跑一次带 `@latest` 的安装命令。**别去跑 `npm run build`**：文件根本没下来，编译救不了。

也可以手动 clone —— Claude 读 `~/.claude/skills/`，Codex 读 `~/.agents/skills/`，装错目录 agent 根本看不到这个 skill：

```bash
# Codex 用户把目标换成 "$HOME/.agents/skills/wechat-remote-control"
git clone https://github.com/MatrixA/wechat-remote-control.git \
  "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/wechat-remote-control"
```

手动 clone 的话，下面命令区每个块开头那行 `WRC=` 都换成你这个 clone 路径。

然后在 tmux 里的 agent 会话中：

```
/wechat-remote-control login --telegram   # 首次登录（去掉 --telegram 则走微信扫码）
/wechat-remote-control attach             # 注册当前会话为遥控目标（不带参数默认就是它）
/wechat-remote-control sync               # 打印上次 attach 以来的对话，给新会话补上下文
```

两个注意：

- Claude 和 Codex 都用时，**每种 agent 各跑一次 `attach`** —— hook 只由 attach 安装。daemon 每 30s 扫一次 tmux，扫到的会话在 `status` 里看着一切正常、也收得到消息，但**没有 hook 就永远不会把回复发出来**，症状和网络故障一模一样。
- **Codex 只在启动时读 `hooks.json`** —— 首次装完 hook 要重启 Codex：`/quit` 然后 `codex resume --last`（保上下文）。不重启的症状是 IM 那边一直「正在输入」、永远等不到回复，日志里也没有线索。

---

## 命令

`bin/wrc` 不需要 agent，任何普通终端（含 ssh 进无头机器）都能跑；只有 `attach` 例外 —— 它靠走进程父链定位 pane，普通终端做不到。

**`wrc` 不会自动上 PATH。** 下面每个块都自带路径、互不依赖，复制进全新终端就能跑。开头那行 `WRC=` 是 `npx` 安装的规范位置（`~/.claude/skills/…` 只是指向它的符号链接）；手动 clone 到别处的，换成自己的 clone 路径即可。

| 操作 | 什么时候用 |
|---|---|
| [自检](#自检) | 装完、更新完，或任何命令报「找不到文件」时 |
| [登录](#登录) | 首次使用，或换 bot / 换微信号 |
| [attach](#attach) | 把某个 agent 会话设为默认路由目标 |
| [状态](#状态) | 看 daemon 在不在跑、注册了哪些会话 |
| [日志](#日志) | 消息没进去、回复没回来 |
| [更新](#更新) | 拉新代码 —— **必须跟一次重启** |
| [重启](#重启) | 改过环境变量，或 IM 行为看着「过时」 |
| [卸载](#卸载) | 停掉遥控，保留登录凭据 |
| [彻底清除](#彻底清除) | 连凭据一起删 |

#### 自检

```bash
WRC="$HOME/.agents/skills/wechat-remote-control"
ls -d "$WRC/bin/wrc" "$WRC/dist" "$WRC/src/index.js"
```

#### 登录

```bash
WRC="$HOME/.agents/skills/wechat-remote-control"
bash "$WRC/bin/wrc" login --telegram   # 去掉 --telegram 走微信扫码（二维码约 60s 自动换一张）
```

#### attach

在 tmux 里的 agent 会话中输入（这一步必须在 agent 里做）：

```
/wechat-remote-control attach
```

无头机器上没有交互式 agent 可用，就先把三步跑完，再去 tmux 里正常起 agent —— 30s 内会被自动发现并注册：

```bash
WRC="$HOME/.agents/skills/wechat-remote-control"
bash "$WRC/bin/wrc" login --telegram
bash "$WRC/bin/wrc" hooks install --agent both
bash "$WRC/bin/wrc" start
```

中间那步 `hooks install` 不能跳 —— 跳了就会得到一个「注册成功但回复永不外发」的会话。

#### 状态

```bash
WRC="$HOME/.agents/skills/wechat-remote-control"
bash "$WRC/bin/wrc" status
```

会打印启动时间、transport 和已注册会话（`*` 是默认路由那个）。daemon 没在跑时**退出码是 3**，别把它接在 `&&` 后面。

#### 日志

```bash
WRC="$HOME/.agents/skills/wechat-remote-control"
bash "$WRC/bin/wrc" logs -f   # 默认 50 行；-n 200 看更多历史
```

#### 更新

daemon 是常驻单例，**不随 `git pull` 自动重启**，所以更新永远是「拉代码 + 重启」两步。先看一眼你是哪种装法：

```bash
WRC="$HOME/.agents/skills/wechat-remote-control"
test -d "$WRC/.git" && echo "git clone 装的 → 用 A" || echo "npx 装的 → 用 B"
```

**A. `git clone` 装的**：`dist/` 是提交进仓库的，随 pull 一起下来，**不需要 `npm run build`**（只有你自己改过 `src/*.ts` 才要）。

```bash
WRC="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/wechat-remote-control"   # 换成你的 clone 路径
git -C "$WRC" pull
bash "$WRC/bin/wrc" restart
bash "$WRC/bin/wrc" status
```

**B. `npx skills add` 装的**：装出来的是文件拷贝而不是 git 仓库（`.git` 会被安装器排除），所以 `git pull` 会报 `not a git repository` —— 更新方式是重跑安装命令。**这里也必须 pin `@latest`**：`npx skills update <name>` 内部只是重跑一次 `add`，并不会升级安装器本身，版本低于 1.5.18 就仍然只会装下一个 `SKILL.md`。

```bash
npx skills@latest add MatrixA/wechat-remote-control -g -y
WRC="$HOME/.agents/skills/wechat-remote-control"
ls -d "$WRC/bin/wrc" "$WRC/dist" "$WRC/src/index.js"   # 复查装全了
bash "$WRC/bin/wrc" restart
bash "$WRC/bin/wrc" status
```

#### 重启

`WCC_TRANSPORT` / `WRC_AUTO_APPROVE` / `WRC_FORWARD_INTERIM` / `WRC_INTERIM_MIN_LEN` 都只在 daemon 启动时读一次，改完必须重启才生效。

```bash
WRC="$HOME/.agents/skills/wechat-remote-control"
bash "$WRC/bin/wrc" restart
bash "$WRC/bin/wrc" status
```

重启是安全的，**不需要重跑 `attach`**：进行中的回合会恢复，tmux 会话由 30s 扫描重新发现，hook 是写在配置文件里的一次性设置。

#### 卸载

```bash
WRC="$HOME/.agents/skills/wechat-remote-control"
bash "$WRC/bin/wrc" hooks uninstall --agent both
bash "$WRC/bin/wrc" stop
```

只按 `wechat-remote-control/hook.py` 标记精确匹配移除自己的 hook，**别人的 hook 和其它设置原样保留**；状态栏仅在它仍指向本 skill 时才移除。凭据、`history.jsonl`、`logs/` 都**保留**，下次 attach 不用重新登录。在 agent 里跑 `/wechat-remote-control uninstall` 等效。

#### 彻底清除

这一步才会删掉登录凭据和绑定的群 —— 跑完下次得重新登录。

```bash
rm -rf ~/.wechat-remote-control
```

---

## 在 IM 里能做什么

在 **@BotFather** 建 bot、把 token 粘给 `login --telegram`，再给 bot 发 `/start`。**第一个跟 bot 说话的会话被锁定为唯一授权会话**（所以别人发的消息会被忽略，这不是 bug）；token 等同终端控制权，请妥善保管。

**话题模式**：建一个开启「话题」的超级群，把 bot 加为**管理员并勾上「管理话题」权限**（少这个权限就建不出话题，多会话 UX 会静默退化成大厅），群里发 `/bind`。之后每个 tmux 面板自动获得专属话题，像 Slack 频道一样隔离：在话题里发消息就发到对应会话，回复、状态、问卷都留在话题里。会话改名话题跟着改，在 Telegram 里长按话题改名也会反向同步到 tmux 窗口名。General 话题和私聊继续当「大厅」。

**聚焦（`/fc`）**：面板一多话题列表就爆炸。`/fc` 列出 tmux 会话点选聚焦，**只保留该会话下的话题，其余直接删除 —— 历史随话题一起没**（Telegram 没有真正的「隐藏话题」，关闭只会灰显仍占位）。聚焦是**粘性**的，没有「全部显示」；多会话而未聚焦时桥接会**自己**把默认路由所在的会话聚焦，所以你没敲过 `/fc` 也可能触发删除。切回某个会话会重建话题并回放最近几轮作上下文；聚焦只影响可见性，默认路由与进行中的回合都不受影响。

**多会话完全并发**：桥接自动发现 tmux 里所有跑着 claude / codex 的面板，各自独立队列、独立回合、独立状态 —— A 会话跑长任务时照样指挥 B，回复各回各家。hook 事件按面板 id 权威路由，同目录多会话不会串。`/sw` 只移动私聊消息的**默认路由**指针，不打断任何进行中的工作。

**命令菜单**：`/ls` `/sw` `/fc` `/model` `/rename` `/rnt` `/esc` `/reset` `/bind` `/start`

Telegram 侧还有：就地编辑的实时回合状态（带 ⏹ 中断按钮）、消息回应（👀 已注入 · 👍 已回复 · 💔 已放弃）、内联键盘、`AskUserQuestion` 渲染成选项按钮、超长回复自动发成 Markdown 文件。微信侧保持可用但降级：单活跃会话 + 数字文字菜单。

<details>
<summary>工作原理</summary>

```
Telegram / 微信  ⇄  云端 long-poll  ⇄  bridge daemon  ⇄ tmux send-keys ⇄  tmux pane (agent)
                                            ↑
                                Unix socket /tmp/cc_wechat_hook.sock
                                            ↑
                                    agent hooks (hook.py)
```

daemon 长轮询 IM 并把消息注入 agent 所在面板；agent 的 hook 事件经 `hook.py` 送到 Unix socket；回合结束时读 transcript，只把「来自 IM 那条消息」的回复转回去。一个回合里工具调用之间的长段落会在间隙就实时转出（`WRC_FORWARD_INTERIM=0` 关闭）。运行态全部在 `~/.wechat-remote-control/` —— 凭据、会话注册表、`history.jsonl` 和 `logs/` 都在这里，也是「彻底清除」的目标。

</details>

---

## 排障

**`wrc: command not found`，或 `bin/wrc` 找不到** —— 它从不自动上 PATH，用上面每个块里的 `bash "$WRC/bin/wrc" …` 形式。要是连文件都 `ls` 不到，就是装残了或装的版本太老（`bin/wrc` 是较新版本才加的），走[更新](#更新)再跑一次[自检](#自检)。一台机器上有多份 clone 时，只有 `$WRC` 指向的那份算数。

**IM 行为看着「过时」**（新功能没有、老 bug 还在）—— 先怀疑 daemon 没重启：`status` 里的启动时间比你仓库最后一次提交还早，就[重启](#重启)。

**会话卡在「忙碌」不动、消息发不进去** —— IM 里发 `/reset`。只清进行中回合的状态，**排队的消息不丢**，会重新投递。

**别手工 kill daemon** —— 尤其别 `pkill -f .../src/index.js`：agent 把命令包在 `bash -c "…"` 里，这个 pattern 会匹配到包裹壳本身，杀掉的是你自己的会话。`bridge.pid` 是唯一安全句柄，`wrc stop` / `wrc restart` 已经处理好了。

---

## 依赖与安全

macOS / Linux + `tmux`、**Node ≥ 18**、**Python 3**（`detect.py` 走进程父链，`hook.py` 送 hook 事件），agent 跑在 tmux pane 里。

> ❌ 不支持云端 / 远程 Claude Code（`CLAUDE_CODE_REMOTE=true`）—— bridge 需要本机 tmux + Unix socket。

**代理**：在启动 daemon 的**同一个 shell** 里 `export HTTPS_PROXY=… HTTP_PROXY=…`（它只在启动时继承一次环境）。登录进程与 daemon 默认带 `NODE_USE_ENV_PROXY=1`，但 Node 内置 `fetch` 对这个开关的支持需要 **Node ≥ 24（或 ≥ 22.21）** —— 更低版本会静默忽略，症状是 daemon 正常启动、打印 PID，然后**一条消息都收不到，且哪里都没有报错**。微信还需放行 `ilinkai.weixin.qq.com` 与 `novac2c.cdn.weixin.qq.com`。

安全上有四件事值得先知道：

- **工具调用默认自动放行。** 这是 daemon 的默认行为，不是需要你打开的开关 —— 意味着**能给你 bot 发消息的人，就能在你电脑上跑命令**。请像对待 SSH 访问一样对待这个 skill。要关掉：设 `WRC_AUTO_APPROVE=0` 后**必须重启 daemon**（环境变量只在启动时读一次，不重启等于没改）；关掉后 hook 不再代为决定，回落到 agent 自己的权限流程。
- **bot token ≈ 终端控制权**，且第一个跟 bot 说话的会话会被锁为唯一授权会话。
- **状态全在本机** —— 凭据和会话数据只落 `~/.wechat-remote-control/`，除 IM API 流量外不外传。
- **进程检测安全** —— 用 Python 扫 `/proc` 而不是 `pgrep -f`，后者会匹配到 `bash -c "…"` 包裹壳、可能误杀。

---

## 许可证 / 贡献

MIT —— 见 [LICENSE](./LICENSE)。

Issue 和 PR 都欢迎。报 bug 请带上 `bash "$WRC/bin/wrc" status` 与 `bash "$WRC/bin/wrc" logs -n 50` 的输出，以及 `tmux -V` / `node --version` / 系统版本。想加新功能（图片 / 语音转发、群聊支持等）欢迎先开 Issue 讨论。

改过 `src/*.ts` 后跑 `npm install && npm run build`，把重新生成的 `dist/` 一起提交 —— CI 会校验两者一致。
