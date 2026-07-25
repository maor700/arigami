#!/usr/bin/env python3
# pty-bridge: run an interactive TTY program (e.g. `claude setup-token`) under a
# real pseudo-terminal and relay its I/O to plain stdio pipes, so a non-TTY
# parent (the Bun host server) can capture output and feed input. stdlib only.
#
# Usage: python3 pty-bridge.py <cmd> [args...]
#   parent stdout  <- child pty output
#   parent stdin   -> child pty input (e.g. an OAuth code)
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios


def main():
    cmd = sys.argv[1:]
    if not cmd:
        sys.stderr.write("pty-bridge: no command\n")
        return 2

    pid, fd = pty.fork()
    if pid == 0:
        os.execvp(cmd[0], cmd)
        os._exit(127)  # exec failed

    # pty.fork() puts the child in its own session, so it does NOT die when this
    # bridge is killed. Propagate termination explicitly so a cancelled/timed-out
    # auth never orphans a `claude setup-token`.
    def _terminate(_signum=None, _frame=None):
        try:
            os.kill(pid, signal.SIGKILL)
        except OSError:
            pass
        os._exit(0)

    signal.signal(signal.SIGTERM, _terminate)
    signal.signal(signal.SIGHUP, _terminate)

    # Wide, tall window so long output (the OAuth token) is never wrapped across
    # lines with hard breaks — the parent scrapes it whole.
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 100, 1000, 0, 0))
    except OSError:
        pass

    stdin_open = True
    try:
        while True:
            watch = [fd] + ([0] if stdin_open else [])
            try:
                r, _, _ = select.select(watch, [], [])
            except (OSError, ValueError):
                break
            if fd in r:
                try:
                    data = os.read(fd, 4096)
                except OSError:
                    break
                if not data:
                    break
                os.write(1, data)
            if stdin_open and 0 in r:
                try:
                    data = os.read(0, 4096)
                except OSError:
                    data = b""
                if not data:
                    stdin_open = False  # EOF on our stdin; stop watching it
                else:
                    try:
                        os.write(fd, data)
                    except OSError:
                        stdin_open = False
    finally:
        try:
            os.close(fd)
        except OSError:
            pass
        _, status = os.waitpid(pid, 0)
        return os.waitstatus_to_exitcode(status) if hasattr(os, "waitstatus_to_exitcode") else 0


if __name__ == "__main__":
    sys.exit(main())
