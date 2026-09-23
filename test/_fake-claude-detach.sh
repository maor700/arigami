#!/bin/sh
# Fake `claude` for reap tests. Does what agents actually do on a real host:
# records the env it was given, then starts a long-running process DETACHED
# (`cmd &` inside a subshell that exits at once, so the child is reparented to
# init and is no longer in this process's tree), then stays alive like a
# session would.
env > "$FAKE_ENV_OUT"
# bun, not /bin/sleep: macOS hides the environment of its own SIP binaries, and
# what leaks in practice is node/bun (vite, Storybook) anyway.
( bun -e 'setTimeout(() => {}, 300000)' & echo $! > "$FAKE_DETACHED_PID" )
# a temp file the way a tool would make one — through $TMPDIR
echo scratch > "${TMPDIR:-/tmp}/fake-claude-scratch.txt"
exec bun -e 'setTimeout(() => {}, 300000)'
