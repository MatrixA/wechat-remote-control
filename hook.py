#!/usr/bin/env python3
"""Thin hook client: relays CC hook events to the wrc-bridge Unix socket."""
import sys, os, json, socket

SOCK_PATH = "/tmp/cc_wechat_hook.sock"

def main():
    event_type = sys.argv[1] if len(sys.argv) > 1 else "unknown"

    # Read CC hook payload from stdin
    try:
        payload = json.loads(sys.stdin.read())
    except Exception:
        payload = {}

    payload["_hookType"] = event_type

    # Connect to bridge socket
    if not os.path.exists(SOCK_PATH):
        # Bridge not running — exit silently, no error
        sys.exit(0)

    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        sock.settimeout(5)
        sock.connect(SOCK_PATH)
        sock.sendall(json.dumps(payload).encode() + b"\n")
        sock.shutdown(socket.SHUT_WR)  # signal end-of-write so server's 'end' event fires

        if event_type == "pretooluse":
            # Wait for permission decision reply
            chunks = []
            while True:
                data = sock.recv(4096)
                if not data:
                    break
                chunks.append(data)
            reply = b"".join(chunks).decode().strip()
            if reply:
                print(reply)
        # For stop/notification: fire-and-forget
    except (ConnectionRefusedError, FileNotFoundError, OSError):
        # Bridge unreachable — exit silently, no error
        sys.exit(0)
    finally:
        sock.close()

if __name__ == "__main__":
    main()
