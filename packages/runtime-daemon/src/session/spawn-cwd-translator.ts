// Daemon-layer cwd translation for worktree paths.
//
// Why this exists
// ---------------
// On Windows, the OS holds a directory lock on the cwd passed at PTY spawn
// for the lifetime of the spawned process. Any attempt to delete, move, or
// unmount that directory while the child runs fails with
// `ERROR_SHARING_VIOLATION` (the `microsoft/node-pty#647` failure mode).
// This breaks worktree workflows: `git worktree remove <path>` cannot
// succeed until every PTY session rooted at the worktree has exited.
//
// The fix is OS-level, not backend-specific: the daemon rewrites every
// `SpawnRequest` so its `cwd` field carries a stable parent directory
// (one that never moves — typically the daemon's working dir or the
// user-home root). The logical worktree path moves up into either the
// command string (`cd <worktree> && <command>`) or the process
// environment (`CWD=<worktree>`). The PTY backend — Rust sidecar or
// in-process `node-pty` — sees only the stable parent and is therefore
// unable to lock the worktree directory.
//
// Per-driver dispatch table
// -------------------------
//
//   driver type            | strategy   | side effects
//   ---------------------- | ---------- | --------------------------------
//   shell session (bash,   | cd-prefix  | mutates `command` + `args` —
//   zsh, cmd, pwsh, etc.)  |            | visible to audit-log canonical
//                          |            | hash (the spawn command string
//                          |            | changes).
//   ---------------------- | ---------- | --------------------------------
//   claude-driver,         | cwd-env    | mutates `env` only — invisible
//   codex-driver, other    |            | to canonical bytes; the agent
//   agent CLIs that read   |            | CLI consumes `CWD` from env
//   `CWD` from env         |            | internally.
//
// The caller picks the strategy from its own driver-classification
// context (the strategy is a function of the spawn target, not of the
// `SpawnRequest` shape itself). This module exposes a pure transform
// rather than a wrapping host so neither `RustSidecarPtyHost` nor
// `NodePtyHost` need to know about translation — composition happens
// at the single session-spawn entry point in the daemon, above both
// backend implementations.
//
// Invocation contract
// -------------------
//
// Call this transform exactly ONCE per logical spawn, immediately
// before forwarding the resulting `SpawnRequest` to `PtyHost.spawn`.
// Calling twice nests the wrapping (the second call sees the already-
// translated `cwd === stableParent` and wraps again). The caller's
// contract is single-invocation; this module performs no idempotency
// detection because the marker would either ride the wire (mutating
// the protocol contract) or live in env (colliding with the cwd-env
// strategy itself).

import type { SpawnRequest } from "@ai-sidekicks/contracts";

/**
 * Per-driver translation strategy.
 *
 * - `cd-prefix` — wraps the spawn in a shell that `cd`s into the
 *   worktree before exec-ing the original command. Use for shell
 *   sessions (bash, zsh, cmd.exe, pwsh, etc.) where the spawn target
 *   is itself a shell.
 * - `cwd-env` — passes the worktree path via a `CWD` environment
 *   entry. Use for agent CLIs (claude-driver, codex-driver, etc.)
 *   that consume `CWD` from their own env at startup.
 */
export type DriverStrategy = "cd-prefix" | "cwd-env";

/**
 * Wrapping-shell flavor used by the `cd-prefix` strategy.
 *
 * - `posix` — uses `/bin/sh -c "cd <quoted> && exec <command>"` on
 *   Linux/macOS. `exec` replaces the shell with the target process
 *   so the PTY's child is the target, not a long-lived intermediate.
 * - `windows-cmd` — uses `cmd.exe /d /s /c "cd /d <quoted> && <command>"`.
 *   Windows lacks `exec`; the wrapping shell remains in the process
 *   tree, which is acceptable because the OS-level lock has already
 *   moved off the worktree directory by then.
 *
 * Defaults to `posix` on non-Windows platforms and `windows-cmd` on
 * Windows when omitted in `TranslateSpawnCwdInput`.
 */
export type WrappingShell = "posix" | "windows-cmd";

/**
 * Pure-function input to `translateSpawnCwd`.
 */
export interface TranslateSpawnCwdInput {
  /** Logical spawn request — its `cwd` typically points at a worktree path. */
  spec: SpawnRequest;
  /** Which strategy to apply (per the dispatch table in the module header). */
  strategy: DriverStrategy;
  /**
   * Stable parent directory that survives worktree teardown. Typically
   * the daemon's working directory or the user-home root. The
   * translator substitutes this for `spec.cwd` so the PTY backend
   * spawn-call cwd is unlockable in any worktree-teardown sense.
   */
  stableParent: string;
  /**
   * Wrapping-shell flavor for the `cd-prefix` strategy. Ignored by
   * `cwd-env`. Defaults to `windows-cmd` when `process.platform ===
   * "win32"` and `posix` otherwise.
   */
  wrappingShell?: WrappingShell;
}

/**
 * Translate a logical `SpawnRequest` so its `cwd` no longer references
 * a worktree path. The logical worktree path migrates into either the
 * command string (`cd-prefix`) or the env tuples (`cwd-env`) per the
 * `strategy` argument.
 *
 * The returned `SpawnRequest` is a new object — the input `spec` is
 * not mutated, and the input `env` array is not mutated (a copy is
 * appended-to under `cwd-env`).
 *
 * @throws Error when `stableParent` is empty (a stable parent must be
 *   a real path; an empty string would still trip `ERROR_SHARING_VIOLATION`
 *   because Windows treats an empty cwd as "use current directory of the
 *   parent process," which on the daemon happens to be the user's last
 *   working dir and is not under our control).
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
    // Append, don't prepend — process-spawn env-tuple shape preserves
    // order and allows duplicates per `pty-host-protocol.ts`. A later
    // tuple shadows an earlier one under POSIX `execve`; appending lets
    // a caller pre-stamp an explicit `CWD` if they need to override.
    // We still append even when the input has a prior `CWD` — the
    // contract is "the translator's value wins for THIS spawn."
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
    // sh -c "cd '<worktree>' && exec '<cmd>' '<arg1>' '<arg2>' ..."
    //
    // `exec` replaces the shell process with the target so the PTY's
    // child PID is the target's, not the wrapper shell's. Without
    // exec, the wrapper shell would persist as the PTY parent and
    // signal handling (Plan-024 kill translation) would target the
    // wrapper not the user-visible process.
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

  // shell === "windows-cmd"
  //
  // cmd.exe /d /s /v:off /c "cd /d "<worktree>" && "<cmd>" <args>"
  //
  //   /d    — skip AutoRun (avoids surprising shell-init side effects)
  //   /s    — strip the outer quotes per cmd.exe argument-parsing rules
  //           when the command line starts and ends with a `"`. Without
  //           /s, cmd.exe's path-with-spaces handling diverges from
  //           POSIX expectation and the `cd /d "<path>"` form misparses.
  //   /v:off — explicitly disable delayed expansion of `!VAR!` syntax,
  //           invariant to the per-system registry default at
  //           `HKLM\\SOFTWARE\\Microsoft\\Command Processor\\DelayedExpansion`
  //           (and the `HKCU` equivalent). Without this, an arg
  //           containing `!VAR!` would expand at the wrapper-cmd.exe
  //           layer on systems where an operator has flipped the
  //           registry default to ON. `quoteWindowsCmd` does not
  //           caret-escape `!` because the registry-OFF default makes
  //           `!` an ordinary character; `/v:off` enforces that
  //           assumption at every site regardless of registry state.
  //   /c    — run the command and terminate. MUST come last in the flag
  //           list because cmd.exe consumes the rest of the command line
  //           as the command to run; `/v:off` must precede `/c`.
  //   /d (cd) — the `/d` argument to `cd` itself allows drive-letter
  //           switches (e.g., `cd /d D:\\worktrees\\foo` works across
  //           drive boundaries; `cd D:\\worktrees\\foo` without /d
  //           silently no-ops if the current drive is C:).
  //
  // Windows has no `exec` builtin, so the wrapper cmd.exe remains in
  // the process tree. The OS-level worktree lock has already moved
  // off the worktree directory by the time cmd.exe spawns the target
  // (the spawn-call cwd is `stableParent`), so this is correct for
  // ERROR_SHARING_VIOLATION purposes — the residual cost is one extra
  // cmd.exe process per session.
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
 * POSIX single-quote-wrap a path/argument so the resulting string is
 * safe to splice into an `sh -c` command line.
 *
 * The single-quote form is the strongest POSIX quoting: nothing inside
 * `'...'` is interpreted except the closing `'`. To embed a literal
 * `'`, end the quote, emit `\'`, and re-open: `'a'\''b'` → `a'b`.
 */
function quotePosix(value: string): string {
  if (value.length === 0) {
    return "''";
  }
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

/**
 * Windows cmd.exe quote-wrap. The cmd.exe parser interprets several
 * characters even inside double-quoted spans, so the wrapper must:
 *
 *   1. Caret-escape cmd.exe metacharacters (`^`, `&`, `|`, `<`, `>`, `%`).
 *      The caret (`^`) is cmd.exe's documented escape character; a
 *      caret followed by a metacharacter passes the metacharacter
 *      through literally to the target process. The `%` case is the
 *      load-bearing one for argument content: cmd.exe's variable-
 *      expansion pass scans `/c` script bytes for `%VAR%` even inside
 *      `"..."` spans, so an arg like `--env=%PROD%` would be expanded
 *      at the wrapper layer (wrong — the target process should see
 *      `%PROD%` literally and decide its own env handling). Escaping
 *      `%` as `^%` neutralizes the variable scanner because the
 *      caret consumes the leading `%`, breaking the `%...%` pair.
 *   2. Order matters: escape `^` FIRST. Steps 2-onward emit new `^`
 *      bytes (e.g., `&` → `^&`), and if we escaped `^` AFTER those,
 *      we would re-escape the carets we just introduced
 *      (`^&` → `^^&`, wrong).
 *   3. Double a literal `"` (cmd.exe's quoting-span escape is doubling,
 *      not caret).
 *   4. Wrap the result in outer `"..."`.
 *
 * Primary source: Microsoft Learn — "Windows commands / cmd" and the
 * "command-line shell" parsing reference. Caret escape semantics are
 * documented for `& | < > ^ %`. Delayed-expansion `!` is intentionally
 * out of scope here: the wrapper passes `/v:off` explicitly to disable
 * delayed expansion regardless of the per-system registry default at
 * `HKLM\\SOFTWARE\\Microsoft\\Command Processor\\DelayedExpansion`, so
 * `!` always reaches the target process literally and need not be
 * escaped at the quoting layer.
 *
 * Empty string → `""` (two literal quotes; cmd.exe parses as empty arg).
 */
function quoteWindowsCmd(value: string): string {
  if (value.length === 0) {
    return '""';
  }
  // Caret first (steps 2+ introduce new carets we must not re-escape).
  let escaped: string = value.replace(/\^/g, "^^");
  // Then each remaining cmd.exe metacharacter. `%` is the load-bearing
  // one — without `^%`, args containing `%VAR%` are expanded at the
  // wrapper-cmd.exe layer instead of being passed through literally.
  escaped = escaped.replace(/&/g, "^&");
  escaped = escaped.replace(/\|/g, "^|");
  escaped = escaped.replace(/</g, "^<");
  escaped = escaped.replace(/>/g, "^>");
  escaped = escaped.replace(/%/g, "^%");
  // Finally, double literal `"` (cmd.exe's quoting-span escape) and
  // wrap in outer quotes.
  return '"' + escaped.replace(/"/g, '""') + '"';
}
