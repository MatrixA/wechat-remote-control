#!/usr/bin/env python3
"""Format ~/.wechat-remote-control/history.jsonl for display in Claude Code.

Usage: format_history.py [session-name]
Entries are tagged per session (multi-session bridge); an optional session-name
argument filters to that session only (substring, case-insensitive).
"""
import json, sys, os
from collections import deque
from datetime import datetime

session_filter = sys.argv[1].strip().lower() if len(sys.argv) > 1 else ''

path = os.path.expanduser('~/.wechat-remote-control/history.jsonl')
if not os.path.exists(path):
    print('没有找到会话记录。')
    sys.exit(0)

# Read only the trailing 120 lines via a bounded deque instead of slurping the
# whole (potentially large) history.jsonl into memory just to show the tail.
# (120 not 60: with several concurrent sessions interleaved, 60 lines of mixed
# history can cover too little of any single session.)
with open(path) as f:
    lines = [l for l in (s.strip() for s in deque(f, maxlen=120)) if l]

# Tolerate corrupted/partial lines (e.g. half-written on crash) and entries
# missing 'ts' — skip them rather than crashing this display-only helper.
entries = []
for l in lines:
    try:
        e = json.loads(l)
    except ValueError:
        continue
    if not (isinstance(e, dict) and 'ts' in e):
        continue
    if session_filter and session_filter not in str(e.get('session', '')).lower():
        continue
    entries.append(e)

entries = entries[-60:]

if not entries:
    print('没有找到会话记录。' if not session_filter else f'没有找到会话 "{sys.argv[1]}" 的记录。')
    sys.exit(0)

first_ts = entries[0]['ts'] / 1000
last_ts  = entries[-1]['ts'] / 1000
elapsed  = int((last_ts - first_ts) / 60)

# Only tag lines with their session when several sessions appear in the window
# (or a filter is off) — a single-session history reads cleaner untagged.
sessions_seen = {e.get('session') for e in entries if e.get('session')}
show_tag = len(sessions_seen) > 1

header = f'📋 远程会话记录（共 {len(entries)} 条，跨度 {elapsed} 分钟'
if session_filter:
    header += f'，会话过滤: {sys.argv[1]}'
print(header + '）\n')

for e in entries:
    t = datetime.fromtimestamp(e['ts'] / 1000).strftime('%H:%M')
    typ = e.get('type', '')
    tag = f'[{e["session"]}] ' if show_tag and e.get('session') else ''
    if typ == 'assistant':
        text = e.get('text', '')[:300]
        if len(e.get('text', '')) > 300:
            text += '…'
        print(f'[{t}] {tag}🤖 {text}')
    elif typ == 'auto_approve':
        print(f'[{t}] {tag}⚡ 自动允许: {e.get("desc", e.get("tool", "?"))}')
    elif typ == 'user_wechat':
        print(f'[{t}] {tag}📩 你: {e.get("text", "")}')
    elif typ == 'quiz_answer':
        print(f'[{t}] {tag}❓ 问答: {e.get("question", "?")[:80]} → {e.get("answer", "?")}')
    elif typ == 'permission_qa':
        print(f'[{t}] {tag}🔐 权限: {e.get("desc", "?")} → {e.get("answer", "?")}')
    elif typ == 'slash_command':
        print(f'[{t}] {tag}⌨️ 命令: {e.get("command", "?")}')
    elif typ == 'notification':
        print(f'[{t}] {tag}📢 {e.get("text", "")}')
