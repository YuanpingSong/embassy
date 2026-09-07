#!/usr/bin/env python3
"""Record an owned PTY as timestamped, redacted terminal frames (no raw log).

stdin accepts JSON lines: {"input":"..."}, {"snapshot":true}, {"save":true},
or {"stop":true}. Never pass credentials to this process.
"""
import argparse
import base64
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import signal
import struct
import subprocess
import sys
import termios
import time

PRIVATE = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
    r"|conv_[A-Za-z0-9_-]+|peer_[A-Za-z0-9_-]{12,}"
    r"|sk-[A-Za-z0-9_-]{10,}|eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_.-]+"
    r"|/Users/[^\s/]+|(?:/private)?/tmp/embassy-demo-session\.[A-Za-z0-9]+",
    re.IGNORECASE,
)

def redacted(text):
    safe = PRIVATE.sub(lambda match: ("conv_[redacted]" if match[0].startswith("conv_") else "[redacted]")
                       .ljust(len(match[0]))[:len(match[0])], text)
    username = os.environ.get("USER", "")
    if username: safe = re.sub(re.escape(username), "[user]".ljust(len(username))[:len(username)], safe)
    return safe

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True)
    parser.add_argument("--cwd", required=True)
    parser.add_argument("--seconds", type=int, default=1200)
    parser.add_argument("--fresh-principal", action="store_true")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command: parser.error("an explicit command is required")
    output = Path(args.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists(): parser.error("refusing to replace an existing recording")
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 90, 0, 0))
    env = dict(os.environ, TERM="xterm-256color", FORCE_COLOR="1")
    env.pop("NO_COLOR", None)
    if args.fresh_principal:
        for key in ("CODEX_THREAD_ID", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDECODE"):
            env.pop(key, None)
    child = subprocess.Popen(command, cwd=args.cwd, env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
    os.close(slave)
    emulator = subprocess.Popen(["node", str(Path(__file__).with_name("emulate.mjs"))],
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
    def emulate(request):
        emulator.stdin.write(json.dumps(request) + "\n"); emulator.stdin.flush()
        while True:
            answer = json.loads(emulator.stdout.readline())
            if "response" in answer: os.write(master, base64.b64decode(answer["response"]))
            else: return answer
    def current_frame():
        elapsed = time.monotonic() - started
        result = emulate({"snapshot": True})
        safe = redacted("".join(run["text"] for row in result["rows"] for run in row))
        offset = 0
        for row in result["rows"]:
            for run in row:
                count = len(run["text"])
                run["text"] = safe[offset:offset + count]; offset += count
        return {"timeMs": round(elapsed * 1000), **result}
    started = time.monotonic(); frames = []; prior = None; last_frame = 0; input_buffer = b""
    def capture():
        nonlocal prior, last_frame
        current = current_frame()
        identity = json.dumps([current["rows"], current["cursor"]])
        if identity != prior:
            frames.append(current); prior = identity
        last_frame = time.monotonic()
    def save():
        capture()
        with output.open("w", encoding="utf8") as handle:
            os.chmod(output, 0o600)
            json.dump({"version": 1, "columns": 90, "rows": 24,
                       "frames": frames}, handle, separators=(",", ":"))
    print(json.dumps({"ready": True, "columns": 90, "rows": 24}), flush=True)
    try:
        while time.monotonic() - started < args.seconds and len(frames) < 12000:
            readable, _, _ = select.select([master, sys.stdin], [], [], .05)
            if master in readable:
                try: data = os.read(master, 65536)
                except OSError: break
                if not data: break
                emulate({"data": base64.b64encode(data).decode()})
            if sys.stdin in readable:
                chunk = os.read(sys.stdin.fileno(), 65536)
                if not chunk: break
                input_buffer += chunk
                while b"\n" in input_buffer:
                    line, input_buffer = input_buffer.split(b"\n", 1)
                    request = json.loads(line)
                    if "input" in request: os.write(master, request["input"].encode())
                    if request.get("snapshot"):
                        current = current_frame()
                        print(json.dumps({"timeMs": current["timeMs"], "screen": "\n".join("".join(run["text"] for run in row).rstrip() for row in current["rows"])}), flush=True)
                    if request.get("save"): save(); print(json.dumps({"savedFrames":len(frames)}), flush=True)
                    if request.get("stop"): return
            if time.monotonic() - last_frame >= .1: capture()
            if child.poll() is not None: break
    finally:
        save()
        if emulator:
            emulator.stdin.close(); emulator.wait(timeout=5)
        if child.poll() is None:
            child.send_signal(signal.SIGTERM)
            try: child.wait(timeout=5)
            except subprocess.TimeoutExpired: child.kill(); child.wait()
        os.close(master)
        print(json.dumps({"closed": True, "frames": len(frames)}), flush=True)

if __name__ == "__main__": main()
