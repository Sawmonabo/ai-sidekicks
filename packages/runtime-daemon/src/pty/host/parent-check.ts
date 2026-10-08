// node-pty's macOS helper takes its terminal only just before it starts the program, so a daemon
// killed in that moment leaves a program that never gets the hangup, and macOS hides the
// environment of its own shells from the leftover search. A terminal child therefore starts
// through `/bin/sh`, which already holds the terminal and goes on only while the daemon is still
// its parent: a daemon dead before the check starts nothing, and one dead after it hangs the
// program up when its end of the terminal closes. The program and its arguments travel as argv
// (`$0` and `"$@"`), never parsed by a shell, so any bytes pass through exactly.

/**
 * Rewrites a POSIX terminal child's launch so `/bin/sh` starts `command` with `args` only while
 * the process `daemonProcessId` is still its parent, and exits 1 otherwise.
 */
export function requireDaemonParent(
  command: string,
  args: readonly string[],
  daemonProcessId: number,
): { readonly command: string; readonly args: string[] } {
  const script = `[ "$PPID" = "${String(daemonProcessId)}" ] || exit 1; exec "$0" "$@"`;
  return { command: "/bin/sh", args: ["-c", script, command, ...args] };
}
