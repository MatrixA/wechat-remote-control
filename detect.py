#!/usr/bin/env python3
"""Detect Claude Code's runtime context: cc_pid, tmux pane, cwd, transcript path.

Subcommands:
    detect.py preflight  → key=value report (or NOT_CLAUDECODE / NO_CC_PROCESS / NO_TMUX / CC_NOT_IN_TMUX)
    detect.py json       → JSON object with cc_pid, tmux_*, cwd, transcript

Cross-platform: prefers /proc on Linux, falls back to ps/lsof on macOS.
"""
import json
import os
import subprocess
import sys
import time


def _proc(p, name):
    return os.path.exists(f"/proc/{p}/{name}")


def get_ppid(p):
    try:
        if _proc(p, "status"):
            with open(f"/proc/{p}/status") as f:
                for line in f:
                    if line.startswith("PPid:"):
                        return int(line.split()[1])
            return 0
        out = subprocess.check_output(
            ["ps", "-p", str(p), "-o", "ppid="], stderr=subprocess.DEVNULL
        ).decode().strip()
        return int(out) if out else 0
    except Exception:
        return 0


def get_cmd(p):
    """First argv element (basename)."""
    try:
        if _proc(p, "cmdline"):
            with open(f"/proc/{p}/cmdline", "rb") as f:
                first = f.read().split(b"\x00")[0].decode(errors="replace")
            return os.path.basename(first)
        out = subprocess.check_output(
            ["ps", "-p", str(p), "-o", "comm="], stderr=subprocess.DEVNULL
        ).decode().strip()
        return os.path.basename(out)
    except Exception:
        return ""


def get_cwd(p):
    try:
        if _proc(p, "cwd"):
            return os.readlink(f"/proc/{p}/cwd")
        out = subprocess.check_output(
            ["lsof", "-p", str(p), "-d", "cwd", "-Fn"], stderr=subprocess.DEVNULL
        ).decode()
        for line in out.splitlines():
            if line.startswith("n"):
                return line[1:]
    except Exception:
        pass
    return ""


def find_cc_pid(start=None):
    """Walk parents from $PPID until a process with cmdline 'claude' is found."""
    p = start or int(os.environ.get("PPID", os.getppid()))
    for _ in range(20):
        if get_cmd(p) == "claude":
            return p
        p = get_ppid(p)
        if p <= 1:
            return None
    return None


def list_tmux_panes():
    try:
        out = subprocess.check_output(
            ["tmux", "list-panes", "-a", "-F",
             "#{pane_pid}\t#{session_name}\t#{window_index}\t#{pane_index}"],
            stderr=subprocess.DEVNULL,
        ).decode()
    except Exception:
        return None
    panes = {}
    for line in out.strip().split("\n"):
        parts = line.split("\t")
        if len(parts) == 4:
            try:
                panes[int(parts[0])] = (parts[1], parts[2], parts[3])
            except ValueError:
                pass
    return panes


def find_tmux_pane(cc_pid, panes):
    """Walk cc_pid up the parent chain to find the tmux pane it lives in."""
    p = cc_pid
    for _ in range(20):
        if p in panes:
            return panes[p]
        p = get_ppid(p)
        if p <= 1:
            return None
    return None


def encode_cwd(cwd):
    return "".join(c if c.isalnum() or c == "-" else "-" for c in cwd)


def claude_config_dir():
    """Resolve Claude Code's config root.

    Claude Code reads `CLAUDE_CONFIG_DIR` to relocate ~/.claude/ (undocumented
    but supported, see github.com/anthropics/claude-code#3833 / #25762). We
    must respect it or we will look for transcripts in the wrong place.
    """
    return os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude")


def find_transcript(cc_pid):
    """Locate Claude Code's active transcript JSONL.

    Order of resolution:
      1. CLAUDE_TRANSCRIPT_PATH env var (future-proof — Claude Code does not
         currently expose it, but we honour it if it ever appears).
      2. The most recently modified .jsonl in <config_dir>/projects/<encoded(cwd)>/
         where cwd is the CC process's working directory and config_dir respects
         CLAUDE_CONFIG_DIR.
    """
    env_path = os.environ.get("CLAUDE_TRANSCRIPT_PATH")
    if env_path and os.path.exists(env_path):
        return env_path

    cwd = get_cwd(cc_pid)
    if not cwd:
        return None
    proj = os.path.join(claude_config_dir(), "projects", encode_cwd(cwd))
    if not os.path.isdir(proj):
        return None

    candidates = []
    for name in os.listdir(proj):
        if not name.endswith(".jsonl"):
            continue
        full = os.path.join(proj, name)
        try:
            candidates.append((os.path.getmtime(full), full))
        except OSError:
            continue
    if not candidates:
        return None
    candidates.sort(reverse=True)
    return candidates[0][1]


def detect():
    """Return (status, info_dict). status is 'OK' or an error code."""
    if os.environ.get("CLAUDECODE") != "1":
        return "NOT_CLAUDECODE", {}
    if os.environ.get("CLAUDE_CODE_REMOTE") == "true":
        # Cloud sessions have no local terminal/tmux, so the bridge cannot work.
        return "REMOTE_SESSION", {}
    cc_pid = find_cc_pid()
    if not cc_pid:
        return "NO_CC_PROCESS", {}
    panes = list_tmux_panes()
    if panes is None:
        return "NO_TMUX", {"cc_pid": cc_pid}
    pane = find_tmux_pane(cc_pid, panes)
    if not pane:
        return "CC_NOT_IN_TMUX", {"cc_pid": cc_pid}
    return "OK", {
        "cc_pid": cc_pid,
        "cwd": get_cwd(cc_pid),
        "tmux_session": pane[0],
        "tmux_window": pane[1],
        "tmux_pane": pane[2],
        "tmux_target": f"{pane[0]}:{pane[1]}.{pane[2]}",
        "transcript": find_transcript(cc_pid),
    }


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "preflight"
    status, info = detect()

    if mode == "json":
        out = {"status": status, **info}
        print(json.dumps(out))
        sys.exit(0 if status == "OK" else 1)

    # preflight: key=value lines
    print(f"status={status}")
    for k, v in info.items():
        print(f"{k}={v}")
    sys.exit(0 if status == "OK" else 1)


if __name__ == "__main__":
    main()
