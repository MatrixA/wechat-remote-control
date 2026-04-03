#!/usr/bin/env python3
"""Format ~/.wechat-remote-control/history.jsonl for display in Claude Code."""
import json, sys, os
from datetime import datetime

path = os.path.expanduser('~/.wechat-remote-control/history.jsonl')
if not os.path.exists(path):
    print('没有找到微信会话记录。')
    sys.exit(0)

lines = open(path).read().strip().split('\n')
lines = [l for l in lines if l.strip()]
entries = [json.loads(l) for l in lines[-60:]]  # last 60 entries

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
