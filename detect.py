#!/usr/bin/env python3
"""Detect a coding agent's runtime context: pid, kind, tmux pane, cwd, transcript.

Supports both Claude Code (`claude`) and OpenAI Codex CLI (`codex`). The agent
kind is discovered by walking the process ancestry — the CLAUDECODE env var is
only a hint, since Codex does not set it.

Subcommands:
    detect.py preflight  → key=value report (status / agent / cc_pid / tmux_* / transcript)
                           error codes: REMOTE_SESSION / NO_AGENT_PROCESS / NO_TMUX / AGENT_NOT_IN_TMUX
    detect.py json       → JSON object with status, agent, cc_pid, agent_pid, tmux_*, cwd, skill_dir, transcript

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


# Process command basenames that identify a supported agent.
AGENT_COMMS = {"claude": "claude", "codex": "codex"}


def find_agent_pid(start=None):
    """Walk parents from $PPID until a supported agent process is found.

    Returns (pid, kind) where kind is 'claude' or 'codex', or (None, None).
    """
    p = start or int(os.environ.get("PPID", os.getppid()))
    for _ in range(20):
        cmd = get_cmd(p)
        for kind, comm in AGENT_COMMS.items():
            if cmd == comm:
                return p, kind
        p = get_ppid(p)
        if p <= 1:
            return None, None
    return None, None


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


def codex_home():
    """Resolve Codex CLI's config root.

    Codex reads `CODEX_HOME` to relocate ~/.codex/ (documented). Rollout
    transcripts live under <CODEX_HOME>/sessions/YYYY/MM/DD/.
    """
    return os.environ.get("CODEX_HOME") or os.path.expanduser("~/.codex")


def list_open_jsonl(pid, under):
    """Return open .jsonl files held by `pid` whose path starts with `under`.

    Linux: read /proc/<pid>/fd symlinks. macOS: parse `lsof -p`.
    """
    paths = []
    fd_dir = f"/proc/{pid}/fd"
    if os.path.isdir(fd_dir):
        try:
            for fd in os.listdir(fd_dir):
                try:
                    target = os.readlink(os.path.join(fd_dir, fd))
                except OSError:
                    continue
                if target.endswith(".jsonl") and target.startswith(under):
                    paths.append(target)
        except OSError:
            pass
        return paths
    # macOS / no /proc — use lsof
    try:
        out = subprocess.check_output(
            ["lsof", "-p", str(pid), "-Fn"], stderr=subprocess.DEVNULL
        ).decode()
        for line in out.splitlines():
            if line.startswith("n"):
                name = line[1:]
                if name.endswith(".jsonl") and name.startswith(under):
                    paths.append(name)
    except Exception:
        pass
    return paths


def _rollout_cwd(path):
    """Read the cwd from a rollout's first-line session_meta, or None."""
    try:
        with open(path) as f:
            first = f.readline()
        obj = json.loads(first)
        if obj.get("type") == "session_meta":
            return obj.get("payload", {}).get("cwd")
    except Exception:
        pass
    return None


def find_codex_transcript(pid):
    """Locate a Codex CLI rollout JSONL for the given process.

    Order of resolution:
      1. CODEX_TRANSCRIPT_PATH env var (future-proof, parity with Claude).
      2. The .jsonl the codex process currently holds open under <home>/sessions/.
      3. The most recently modified rollout-*.jsonl whose session_meta cwd matches
         the process cwd (avoids picking an unrelated session from the same day).
    """
    env_path = os.environ.get("CODEX_TRANSCRIPT_PATH")
    if env_path and os.path.exists(env_path):
        return env_path

    sessions_root = os.path.join(codex_home(), "sessions")

    # (2) open-fd scan — the precise path
    for p in list_open_jsonl(pid, sessions_root):
        return p

    # (3) fallback: newest rollout whose session_meta cwd matches the process cwd
    if not os.path.isdir(sessions_root):
        return None
    cwd = get_cwd(pid)
    candidates = []
    for root, _dirs, files in os.walk(sessions_root):
        for name in files:
            if not (name.startswith("rollout-") and name.endswith(".jsonl")):
                continue
            full = os.path.join(root, name)
            try:
                candidates.append((os.path.getmtime(full), full))
            except OSError:
                continue
    candidates.sort(reverse=True)
    for _mtime, full in candidates:
        if not cwd or _rollout_cwd(full) == cwd:
            return full
    return None


def find_transcript(pid, kind="claude"):
    """Locate the active transcript JSONL for an agent process.

    Claude Code resolution:
      1. CLAUDE_TRANSCRIPT_PATH env var (future-proof — Claude Code does not
         currently expose it, but we honour it if it ever appears).
      2. The most recently modified .jsonl in <config_dir>/projects/<encoded(cwd)>/
         where cwd is the process's working directory and config_dir respects
         CLAUDE_CONFIG_DIR.
    """
    if kind == "codex":
        return find_codex_transcript(pid)

    env_path = os.environ.get("CLAUDE_TRANSCRIPT_PATH")
    if env_path and os.path.exists(env_path):
        return env_path

    cwd = get_cwd(pid)
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
    """Return (status, info_dict). status is 'OK' or an error code.

    Agent kind is determined by process ancestry (claude vs codex). CLAUDECODE
    is not required — Codex does not set it.
    """
    if os.environ.get("CLAUDE_CODE_REMOTE") == "true":
        # Cloud sessions have no local terminal/tmux, so the bridge cannot work.
        return "REMOTE_SESSION", {}
    agent_pid, kind = find_agent_pid()
    if not agent_pid:
        return "NO_AGENT_PROCESS", {}
    panes = list_tmux_panes()
    if panes is None:
        return "NO_TMUX", {"agent": kind, "cc_pid": agent_pid, "agent_pid": agent_pid}
    pane = find_tmux_pane(agent_pid, panes)
    if not pane:
        return "AGENT_NOT_IN_TMUX", {"agent": kind, "cc_pid": agent_pid, "agent_pid": agent_pid}
    return "OK", {
        "agent": kind,
        "cc_pid": agent_pid,      # legacy key (status.sh, attach writer)
        "agent_pid": agent_pid,   # neutral alias
        "cwd": get_cwd(agent_pid),
        # This script's own install dir — authoritative skill dir for the running
        # agent (Codex: ~/.agents/skills/...; Claude: ~/.claude/skills/...). The
        # attach flow uses it to register hooks / launch the bridge from the right
        # location instead of hardcoding ~/.claude/skills.
        "skill_dir": os.path.dirname(os.path.abspath(__file__)),
        "tmux_session": pane[0],
        "tmux_window": pane[1],
        "tmux_pane": pane[2],
        "tmux_target": f"{pane[0]}:{pane[1]}.{pane[2]}",
        "transcript": find_transcript(agent_pid, kind),
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
