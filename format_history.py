#!/usr/bin/env python3
"""Format ~/.wechat-remote-control/history.jsonl for display in Claude Code."""
import json, sys, os
from collections import deque
from datetime import datetime

path = os.path.expanduser('~/.wechat-remote-control/history.jsonl')
if not os.path.exists(path):
    print('没有找到微信会话记录。')
    sys.exit(0)

# Read only the trailing 60 lines via a bounded deque instead of slurping the
# whole (potentially large) history.jsonl into memory just to show the tail.
with open(path) as f:
    lines = [l for l in (s.strip() for s in deque(f, maxlen=60)) if l]

# Tolerate corrupted/partial lines (e.g. half-written on crash) and entries
# missing 'ts' — skip them rather than crashing this display-only helper.
entries = []
for l in lines:  # last 60 entries
    try:
        e = json.loads(l)
    except ValueError:
        continue
    if isinstance(e, dict) and 'ts' in e:
        entries.append(e)

if not entries:
    print('没有找到微信会话记录。')
    sys.exit(0)

first_ts = entries[0]['ts'] / 1000
last_ts  = entries[-1]['ts'] / 1000
elapsed  = int((last_ts - first_ts) / 60)

print(f'📋 微信会话记录（共 {len(entries)} 条，跨度 {elapsed} 分钟）\n')

for e in entries:
    t = datetime.fromtimestamp(e['ts'] / 1000).strftime('%H:%M')
    typ = e.get('type', '')
    if typ == 'assistant':
        text = e.get('text', '')[:300]
        if len(e.get('text', '')) > 300:
            text += '…'
        print(f'[{t}] 🤖 {text}')
    elif typ == 'auto_approve':
        print(f'[{t}] ⚡ 自动允许: {e.get("desc", e.get("tool", "?"))}')
    elif typ == 'user_wechat':
        print(f'[{t}] 📩 你: {e.get("text", "")}')
    elif typ == 'permission_qa':
        print(f'[{t}] 🔐 权限: {e.get("desc", "?")} → {e.get("answer", "?")}')
    elif typ == 'notification':
        print(f'[{t}] 📢 {e.get("text", "")}')
