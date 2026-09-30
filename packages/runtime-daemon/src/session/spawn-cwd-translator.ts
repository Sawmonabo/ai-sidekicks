import type { SpawnRequest } from "../pty/pty-host-protocol.js";
// Rewrites a spawn request so the PTY's cwd is a stable directory instead of a worktree.
//
// On Windows the OS locks the cwd of a spawned process for the process's lifetime, so deleting or
// moving a worktree fails with `ERROR_SHARING_VIOLATION` while any PTY is rooted in it. The
// translator sets `cwd` to a directory that never moves and carries the worktree path in the
// command string (`cd-prefix`, for shells) or the environment (`cwd-env`, for agent CLIs that
// read `CWD`). It is a pure transform, so neither PTY backend needs to know about it.
//
// Call it once per spawn, just before `PtyHost.spawn`. A second call would wrap the request
// again, and the module does not detect that: a marker would either ride the wire or collide
// with the `cwd-env` strategy.

/**
 * How the worktree path is carried once `cwd` is replaced.
 *
 * - `cd-prefix`: wraps the spawn in a shell that `cd`s into the worktree, then runs the original
 *   command. For spawn targets that are themselves shells; it changes `command` and `args`.
 * - `cwd-env`: adds a `CWD` environment entry. For agent CLIs that read `CWD` at startup; it
 *   changes `env` only.
 */
export type DriverStrategy = "cd-prefix" | "cwd-env";

/**
 * The shell the `cd-prefix` strategy wraps the command in.
 *
 * - `posix`: `/bin/sh -c "cd <quoted> && exec <command>"`. `exec` replaces the shell, so the
 *   PTY's child is the target process.
 * - `windows-cmd`: `cmd.exe /d /s /v:off /c "cd /d <quoted> && <command>"`. Windows has no
 *   `exec`, so the wrapper stays in the process tree; that is harmless because the lock is on
 *   `stableParent`, not the worktree.
 *
 * Defaults to `windows-cmd` on Windows and `posix` elsewhere.
 */
export type WrappingShell = "posix" | "windows-cmd";

/** Input to `translateSpawnCwd`. */
export interface TranslateSpawnCwdInput {
  /** The spawn request whose `cwd` is the worktree path. */
  spec: SpawnRequest;
  /** How to carry the worktree path. */
  strategy: DriverStrategy;
  /** A directory that survives worktree teardown, such as the daemon's working directory. */
  stableParent: string;
  /** The shell for `cd-prefix`; ignored by `cwd-env`. */
  wrappingShell?: WrappingShell;
}

/**
 * Returns a new `SpawnRequest` whose `cwd` is `stableParent` and which carries the original
 * `cwd` per `strategy`; the input and its `env` array are not mutated. Throws when
 * `stableParent` is empty, because Windows would fall back to the parent process's cwd and the
 * lock the translation avoids would return.
 */
export function translateSpawnCwd(input: TranslateSpawnCwdInput): SpawnRequest {
  const { spec, strategy, stableParent } = input;

  if (stableParent.length === 0) {
    throw new Error(
      "translateSpawnCwd: `stableParent` must be a non-empty path; empty cwd " +
        "is not a stable parent on Windows (spawn falls back to parent process cwd).",
    );
  }

  const worktreePath: string = spec.cwd;

  if (strategy === "cwd-env") {
    // Appended: a later env entry shadows an earlier one, so the translator's `CWD` wins.
    const newEnv: Array<[string, string]> = [...spec.env, ["CWD", worktreePath]];
    return {
      kind: "spawn_request",
      command: spec.command,
      args: spec.args,
      env: newEnv,
      cwd: stableParent,
      rows: spec.rows,
      cols: spec.cols,
    };
  }

  // strategy === "cd-prefix"
  const shell: WrappingShell =
    input.wrappingShell ?? (process.platform === "win32" ? "windows-cmd" : "posix");

  if (shell === "posix") {
    // `exec` replaces the wrapper shell, so the PTY child is the target and kill signals reach it.
    const quotedWorktree: string = quotePosix(worktreePath);
    const quotedCommand: string = quotePosix(spec.command);
    const quotedArgs: string = spec.args.map(quotePosix).join(" ");
    const shellScript: string =
      `cd ${quotedWorktree} && exec ${quotedCommand}` +
      (quotedArgs.length > 0 ? ` ${quotedArgs}` : "");
    return {
      kind: "spawn_request",
      command: "/bin/sh",
      args: ["-c", shellScript],
      env: spec.env,
      cwd: stableParent,
      rows: spec.rows,
      cols: spec.cols,
    };
  }

  // shell === "windows-cmd": cmd.exe /d /s /v:off /c "cd /d "<worktree>" && "<cmd>" <args>"
  //   /d     skips AutoRun, so shell-init scripts cannot interfere.
  //   /s     strips the outer quotes when the line starts and ends with `"`; without it a path
  //          with spaces misparses.
  //   /v:off disables delayed expansion whatever the registry default, so a `!` in an argument
  //          is literal; `quoteWindowsCmd` relies on this and does not escape `!`.
  //   /c     must come last: cmd.exe takes the rest of the line as the command.
  //   cd /d  lets `cd` switch drives; without it a path on another drive silently does nothing.
  const quotedWorktreeWin: string = quoteWindowsCmd(worktreePath);
  const quotedCommandWin: string = quoteWindowsCmd(spec.command);
  const quotedArgsWin: string = spec.args.map(quoteWindowsCmd).join(" ");
  const winScript: string =
    `cd /d ${quotedWorktreeWin} && ${quotedCommandWin}` +
    (quotedArgsWin.length > 0 ? ` ${quotedArgsWin}` : "");
  return {
    kind: "spawn_request",
    command: "cmd.exe",
    args: ["/d", "/s", "/v:off", "/c", winScript],
    env: spec.env,
    cwd: stableParent,
    rows: spec.rows,
    cols: spec.cols,
  };
}

/**
 * Single-quotes a value for an `sh -c` command line. Nothing inside `'...'` is interpreted, so an
 * embedded `'` is written as `'\''` (close, escaped quote, reopen).
 */
function quotePosix(value: string): string {
  if (value.length === 0) {
    return "''";
  }
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

/**
 * Quotes a value for a `cmd.exe /c` line. cmd.exe interprets metacharacters even inside double
 * quotes, so the value gets `^` before each of `^ & | < > %` (`%` matters most: without `^%` an
 * argument like `%PROD%` is expanded by the wrapper instead of reaching the target literally),
 * a doubled `"`, and outer quotes. `^` is escaped first so the carets added for the other
 * characters are not escaped again. `!` needs no escape because the wrapper passes `/v:off`.
 * An empty value becomes `""`.
 */
function quoteWindowsCmd(value: string): string {
  if (value.length === 0) {
    return '""';
  }
  let escaped: string = value.replace(/\^/g, "^^");
  escaped = escaped.replace(/&/g, "^&");
  escaped = escaped.replace(/\|/g, "^|");
  escaped = escaped.replace(/</g, "^<");
  escaped = escaped.replace(/>/g, "^>");
  escaped = escaped.replace(/%/g, "^%");
  return '"' + escaped.replace(/"/g, '""') + '"';
}
