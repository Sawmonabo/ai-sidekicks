// Canonical repo-root resolver (Plan-009 Phase 1 T1.5) — the single place a
// user-entered local path becomes the `{canonicalRoot, vcsType}` pair Phase 2
// persists as `repo_mounts.canonical_root` / `repo_mounts.vcs_type`.
//
// Spec coverage:
//   * `Spec-009 §Required Behavior` — "Repo attach must resolve and persist the
//     canonical repository root, not only the user-entered path."
//   * `Spec-009 §Implementation Notes` — "Repo attach should not assume that
//     the user-selected path is already the repo root."
//   * `Spec-009 §Fallback Behavior` — "If a path is not a git repository, the
//     system may bind it as a plain directory workspace with git-specific
//     features disabled" AND "If canonical root resolution fails, repo attach
//     must fail explicitly rather than guessing."
//
// Invariants enforced here (canonical text in
// `docs/plans/009-repo-attachment-and-workspace-binding.md §Invariants`):
//   * I-009-1 — canonical-root fidelity. Every value this module returns has
//     been through `realpath`, so the persisted root is the physical path and
//     never an alias or the raw user input. The absoluteness of the result is
//     re-asserted structurally before it is returned.
//   * I-009-2 — explicit resolution failure. Every path that is not a
//     successful resolution THROWS `RepoRootResolutionError`. There is no
//     partial-success return, no fallback to the user-entered path, and no
//     inferred root — including no root inferred by completing an input that
//     does not name one whole location (a relative path, `~`, or a driveless
//     Windows root) out of daemon-side state, which the step-1 gate refuses.
//   * I-009-4 — honest non-git classification. `vcsType: "none"` is produced
//     ONLY on a positive "git ran and reported not-a-repository" verdict.
//     Every other failure — git missing, git non-executable, git killed, git
//     failing for any other reason — routes to `vcs_error`. See the
//     fail-closed note on `classifyGitFailure` below.
//
// Mechanism, and why it is not a `.git` walk
// --------------------------------------------------------------------------
// Resolution asks git itself: `git -C <path> rev-parse --show-toplevel`,
// invoked argv-only through `execFile` (never `shell: true`, so no path a user
// types can reach a shell). Plan-009 T1.5 ratifies this over the obvious
// alternative — walking parent directories looking for a `.git` DIRECTORY —
// because in a linked worktree and in a submodule `.git` is a FILE containing a
// `gitdir:` pointer, so the walk either misses the repository entirely or
// reports the wrong root. `rev-parse` answers with git's own discovery rules,
// which is the only answer that stays correct as those rules evolve.
//
// ORDER IS LOAD-BEARING: the input is realpath'd BEFORE git sees it. That is
// what makes the symlink case (I-009-1) correct rather than incidental — git
// never observes the alias, so its discovery runs against the physical path and
// cannot report a toplevel reached through the symlink. git's output is then
// realpath'd AGAIN: git generally reports a physical path already, but that is
// a property of how git computes the current directory rather than a documented
// contract, and I-009-1 is not a guarantee to hold conditionally.
//
// Ambient `GIT_*` hijacking
// --------------------------------------------------------------------------
// The child environment inherits `process.env` (it must — a bare `git` is found
// through the child's own executable search, and Windows needs `SystemRoot` and
// friends), but the discovery-redirecting `GIT_*` variables are DELETED from
// the copy, along with both env-borne config-injection channels that could
// reach them indirectly. A daemon launched from a shell that exported
// `GIT_DIR` or `GIT_WORK_TREE` would otherwise have every attach answered
// about the ambient repository instead of the supplied path — a resolved root
// with no relation to its input, which is precisely the guessed root I-009-1
// forbids.
// `GIT_CEILING_DIRECTORIES` is the mirror-image hazard: it bounds upward
// discovery, so an ambient value can make git report not-a-repository for a
// real repository, reclassifying it `vcsType: "none"` in violation of I-009-4.
//
// Locale is pinned to `C` for the same class of reason: the not-a-repository
// verdict is read off git's own stderr, and git translates its messages through
// gettext. An operator running a localized shell must not change how this
// module classifies a plain directory.
//
// How a bare `git` is found, and the Windows exposure
// --------------------------------------------------------------------------
// `DEFAULT_GIT_EXECUTABLE` is the separator-less name `"git"`, so the child's
// executable search is the platform's own. On POSIX that search is `PATH`. On
// Windows it is NOT: libuv's `search_path` (`src/win/process.c`) looks in the
// spawning process's CURRENT DIRECTORY first and only then walks `PATH`, for
// any name containing no separator. A `git.exe` sitting in whatever directory
// the daemon happens to be running from would therefore be executed with the
// daemon's privileges. The daemon already spawns a bare `taskkill` on its
// Windows kill path (`../pty/taskkill-windows.ts`, wired as the default in both
// PTY backends); this module adds a SECOND bare-name spawn, and the same search
// rule applies to both.
//
// Environment scrubbing cannot close it, because the search is not driven by
// the environment. The seam that closes it is `gitExecutablePath`: set to an
// absolute path, it skips the search entirely, and a Windows deployment
// (ADR-019 V1 tier) should set it. Making an absolute path the DEFAULT is
// Phase 2 configuration work — Phase 1 has no daemon config surface to read
// one from — so this module states the exposure rather than carrying it
// silently.
//
// The input must name ONE COMPLETE LOCATION — step 1 refuses everything else
// --------------------------------------------------------------------------
// A relative path, a `~`-prefixed path, and — on Windows — a driveless rooted
// path such as `\repos\foo` all share one defect: none of them names a location
// on its own. Each omits a different piece, and the daemon can only supply the
// missing piece out of its OWN state: the working directory for a relative
// path, `os.homedir()` for `~`, the process's CURRENT DRIVE for `\repos\foo`.
// Under the cross-node model the daemon may run on a different machine and as a
// different OS user than the client that typed the path
// (`Spec-009 §Implementation Notes` — mount ownership belongs to the node that
// can actually reach it), so none of those three is the author's context, and a
// root completed from any of them is a guess. I-009-2 forbids guessing, and
// `error-contracts.md §Repo` puts it plainly: attach "fails explicitly rather
// than guessing".
//
// `isAbsolute` alone cannot express that rule on Windows, where it asks only
// whether a path starts with a separator. See `namesCompleteLocation` for the
// parsed-root test that does express it, and for why it is win32-scoped.
//
// The `path` module is an injected seam for exactly this reason, and win32-ness
// is derived from the injected module's `sep` rather than from
// `process.platform`: that is what lets POSIX CI drive the Windows branch by
// handing the resolver `path.win32`. Keyed off the real platform instead, the
// branch that matters most on an ADR-019 V1 tier would be exercised only on a
// Windows runner. The rule as a whole is the "cross-platform absoluteness rule"
// `packages/contracts/src/repo.ts` assigns to this resolver when it explains why
// the WIRE schema stays permissive.
//
// Ordering is what makes the gate worth having. `realpath` would happily
// complete `src/workspace` against the daemon's cwd and return a real,
// resolvable, entirely plausible root — a silent wrong answer, which is the
// worst shape for a value Phase 2 persists. Refusing before `realpath` is also
// what keeps `~`'s refusal honest: unexpanded, `~` is nothing but a literal
// directory name to the filesystem, so a machine that happened to hold a
// directory named `~` would RESOLVE it. Gating first makes the outcome a
// property of the input rather than of the host's directory listing.
//
// Tilde is still never EXPANDED here, and refusing it is not a step toward
// expanding it later. Expansion belongs to the client/CLI layer, which holds the
// shell context that gives `~` its meaning; so does resolving a relative path
// against the AUTHOR's working directory, and so does naming the volume a
// driveless Windows path leaves out. All three belong before the wire.

import { execFile } from "node:child_process";
import { realpath as realpathFromFilesystem } from "node:fs/promises";
import * as nodePath from "node:path";

import type { VcsType } from "@ai-sidekicks/contracts";

import { RepoRootResolutionError } from "./repo-errors.js";

// --------------------------------------------------------------------------
// Public result shape
// --------------------------------------------------------------------------

/**
 * The resolver's only successful output — and, per the T1.5 acceptance
 * criterion, the only value Phase 2 may persist as `canonical_root` /
 * `vcs_type`.
 *
 * `canonicalRoot` is always absolute and symlink-resolved. `vcsType` composes
 * T1.1's closed two-value union (`@ai-sidekicks/contracts`) rather than a local
 * string: I-009-4 pins that union CLOSED, and re-spelling it here would be the
 * widening seam the invariant forbids.
 */
export interface RepoRootResolution {
  readonly canonicalRoot: string;
  readonly vcsType: VcsType;
}

// --------------------------------------------------------------------------
// Injected seams
// --------------------------------------------------------------------------
//
// Shaped after `RustSidecarPtyHostDeps` (`../pty/rust-sidecar-pty-host.ts`):
// every effectful primitive is reachable through a `Partial` record whose
// unset members wire to the real implementations, so tests drive failure modes
// without monkey-patching `node:child_process` or `node:fs`.
//
// The executor seam is deliberately LOW-LEVEL — it rejects with whatever the
// underlying `execFile` rejects with, and the git/no-git discrimination stays
// in this module. The tempting alternative, a seam that returns an already
// classified `{kind: "exited" | "spawn-failed" | "signaled"}` union, was
// rejected: it would move the I-009-4 discrimination into the default
// implementation, which is exactly the code an injected test double replaces
// and therefore never exercises. Keeping the raw shape means the resolver's
// classifier can be driven by REAL Node errors (point `gitExecutablePath` at a
// nonexistent file and the real `execFile` produces a real `ENOENT`).

/** Successful stdio capture of the git invocation. */
export interface GitCommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * What a rejected git invocation carries. Mirrors Node's
 * `ExecFileException` plus the captured stdio the default executor attaches:
 *
 *   * `code` — the EXIT CODE (a number) when git ran and exited, or an errno
 *     string such as `"ENOENT"` when the process could not be spawned at all.
 *     That number/string split is the primary I-009-4 discriminator.
 *   * `signal` / `killed` — set when the child was terminated rather than
 *     having exited on its own (including the executor's own timeout kill).
 *
 * Declared for the benefit of test doubles and readers; the classifier below
 * reads these properties defensively off `unknown`, because an injected
 * executor may reject with anything at all.
 */
export interface GitCommandFailure extends Error {
  readonly code?: string | number | undefined;
  readonly signal?: NodeJS.Signals | null | undefined;
  readonly killed?: boolean | undefined;
  readonly stdout?: string | undefined;
  readonly stderr?: string | undefined;
}

/** Child-process options the resolver fixes for every git invocation. */
export interface GitCommandOptions {
  readonly timeout: number;
  readonly maxBuffer: number;
  readonly env: NodeJS.ProcessEnv;
  readonly windowsHide: boolean;
}

/**
 * `execFile`-shaped seam. Argv-only by construction — the command and its
 * arguments are separate parameters and no options member can request a
 * shell, so a path containing shell metacharacters is inert.
 */
export type GitFileExecutor = (
  file: string,
  args: readonly string[],
  options: GitCommandOptions,
) => Promise<GitCommandResult>;

/** `fs.promises.realpath` seam. Rejects with a Node `ErrnoException`. */
export type PathRealpathResolver = (path: string) => Promise<string>;

/**
 * The slice of `node:path` the step-1 gate reads. A structural subset rather
 * than the whole `PlatformPath`: it advertises exactly the three members this
 * module depends on, and both `path.win32` and `path.posix` satisfy it — which
 * is the point of the seam, since it makes the Windows branch drivable from
 * POSIX CI.
 */
export interface PlatformPathModule {
  readonly sep: string;
  isAbsolute(path: string): boolean;
  parse(path: string): { readonly root: string };
}

/** Constructor-injectable primitives; every member defaults to the real one. */
export interface RepoRootResolverDeps {
  /** Defaults to a promise wrapper over `node:child_process.execFile`. */
  readonly executeFile: GitFileExecutor;
  /** Defaults to `node:fs/promises.realpath`. */
  readonly realpath: PathRealpathResolver;
  /**
   * Defaults to the bare `"git"`, left to the platform's executable search.
   * Injectable for tests (pointing it at a nonexistent file yields a genuine
   * spawn `ENOENT`, the headline I-009-4 case), as the seam a later phase would
   * use to honor a daemon-configured git path, and — see the header — as the
   * only way to escape Windows' cwd-first search for a separator-less name.
   */
  readonly gitExecutablePath: string;
  /** Wall-clock bound on the git invocation; see the constant below. */
  readonly gitCommandTimeoutMs: number;
  /**
   * Defaults to `node:path`, already bound to the host platform. Injected as
   * `path.win32` by the suite so the driveless-root refusal — a Windows-only
   * shape on an ADR-019 V1 tier — is exercised on POSIX CI rather than only on
   * a Windows runner. Read by the step-1 gate ONLY: the two backstops below —
   * step 4 on git's raw stdout and `finish` on the outgoing root — deliberately
   * use the real `node:path`, so a misconfigured seam cannot loosen them.
   */
  readonly platformPath: PlatformPathModule;
}

// --------------------------------------------------------------------------
// Fixed policy
// --------------------------------------------------------------------------

/**
 * The bare executable name. Being separator-less, it is resolved by the
 * platform's own executable search — `PATH` on POSIX, but the spawning
 * process's current directory BEFORE `PATH` on Windows. See the header: closing
 * that is a `gitExecutablePath` deployment setting, not a default this phase
 * can pick.
 */
export const DEFAULT_GIT_EXECUTABLE: string = "git";

/**
 * Wall-clock bound on a single `rev-parse` invocation.
 *
 * `rev-parse --show-toplevel` is a local metadata read that normally completes
 * in milliseconds; the bound exists for the pathological case — a path on an
 * unresponsive network mount — where an unbounded invocation would hang the
 * attach request forever with no recovery. Ten seconds is far above any healthy
 * local invocation and far below a user's patience for a wedged one. Exceeding
 * it kills the child, which surfaces as `vcs_error` (killed ⇒ abnormal), never
 * as a `"none"` classification.
 */
export const DEFAULT_GIT_COMMAND_TIMEOUT_MS: number = 10_000;

/**
 * Cap on captured git stdio. A toplevel path is at most a few kilobytes;
 * anything beyond this is a malfunctioning executable, and overflowing the cap
 * fails the invocation (Node rejects with `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`),
 * which lands on `vcs_error` like every other abnormal outcome.
 */
export const GIT_STDIO_MAX_BUFFER_BYTES: number = 1024 * 1024;

/**
 * git's exit code for a fatal error (`die()`), stable across git's history.
 * One half of the positive not-a-repository verdict; see `classifyGitFailure`.
 */
export const GIT_FATAL_EXIT_CODE: number = 128;

/**
 * The other half of that verdict: git's own not-a-repository wording, matched
 * ANCHORED at the start of a stderr line.
 *
 * The anchor is not cosmetic. An unanchored match would also fire on a
 * different fatal error whose quoted PATH happened to contain the phrase (a
 * directory literally named `not a git repository`), turning a failure into a
 * plain-directory classification — an I-009-4 breach reachable by naming a
 * directory. git renders control characters in quoted paths in C-style escaped
 * form, so no path can inject a leading newline to defeat the anchor.
 *
 * Deliberately NOT exported: a test that asserted against this same pattern
 * would be circular. The suite fixes the wording from what real git emits.
 */
const NOT_A_REPOSITORY_STDERR_MARKER = /^fatal: not a git repository/im;

/**
 * `GIT_*` variables deleted from the child environment because each one can
 * redirect git's repository DISCOVERY — the exact question this module asks.
 * Every entry is a correctness measure, not hygiene; see the header.
 *
 * TWO MECHANISMS, one list. The first five redirect discovery DIRECTLY, and
 * they are the demonstrated hazard: with `GIT_DIR` and `GIT_WORK_TREE`
 * exported, this module's own argv — `-C <path> rev-parse --show-toplevel` —
 * answers about the AMBIENT repository rather than the supplied path, the `-C`
 * notwithstanding (git 2.50.1).
 *
 * The last two are the env-borne CONFIG-INJECTION channels, and they are
 * INDEPENDENT of each other. `GIT_CONFIG_COUNT` is the switch that makes
 * `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n` pairs live: stripping the count
 * neuters THAT pair family, since git reads none of those numbered keys
 * without it. It does not neuter injection as a whole — `GIT_CONFIG_PARAMETERS`
 * is a second channel (the mechanism that carries `git -c` into subprocess
 * environments) and is not gated on the count. Both are live on current git: a
 * `user.name` injected through either is honored, and both report git's
 * `command` config scope.
 *
 * Their honest severity is defense in depth, not a closed redirection. On git
 * 2.50.1 the injectable key that bears on discovery, `core.worktree`, does NOT
 * move `--show-toplevel` through either channel — nor through `git -c`, the
 * same command scope — whether the query runs at the repository root or at a
 * subdirectory via `-C`. They are stripped because arbitrary config injection
 * sits on the wrong side of the line drawn below, not because a working
 * discovery redirect is known through them.
 *
 * NOT stripped, deliberately: `GIT_CONFIG_NOSYSTEM`, `GIT_CONFIG_GLOBAL`,
 * `GIT_CONFIG_SYSTEM`. Those REDIRECT or disable config files rather than
 * injecting keys, and an operator who set them pointed git away from ambient
 * configuration on purpose. Deleting them would re-enable the very files the
 * operator excluded — a hermeticity LOSS dressed up as hardening. The line this
 * list draws is therefore between injection (stripped, because it is a channel
 * for arbitrary keys) and operator-level redirection (honored, on the same
 * trust plane as `PATH` and the rest of the inherited environment).
 *
 * Variables that do NOT affect discovery are also left alone
 * (`GIT_OBJECT_DIRECTORY`, `GIT_NAMESPACE`, `GIT_INDEX_FILE`, the `GIT_*_NAME`
 * identity pair, …). `rev-parse --show-toplevel` reads no objects, no index and
 * writes nothing, so stripping them would buy nothing and would make the
 * child's environment differ from the operator's for no stated reason.
 */
const DISCOVERY_REDIRECTING_GIT_ENV_KEYS: readonly string[] = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS",
];

// --------------------------------------------------------------------------
// Default seam implementations
// --------------------------------------------------------------------------

/**
 * The environment every git invocation runs under: the daemon's own
 * environment, minus the discovery-redirecting variables, plus the locale pin
 * and a prompt block.
 *
 * Read at CALL time rather than captured at construction, so a daemon that
 * mutates its own environment is followed rather than snapshotted.
 *
 * `GIT_TERMINAL_PROMPT=0` is defense in depth: `rev-parse` never authenticates,
 * but a git that decided to prompt would block on a terminal the daemon does
 * not have until the timeout above fires.
 */
function buildGitEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const key of DISCOVERY_REDIRECTING_GIT_ENV_KEYS) {
    delete environment[key];
  }
  environment["LC_ALL"] = "C";
  environment["LANG"] = "C";
  environment["GIT_TERMINAL_PROMPT"] = "0";
  return environment;
}

/**
 * Promise wrapper over `node:child_process.execFile`, preserving the REAL
 * rejection object (its `code` / `signal` / `killed` are what the classifier
 * discriminates on) and attaching the separately-delivered stdio so the
 * not-a-repository marker is readable from it.
 */
function defaultExecuteFile(
  file: string,
  args: readonly string[],
  options: GitCommandOptions,
): Promise<GitCommandResult> {
  return new Promise<GitCommandResult>((resolve, reject) => {
    execFile(
      file,
      [...args],
      {
        encoding: "utf8",
        timeout: options.timeout,
        maxBuffer: options.maxBuffer,
        env: options.env,
        windowsHide: options.windowsHide,
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(Object.assign(error, { stdout, stderr }));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

function resolveDeps(partial: Partial<RepoRootResolverDeps>): RepoRootResolverDeps {
  return {
    executeFile: partial.executeFile ?? defaultExecuteFile,
    realpath: partial.realpath ?? realpathFromFilesystem,
    gitExecutablePath: partial.gitExecutablePath ?? DEFAULT_GIT_EXECUTABLE,
    gitCommandTimeoutMs: partial.gitCommandTimeoutMs ?? DEFAULT_GIT_COMMAND_TIMEOUT_MS,
    platformPath: partial.platformPath ?? nodePath,
  };
}

/** `path.win32.sep`. The discriminator for the win32-only completeness rule. */
const WINDOWS_PATH_SEPARATOR = "\\";

/**
 * Does `candidatePath` name ONE COMPLETE LOCATION — something that needs
 * nothing from the daemon's own state to be understood?
 *
 * On POSIX, absoluteness is the whole question. On win32 it is necessary but
 * not sufficient: `path.win32.isAbsolute` accepts ANY leading separator,
 * short-circuiting before it looks for a drive, so `\repos\foo` and
 * `/repos/foo` pass it while naming no volume — and `realpath` would then
 * complete them against the process's CURRENT DRIVE. The parsed root separates
 * the two classes: `\` and `/` have length 1, while every complete win32 root
 * (`C:\`, `C:/`, `\\server\share\`, `\\?\C:\`) is longer. The length test is
 * win32-scoped and must stay so — on POSIX `/` is a complete root of length 1.
 *
 * `C:foo` needs no special case: it is drive-RELATIVE, and `isAbsolute`
 * already reports false for it.
 *
 * T1.6's `joinCandidatePath` (`./trust-envelope.js`) re-spells this same
 * driveless-root rule inline for its absolute `directory` arm, so a change to
 * the predicate here belongs there too; that module's `PlatformPathModule`
 * note enumerates the full set of surfaces the two files share.
 */
function namesCompleteLocation(candidatePath: string, platformPath: PlatformPathModule): boolean {
  if (!platformPath.isAbsolute(candidatePath)) {
    return false;
  }
  if (platformPath.sep !== WINDOWS_PATH_SEPARATOR) {
    return true;
  }
  return platformPath.parse(candidatePath).root.length > 1;
}

// --------------------------------------------------------------------------
// Failure interpretation
// --------------------------------------------------------------------------

/** Reads a property off a value that may not be an object at all. */
function readProperty(thrown: unknown, key: string): unknown {
  if (typeof thrown !== "object" || thrown === null) {
    return undefined;
  }
  return (thrown as Record<string, unknown>)[key];
}

/**
 * Which `RepoRootResolutionError` reason a failed `realpath` maps to.
 *
 *   * `ENOENT` / `ENOTDIR` / `ENAMETOOLONG` — the path as spelled does not name
 *     anything (`ENOTDIR` means a component that must be a directory is not, so
 *     the full path does not exist) ⇒ `path_not_found`.
 *   * anything else — `EACCES`, `EPERM`, `ELOOP`, `EIO`, an unrecognized errno
 *     ⇒ `not_readable`, whose message ("the supplied path is not readable") is
 *     accurate for all of them.
 *
 * `vcs_error` is deliberately unreachable from here: it means the version
 * control query did not complete, and at this point no query has been made.
 */
function classifyRealpathFailure(thrown: unknown): "path_not_found" | "not_readable" {
  const errnoCode = readProperty(thrown, "code");
  if (errnoCode === "ENOENT" || errnoCode === "ENOTDIR" || errnoCode === "ENAMETOOLONG") {
    return "path_not_found";
  }
  return "not_readable";
}

/**
 * THE I-009-4 DECISION POINT. Did git run and report "this is not a
 * repository", or did the query fail to complete?
 *
 * FAIL-CLOSED BY CONSTRUCTION. The two mistakes are not symmetric. Calling a
 * broken git invocation "not a repository" reclassifies a real repository as a
 * plain directory and every downstream capability projection then lies about
 * git-backed modes — the breach I-009-4 exists to prevent, and one that
 * persists into `repo_mounts.vcs_type`. Calling a genuine plain directory a
 * `vcs_error` merely refuses an attach, loudly, with an explicit typed error
 * (`Spec-009 §Fallback Behavior`). So `"not-a-repository"` is returned ONLY on
 * a positive, three-part verdict, and everything else — including any shape
 * this function does not recognize — is `"abnormal"`:
 *
 *   1. the child was NOT killed and did NOT die on a signal (so the exit code
 *      below is git's own verdict rather than a corpse's);
 *   2. it exited with git's fatal code 128 (a spawn failure such as `ENOENT`
 *      puts an errno STRING in the same slot, so it can never satisfy this);
 *   3. its stderr carries git's anchored not-a-repository wording.
 *
 * Consequences worth naming, all of them intended:
 *   * git absent, non-executable, or unreadable ⇒ `ENOENT` / `EACCES` in the
 *     code slot ⇒ abnormal. A host without git cannot silently downgrade a
 *     repository to a plain directory.
 *   * the timeout kill, or any other signal death ⇒ abnormal.
 *   * a bare repository ("this operation must be run in a work tree") and a
 *     `safe.directory` ownership refusal ("detected dubious ownership") both
 *     exit 128 with a DIFFERENT message ⇒ abnormal. Neither is a plain
 *     directory, and neither may be attached as one.
 *   * a `-C` target that is a regular file (git cannot chdir into it) ⇒
 *     abnormal, so a file is never persisted as a canonical root.
 *   * a future git that changed its wording or its exit code ⇒ abnormal, i.e.
 *     plain-directory attach breaks visibly instead of git repositories
 *     silently misclassifying.
 */
function classifyGitFailure(thrown: unknown): "not-a-repository" | "abnormal" {
  if (readProperty(thrown, "killed") === true) {
    return "abnormal";
  }
  const signal = readProperty(thrown, "signal");
  if (typeof signal === "string" && signal.length > 0) {
    return "abnormal";
  }
  if (readProperty(thrown, "code") !== GIT_FATAL_EXIT_CODE) {
    return "abnormal";
  }
  const standardError = readProperty(thrown, "stderr");
  if (typeof standardError !== "string" || !NOT_A_REPOSITORY_STDERR_MARKER.test(standardError)) {
    return "abnormal";
  }
  return "not-a-repository";
}

/**
 * Strips the single line terminator `rev-parse` appends, and nothing else.
 *
 * `.trim()` would be wrong: a directory name may legitimately end in a space,
 * and trimming it would produce a path that does not exist — an
 * unresolvable-but-plausible root, the worst possible failure shape.
 */
function stripSingleLineTerminator(output: string): string {
  return output.replace(/\r?\n$/, "");
}

// --------------------------------------------------------------------------
// RepoRootResolver
// --------------------------------------------------------------------------

/**
 * Turns a user-entered local path into the canonical `{canonicalRoot,
 * vcsType}` pair, or throws `RepoRootResolutionError`.
 *
 * Stateless and safe to share: every call reads the environment afresh and
 * keeps no cache. Caching would be a correctness hazard rather than an
 * optimization — a mount's git-ness changes when someone runs `git init`, and a
 * stale `"none"` is exactly the lie I-009-4 forbids.
 */
export class RepoRootResolver {
  private readonly deps: RepoRootResolverDeps;

  public constructor(deps: Partial<RepoRootResolverDeps> = {}) {
    this.deps = resolveDeps(deps);
  }

  /**
   * Resolve `localPath` to its canonical repository root.
   *
   * The input MUST name one complete location — absolute, on POSIX; on Windows
   * absolute AND naming a volume, since a driveless root like `\repos\foo`
   * would be completed from the daemon's own current drive. Callers hand this
   * method the path the operator typed, and `RepoAttachRequest.localPath` keeps
   * that raw value as provenance (I-009-5) — this return value is what gets
   * persisted.
   *
   * @throws {RepoRootResolutionError} on every non-resolution. There is no
   *   other exit: no fallback to the input, no partial result (I-009-2).
   */
  public async resolveCanonicalRoot(localPath: string): Promise<RepoRootResolution> {
    // Step 1 — refuse any input that does not name one complete location. This
    // runs BEFORE `realpath`, which would otherwise complete a relative path
    // against the daemon's working directory — or, on Windows, a driveless root
    // against its current drive — and hand back a root that looks entirely
    // plausible. See the header: a missing piece supplied out of daemon-side
    // state is the guessed root I-009-2 forbids.
    if (!namesCompleteLocation(localPath, this.deps.platformPath)) {
      throw new RepoRootResolutionError("not_absolute");
    }

    // Step 2 — canonicalize the INPUT. This doubles as the existence and
    // readability gate (`realpath` cannot resolve what it cannot traverse), and
    // it is what keeps the symlink alias away from git in step 3.
    const canonicalInputPath = await this.realpathOrThrow(localPath, classifyRealpathFailure);

    // Step 3 — ask git where the toplevel is. Note that the answer is NOT
    // assumed to be `canonicalInputPath`: attaching from a nested subdirectory
    // is the case `Spec-009 §Implementation Notes` calls out, and it is the
    // reason this query exists at all.
    let toplevelOutput: string;
    try {
      const result = await this.deps.executeFile(
        this.deps.gitExecutablePath,
        ["-C", canonicalInputPath, "rev-parse", "--show-toplevel"],
        {
          timeout: this.deps.gitCommandTimeoutMs,
          maxBuffer: GIT_STDIO_MAX_BUFFER_BYTES,
          env: buildGitEnvironment(),
          windowsHide: true,
        },
      );
      toplevelOutput = result.stdout;
    } catch (thrown: unknown) {
      if (classifyGitFailure(thrown) === "not-a-repository") {
        // `Spec-009 §Fallback Behavior` — the plain-directory classification.
        // The root is the already-canonicalized input: a non-git directory IS
        // its own root, and it has been realpath'd, so this arm returns a
        // canonical value like every other (I-009-1).
        return this.finish(canonicalInputPath, "none");
      }
      throw new RepoRootResolutionError("vcs_error");
    }

    // Step 4 — a zero exit with no usable toplevel is a malfunction, not a
    // plain directory. Refusing here is what keeps an empty string or a
    // relative fragment from ever reaching `canonical_root`.
    //
    // This is git's RAW stdout, so it gets the same completeness rule as the
    // input rather than a bare absoluteness check: a non-native Windows git
    // (MSYS/Cygwin) can report a driveless toplevel, and step 5 would complete
    // it against the current drive — the input-side defect, arriving through
    // the VCS instead. The REAL `node:path` is deliberate here; see `finish`.
    const reportedToplevel = stripSingleLineTerminator(toplevelOutput);
    if (reportedToplevel.length === 0 || !namesCompleteLocation(reportedToplevel, nodePath)) {
      throw new RepoRootResolutionError("vcs_error");
    }

    // Step 5 — canonicalize git's answer too. See the header: git's toplevel is
    // usually already physical, and I-009-1 is not held conditionally on
    // "usually". A failure here is a VCS-query anomaly (git named a root that
    // cannot be resolved), not a bad user path, so it keeps the `vcs_error`
    // reason rather than being re-classified as a missing input path.
    const canonicalRoot = await this.realpathOrThrow(reportedToplevel, () => "vcs_error");
    return this.finish(canonicalRoot, "git");
  }

  /** `realpath` with its rejection mapped to a typed, path-free reason. */
  private async realpathOrThrow(
    path: string,
    classify: (thrown: unknown) => "path_not_found" | "not_readable" | "vcs_error",
  ): Promise<string> {
    try {
      return await this.deps.realpath(path);
    } catch (thrown: unknown) {
      // The attempted path stays in this scope and never enters the carrier —
      // `error-contracts.md §Repo` bars this code from echoing it, and T1.4
      // gives the constructor no channel that could carry one.
      throw new RepoRootResolutionError(classify(thrown));
    }
  }

  /**
   * Last gate before any value escapes this module: the returned root must be
   * absolute (I-009-1). Both call sites have already realpath'd their value, so
   * this can only fire on a platform or seam that broke that guarantee — which
   * is exactly when a silent relative root would be most damaging.
   *
   * Deliberately the REAL `node:path`, not the injected `platformPath` — the
   * rule that step 4 also follows. Both are backstops, and keying a backstop
   * off an injectable seam would let one misconfiguration disable the gate and
   * its backstop together.
   *
   * Where this differs from step 4 is the STRENGTH of the check, and only
   * because of what each one sees. Step 4 reads git's raw stdout, which can
   * still be driveless, so it needs the full completeness rule. Both of THIS
   * method's call sites pass `realpath` output, and a real `realpath` cannot
   * return a driveless root, so the stricter rule would add no reachable
   * coverage here — plain absoluteness is the honest statement of what is left
   * to catch.
   */
  private finish(canonicalRoot: string, vcsType: VcsType): RepoRootResolution {
    if (!nodePath.isAbsolute(canonicalRoot)) {
      throw new RepoRootResolutionError("vcs_error");
    }
    return { canonicalRoot, vcsType };
  }
}
