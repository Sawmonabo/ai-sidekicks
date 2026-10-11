// node-pty's macOS helper takes its terminal only just before it starts the program, so a daemon
// killed in that moment leaves a program that never gets the hangup, and macOS hides the
// environment of its own shells from the leftover search. A terminal child therefore starts
// through `/bin/sh`, which already holds the terminal and goes on only if the daemon was its
// parent when it started, as the shell sets `$PPID` once, then: a daemon dead before that starts
// nothing, and one dead after it hangs the program up when its end of the terminal closes. The
// program and its arguments travel as argv (`$0` and `"$@"`), never parsed by a shell, so any
// bytes pass through exactly.

import type { TerminalChildLaunch } from "./contract.js";

/**
 * Rewrites a POSIX terminal child's launch so `/bin/sh` starts `command` with `args` only if the
 * process `daemonProcessId` was its parent when it started, and exits 1 otherwise.
 */
export function requireDaemonParent(
  command: string,
  args: readonly string[],
  daemonProcessId: number,
): TerminalChildLaunch {
  const script = `[ "$PPID" = "${String(daemonProcessId)}" ] || exit 1; exec "$0" "$@"`;
  return { command: "/bin/sh", args: ["-c", script, command, ...args] };
}
