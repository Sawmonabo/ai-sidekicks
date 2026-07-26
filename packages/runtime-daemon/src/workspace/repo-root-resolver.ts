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
//     re-asserted structurally before it is returned, and a git-reported root
//     is VERIFIED against the supplied path rather than trusted — see the
//     repo-owned-config section below.
//   * I-009-2 — explicit resolution failure. Every path that is not a
//     successful resolution THROWS `RepoRootResolutionError`. There is no
//     partial-success return, no fallback to the user-entered path, and no
//     inferred root — including no root inferred by completing an input that
//     does not name one whole location (a relative path, `~`, or a driveless
//     Windows root) out of daemon-side state, which the step-1 gate refuses.
//   * I-009-4 — honest non-git classification. `vcsType: "none"` is produced
//     ONLY on a positive "git ran and reported not-a-repository" verdict, and
//     ONLY for the DISCOVERY query on the supplied path. Every git-invocation
//     failure — git missing, git non-executable, git killed, git failing for
//     any other reason — routes to `vcs_error`. See the fail-closed note on
//     `classifyGitFailure` below. The same verdict from the VERIFICATION query
//     is a refusal (`root_mismatch`), never a reclassification: a claimed root
//     that is not a repository at all cannot be attached as a plain directory
//     either, because it is not the path the operator supplied.
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
// friends), but the discovery-redirecting `GIT_*` variables are OMITTED from
// it, along with both env-borne config-injection channels that could reach them
// indirectly. A daemon launched from a shell that exported `GIT_DIR` or
// `GIT_WORK_TREE` would otherwise have every attach answered about the ambient
// repository instead of the supplied path — a resolved root with no relation to
// its input, which is precisely the guessed root I-009-1 forbids.
// `GIT_CEILING_DIRECTORIES` is the mirror-image hazard: it bounds upward
// discovery, so an ambient value can make git report not-a-repository for a
// real repository, reclassifying it `vcsType: "none"` in violation of I-009-4.
// The omission is case-insensitive, which is a Windows correctness requirement
// rather than fastidiousness; `buildGitEnvironment` states why.
//
// Locale is pinned to `C` for the same class of reason: the not-a-repository
// verdict is read off git's own stderr, and git translates its messages through
// gettext. An operator running a localized shell must not change how this
// module classifies a plain directory.
//
// What the environment cannot reach: the repository's OWN config
// --------------------------------------------------------------------------
// Scrubbing the environment bounds one channel, and only one. The scope is
// worth stating precisely, because the two config channels behave differently.
// OBSERVED on git 2.50.1, and pinned by the suite: `core.worktree` supplied
// through `GIT_CONFIG_PARAMETERS`, the `GIT_CONFIG_COUNT` family, or `git -c`
// does NOT move `--show-toplevel`. The same key in the REPOSITORY'S OWN config
// file DOES move it.
//
// That asymmetry is an observation, and only the observation is relied on. The
// natural explanation is ordering — command-scope config applied after
// repository setup has already fixed the work tree, the repository's own config
// read during setup — but git documents no such ordering for this key, so the
// explanation is inference and nothing below rests on it. The DOCUMENTED
// precedence in fact points the other way: git-config says the numbered
// environment pairs "will override values in configuration files, but will be
// overridden by any explicit options passed via git -c". Read straight, that
// ranks all three command-scope channels ABOVE the repository's own file and
// would predict the redirect to work through every one of them — including the
// highest-ranked, `git -c`, which is just as inert here. An undocumented
// behavior that a documented rule would predict to be otherwise is not a
// boundary worth building on — which is why the strip is treated as defense in
// depth, and why what actually closes the vector is the verification below. A
// later git that honors the documented precedence here is refused by that
// verification unchanged.
//
// That file is reachable without owning the tree it names. `git init
// --separate-git-dir` leaves a `.git` FILE holding a `gitdir:` pointer, and the
// config it points at can carry `core.worktree`, so a directory prepared that
// way answers `rev-parse --show-toplevel` with whatever path its author chose.
// Both hostile shapes were reproduced:
//
//   * SIBLING — the reported root is an unrelated tree. Attaching would persist
//     a `canonical_root` the operator never named, and T1.6's
//     `TrustEnvelopeValidator` would then admit binds all over it.
//   * ANCESTOR — the reported root is a PARENT of the attached directory,
//     widening the mount and its trust envelope to a tree that merely contains
//     what was attached. `core.worktree=/` is the limit case.
//
// So git's answer is verified rather than trusted, in two legs that both refuse
// with `root_mismatch` (each is stated at its own check, steps 4 and 5 of
// `resolveCanonicalRoot`): the supplied path must sit INSIDE the reported root,
// and the reported root must report ITSELF when discovery starts there. Neither
// leg subsumes the other. Containment passes in the ancestor shape, where the
// input really is inside the widened root; the fixpoint passes when the
// redirect names another genuine repository, which self-reports quite honestly.
//
// The honest cost is one refused shape: a repository whose config points
// `core.worktree` anywhere other than the directory holding its gitfile cannot
// be attached, even where its owner arranged that deliberately — the
// dotfiles-style layout is the familiar example. That is an accepted
// limitation, not an oversight. Nothing distinguishes a deliberate redirect
// from a hostile one at this layer, and I-009-1 makes refusing the safe
// direction; the refusal is an explicit typed error (I-009-2), never a
// `vcsType: "none"` misclassification (I-009-4). Every shape git produces on
// its own is unaffected, each pinned against real git in the suite: a plain
// repository, a nested subdirectory, a linked worktree, a submodule, and a
// `--separate-git-dir` repository whose gitfile sits in its own toplevel all
// self-report.
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
// PTY backends); this module adds a SECOND bare-name EXECUTABLE — spawned twice
// per git resolution, once to discover the root and once to verify it — and the
// same search rule applies to every one of those spawns.
//
// Both primary sources are linked, with confirmation dates, from
// `Plan-009 §References`:
//   * libuv `src/win/process.c` v1.51.0 —
//     https://github.com/libuv/libuv/blob/v1.51.0/src/win/process.c
//     `search_path`, for a name with no directory in it: "The file is really
//     only a name; look in cwd first, then scan path", reached only when
//     `NeedCurrentDirectoryForExePathW(L"")` returns TRUE.
//   * `NeedCurrentDirectoryForExePathW` —
//     https://learn.microsoft.com/en-us/windows/win32/api/processenv/nf-processenv-needcurrentdirectoryforexepathw
//     "The value of the NoDefaultCurrentDirectoryInExePath environment variable
//     determines the value this function returns", and a name CONTAINING a
//     backslash always returns TRUE. libuv passes the empty string, which has
//     no backslash, so that variable is decisive: an operator who sets it
//     closes the cwd-first search for every bare-name spawn in the process.
//     That is an operator-side mitigation, not a substitute for the
//     `gitExecutablePath` seam below, which is the one this module controls.
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
import {
  componentsEqual,
  DEFAULT_DIRECTORY_READABILITY_PROBE,
  isContainedWithin,
  toComparableComponents,
  type DirectoryReadabilityProbe,
} from "./trust-envelope.js";

// --------------------------------------------------------------------------
// Public result shape
// --------------------------------------------------------------------------

/**
 * The resolver's only successful output — and, per the T1.5 acceptance
 * criterion, the only value Phase 2 may persist as `canonical_root` /
 * `vcs_type`.
 *
 * `canonicalRoot` is always absolute and symlink-resolved, and was openable for
 * enumeration at the moment it was resolved. `finish` proves the first and the
 * third — the third only for that moment (see the probe seam). The second holds
 * by CONSTRUCTION rather than by check: both call sites hand `finish` realpath
 * output, so an absolute-but-unresolved alias from a broken realpath seam would
 * pass undetected. `vcsType` composes T1.1's closed two-value union
 * (`@ai-sidekicks/contracts`) rather than a local string: I-009-4 pins that
 * union CLOSED, and re-spelling it here would be the widening seam the
 * invariant forbids.
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
  /**
   * Defaults to `node:fs/promises.realpath`, which Node documents as resolving
   * "using the same semantics as the `fs.realpath.native()` function" and which
   * therefore returns each component's ON-DISK spelling. That is what makes the
   * step-4 containment comparison casing-safe on a case-insensitive filesystem,
   * and it is what I-009-1 means by the persisted root being the physical path.
   *
   * `node:fs`'s CALLBACK `realpath` is a different implementation and is not
   * interchangeable here: Node lists "No case conversion is performed on
   * case-insensitive file systems" as the first documented difference, so a
   * mis-cased attach would come back spelled as the operator typed it and be
   * refused `root_mismatch`. `DEFAULT_REALPATH` below is pinned by both suites.
   *
   * Three documented caveats of the native path, none load-bearing here but each
   * cheaper to record than to rediscover:
   *   * musl-linked Linux needs procfs mounted at `/proc` for it to work at all;
   *     "Glibc does not have this restriction". A concern only if the daemon is
   *     ever packaged into an Alpine-style container.
   *   * macOS and the BSDs fail with `ELOOP` past 32 symlinks in one resolution,
   *     a limit libuv calls "hardcoded and cannot be sidestepped".
   *     `classifyRealpathFailure` already routes `ELOOP` to `not_readable`, so
   *     the shape arrives typed rather than leaking.
   *   * Windows shows "Inconsistent casing when using drive letters", alongside
   *     unresolvable ImDisk-style ramdisks and bypassed `subst` drives. The
   *     casing one is benign HERE precisely because the win32 comparison branch
   *     folds case, so a drive letter arriving either way compares equal.
   *
   * Primary sources, also in `Plan-009 §References`:
   *   * Node `fs` — https://nodejs.org/api/fs.html#fsrealpathnativepath-options-callback
   *   * libuv `uv_fs_realpath` — https://docs.libuv.org/en/v1.x/fs.html
   */
  readonly realpath: PathRealpathResolver;
  /**
   * Defaults to `DEFAULT_DIRECTORY_READABILITY_PROBE`, imported from T1.6 along
   * with the seam's type. ONE binding serves both modules, so the attach-time
   * and bind-time answers cannot drift; that module's declaration carries the
   * primitive choice (`opendir` over `access` and over `readdir`) and says why
   * the declaration sits on its side of the import edge.
   *
   * Read once, by `finish`, against the root about to be RETURNED — see there
   * for what it refuses and why `realpath` does not already cover it.
   *
   * Injectable for the reason `realpath` is: the suite drives roots that do not
   * exist on the host — the win32 shapes, the trailing-space names — so a
   * hard-wired probe would make those verdicts a property of the machine
   * running the test rather than of the code.
   *
   * An ADMISSION check, made once, at resolution time. A root that stops being
   * readable AFTER attach is an availability condition, not a resolution
   * failure; D-009-2 puts it in T2.5's health projection, and nothing here
   * re-probes on that projection's behalf.
   */
  readonly probeDirectoryReadable: DirectoryReadabilityProbe;
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
   * `path.win32` by the suite so the two Windows-only shapes — the
   * driveless-root refusal and the `\r` terminator strip, both of them live on
   * an ADR-019 V1 tier — are exercised on POSIX CI rather than only on a
   * Windows runner.
   *
   * Read by exactly those two: the step-1 input gate and
   * `stripSingleLineTerminator`. Every check that guards an OUTGOING value
   * deliberately uses the real `node:path` instead — the completeness rule on
   * git's raw stdout, the containment and fixpoint comparisons in steps 4 and
   * 5, and `finish` on the root itself — so a misconfigured seam cannot loosen
   * any of them. Both operands of those comparisons are `realpath` output, so
   * on Windows both arrive backslash-separated and in the filesystem's own
   * case, and the separator and case-folding questions cannot bite.
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
 * `GIT_*` variables omitted from the child environment because each one can
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
 * subdirectory via `-C`. That is an observed behavior on one version, and it is
 * NOT what the documented precedence predicts — git-config specifies that the
 * numbered environment pairs "will override values in configuration files". So
 * these are stripped because arbitrary config injection sits on the wrong side
 * of the line drawn below, never because a discovery redirect is known to be
 * closed through them.
 *
 * Read that as a statement about the ENV-BORNE channels only. The same key in
 * the repository's own config file DOES move `--show-toplevel`, on the same git
 * version, and no environment strip can reach it. The header's
 * repo-owned-config section separates what is observed from what is inferred,
 * and carries the two-leg verification that answers all of it.
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
 *
 * Exported for the suite's census only. Unlike the stderr marker above, an
 * assertion against this list is not circular: the suite keeps its own literal
 * roster and pins the two together by set equality, so a key added here and
 * nowhere else fails rather than going silently unasserted.
 */
export const DISCOVERY_REDIRECTING_GIT_ENV_KEYS: readonly string[] = [
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
 * The strip list keyed for case-insensitive lookup. Uppercased rather than
 * assumed uppercase, so an entry added to the list in any spelling still
 * matches.
 */
const DISCOVERY_REDIRECTING_GIT_ENV_KEYS_UPPERCASED = new Set(
  DISCOVERY_REDIRECTING_GIT_ENV_KEYS.map((key) => key.toUpperCase()),
);

/**
 * The environment every git invocation runs under: the daemon's own
 * environment, minus the discovery-redirecting variables, plus the locale pin
 * and a prompt block.
 *
 * Read at CALL time rather than captured at construction, so a daemon that
 * mutates its own environment is followed rather than snapshotted.
 *
 * REBUILT by omission rather than copied-then-deleted, because the strip has to
 * be case-insensitive on Windows. A Windows process environment block is
 * case-insensitive, but `{...process.env}` is a plain JavaScript object that
 * preserves each inherited key's ORIGINAL spelling — so a daemon that inherited
 * `Git_Dir` would carry it past a `delete environment["GIT_DIR"]` and hand it
 * to the child, where git reads it as `GIT_DIR` and the strip has bought
 * nothing. Comparing uppercased keys catches every spelling — `toUpperCase`,
 * never the locale-sensitive variant, which maps `I` to `ı` under a Turkish
 * locale and would stop matching `GIT_DIR` entirely (the same trap
 * `trust-envelope.ts` documents at its own case-folding site). On POSIX this
 * also drops a literally-lowercase `git_dir`, which git ignores anyway — an
 * over-strip of a variable that was doing nothing.
 *
 * `GIT_TERMINAL_PROMPT=0` is defense in depth: `rev-parse` never authenticates,
 * but a git that decided to prompt would block on a terminal the daemon does
 * not have until the timeout above fires.
 */
function buildGitEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (DISCOVERY_REDIRECTING_GIT_ENV_KEYS_UPPERCASED.has(key.toUpperCase())) {
      continue;
    }
    environment[key] = value;
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

/**
 * The realpath used when no seam is injected, exported so a test can assert
 * WHICH implementation it is.
 *
 * That pin has to be structural rather than behavioral. The casing contract
 * documented on the `realpath` dep is only OBSERVABLE on a case-insensitive
 * filesystem, and CI's daemon leg is ubuntu-only, so a behavioral test of it
 * runs on developer machines and skips in CI. Identity against this binding
 * fails everywhere.
 */
export const DEFAULT_REALPATH: PathRealpathResolver = realpathFromFilesystem;

function resolveDeps(partial: Partial<RepoRootResolverDeps>): RepoRootResolverDeps {
  return {
    executeFile: partial.executeFile ?? defaultExecuteFile,
    realpath: partial.realpath ?? DEFAULT_REALPATH,
    probeDirectoryReadable: partial.probeDirectoryReadable ?? DEFAULT_DIRECTORY_READABILITY_PROBE,
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
 * note enumerates the six surfaces the two files duplicate: five held by that
 * note alone, this rule among them, and `DEFAULT_REALPATH` held by an identity
 * pin in both suites. Exactly one of the five diverges deliberately —
 * `resolveDeps`, because this module additionally defaults three
 * git-execution seams T1.6 has no use for. Its member set is otherwise a
 * strict subset of this one's, and every member the two share defaults to the
 * same thing. `probeDirectoryReadable` is the strongest case: its type and its
 * default are DECLARED in T1.6 and imported here, so the readability question
 * attach asks and the one bind asks cannot diverge at all. The
 * component-comparison helpers arrive the same way — shared by construction,
 * which is the relationship to prefer wherever the import direction allows.
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
 * Which `RepoRootResolutionError` reason a filesystem errno maps to.
 *
 * TWO callers produce one: step 2's `realpath` on the supplied input, and
 * `finish`'s readability probe on the outgoing root. The name predates the
 * second caller and is kept because the reading did not change — both hand it
 * a Node `ErrnoException` off a path operation, and an errno is all either has.
 *
 *   * `ENOENT` / `ENOTDIR` / `ENAMETOOLONG` — the path as spelled does not name
 *     anything (`ENOTDIR` means a component that must be a directory is not, so
 *     the full path does not exist) ⇒ `path_not_found`.
 *   * anything else — `EACCES`, `EPERM`, `ELOOP`, `EIO`, an unrecognized errno
 *     ⇒ `not_readable`, whose message ("the supplied path is not readable") is
 *     accurate for all of them.
 *
 * `vcs_error` is deliberately unreachable from here, and the reason survives
 * the second caller: a filesystem errno is never evidence about the version
 * control query. Called from step 2, no query has been made yet. Called from
 * `finish` on the git arm, one has been made and it SUCCEEDED — what failed
 * afterwards is the filesystem answering for a path, which is precisely what
 * the two reasons above are for.
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
 *
 * The same argument decides the `\r`, and it decides it DIFFERENTLY per
 * platform. git terminates plumbing output with a bare LF everywhere, so a `\r`
 * sitting before the final `\n` is not terminator noise git produced — it is
 * the last character of the directory's name. On POSIX that is a legal
 * character in a filename, so eating it invents a different path: at best
 * unresolvable, at worst an existing SIBLING, which is the wrong-tree class the
 * root verification below exists to prevent. On win32 the reverse holds — NTFS
 * forbids control characters in names, so a pre-`\n` `\r` cannot be part of one
 * and can only be terminator noise from a shim or a console layer, making it
 * safe to strip.
 *
 * Platform comes from the INJECTED seam, like the step-1 gate's, so POSIX CI
 * can drive the win32 branch. A seam pointed at the wrong platform mutilates or
 * preserves one trailing character; both directions land on a path that either
 * fails to resolve or fails the containment check below.
 */
function stripSingleLineTerminator(output: string, platformPath: PlatformPathModule): string {
  const withoutLineFeed = output.endsWith("\n") ? output.slice(0, -1) : output;
  if (platformPath.sep !== WINDOWS_PATH_SEPARATOR || !withoutLineFeed.endsWith("\r")) {
    return withoutLineFeed;
  }
  return withoutLineFeed.slice(0, -1);
}

// --------------------------------------------------------------------------
// RepoRootResolver
// --------------------------------------------------------------------------

/**
 * What one `rev-parse --show-toplevel` query produced.
 *
 * Only two outcomes are RETURNED: a canonicalized toplevel, or git's positive
 * not-a-repository verdict. Every other outcome — a git that could not run, a
 * zero exit carrying no usable path, a toplevel `realpath` will not resolve —
 * throws `vcs_error` from inside the query, so no caller has to re-derive the
 * I-009-4 discrimination. What the two callers do differ on is the
 * not-a-repository verdict: for the discovery query it is the plain-directory
 * classification, and for the verification query it is a refusal.
 */
type ToplevelQueryOutcome =
  | { readonly kind: "toplevel"; readonly canonicalRoot: string }
  | { readonly kind: "not-a-repository" };

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
   * A `vcsType: "git"` root is not simply what git reported: it has been proven
   * to contain the supplied path and to report itself as its own toplevel. The
   * header explains what that refuses and why it must.
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
    // TRAVERSABILITY gate (`realpath` cannot resolve what it cannot traverse),
    // and it is what keeps the symlink alias away from git in step 3.
    // Traversable is strictly weaker than readable: a `0111` directory resolves
    // here and lists for nobody. Proving the root can actually be ENUMERATED is
    // `finish`'s gate, on the value about to be returned rather than on this
    // one — which on the git arm is a different path.
    const canonicalInputPath = await this.realpathOrThrow(localPath, classifyRealpathFailure);

    // Step 3 — ask git where the toplevel is. Note that the answer is NOT
    // assumed to be `canonicalInputPath`: attaching from a nested subdirectory
    // is the case `Spec-009 §Implementation Notes` calls out, and it is the
    // reason this query exists at all.
    const discovery = await this.queryCanonicalToplevel(canonicalInputPath);
    if (discovery.kind === "not-a-repository") {
      // `Spec-009 §Fallback Behavior` — the plain-directory classification.
      // The root is the already-canonicalized input: a non-git directory IS
      // its own root, and it has been realpath'd, so this arm returns a
      // canonical value like every other (I-009-1).
      return this.finish(canonicalInputPath, "none");
    }
    const canonicalRoot = discovery.canonicalRoot;
    // Both comparisons below fold off the REAL `node:path`, never the injected
    // `platformPath` — the rule step 3 and `finish` follow. A backstop keyed off
    // an injectable seam can be disabled by the same misconfiguration it exists
    // to catch.
    //
    // Neither the separator nor the CASE question can bite, and the reason is
    // the realpath seam rather than the path module: both operands come from
    // `this.deps.realpath`, whose default returns each component's on-disk
    // spelling, so an attach typed `/Repo/sub` on case-insensitive APFS reaches
    // this comparison already spelled the way git spells it.
    //
    // Folding here would be strictly worse than not folding, in two ways. On
    // a genuinely case-sensitive filesystem, where `/REPO` and `/repo` are
    // different directories, it would let a redirected toplevel pass this
    // verification against a case-colliding sibling — re-admitting a variant
    // of the attack `root_mismatch` exists to refuse. And on every filesystem
    // it would MASK a seam that stopped honoring the on-disk-spelling
    // contract — the two spellings would keep comparing equal after the
    // normalization they depend on had gone away.
    const canonicalRootComponents = toComparableComponents(canonicalRoot, nodePath);

    // Step 4 — CONTAINMENT. The attached path must sit inside the root about to
    // be persisted for it. See the header on the repo-owned-config vector: a
    // repository whose own config carries `core.worktree` makes git report a
    // toplevel with no relation to the supplied path, and the operator would
    // get a mount rooted at a tree they never named.
    //
    // Cheap, and FIRST — a root that fails this never becomes the `-C` argument
    // of the verification spawn below, so an attacker-named directory is not
    // handed back to git.
    if (
      !isContainedWithin(
        toComparableComponents(canonicalInputPath, nodePath),
        canonicalRootComponents,
      )
    ) {
      throw new RepoRootResolutionError("root_mismatch");
    }

    // Step 5 — FIXPOINT. Containment alone is not enough: the same mechanism
    // can widen the root to an ANCESTOR of the input, which contains it
    // trivially. A bindable root reports ITSELF when discovery starts inside
    // it, so the root is queried a second time and must answer with itself.
    //
    // The not-a-repository verdict is a refusal here, never a `"none"`
    // classification — a claimed root that is not a repository at all is the
    // strongest form of the mismatch, and it is what both observed redirect
    // shapes actually produce (git 2.50.1).
    const verification = await this.queryCanonicalToplevel(canonicalRoot);
    if (
      verification.kind === "not-a-repository" ||
      !componentsEqual(
        toComparableComponents(verification.canonicalRoot, nodePath),
        canonicalRootComponents,
      )
    ) {
      throw new RepoRootResolutionError("root_mismatch");
    }

    return this.finish(canonicalRoot, "git");
  }

  /**
   * One `rev-parse --show-toplevel` query, from spawn to canonical root.
   *
   * Both call sites run the IDENTICAL invocation — same argv shape, same
   * stripped and locale-pinned child environment, same bound and buffer cap —
   * against different directories. Sharing one method is what makes that
   * identity structural: a verification query built separately could drift into
   * a weaker environment than the discovery query it is checking.
   *
   * @throws {RepoRootResolutionError} `vcs_error` for every outcome that is
   *   neither a usable toplevel nor the positive not-a-repository verdict:
   *   git unable to run, killed, or failing for another reason; a zero exit
   *   whose stdout carries no complete location (an empty string, or the
   *   driveless toplevel a non-native Windows git can report, which the next
   *   `realpath` would otherwise complete against the current drive); and a
   *   toplevel `realpath` declines to resolve. The completeness rule and the
   *   final absoluteness gate deliberately read the REAL `node:path`; see
   *   `finish`.
   */
  private async queryCanonicalToplevel(directory: string): Promise<ToplevelQueryOutcome> {
    let toplevelOutput: string;
    try {
      const result = await this.deps.executeFile(
        this.deps.gitExecutablePath,
        ["-C", directory, "rev-parse", "--show-toplevel"],
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
        return { kind: "not-a-repository" };
      }
      throw new RepoRootResolutionError("vcs_error");
    }

    const reportedToplevel = stripSingleLineTerminator(toplevelOutput, this.deps.platformPath);
    if (reportedToplevel.length === 0 || !namesCompleteLocation(reportedToplevel, nodePath)) {
      throw new RepoRootResolutionError("vcs_error");
    }

    // Canonicalize git's answer too. See the header: git's toplevel is usually
    // already physical, and I-009-1 is not held conditionally on "usually". A
    // failure here is a VCS-query anomaly (git named a root that cannot be
    // resolved), not a bad user path, so it keeps the `vcs_error` reason rather
    // than being re-classified as a missing input path.
    return {
      kind: "toplevel",
      canonicalRoot: await this.realpathOrThrow(reportedToplevel, () => "vcs_error"),
    };
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
   * Last gate before any value escapes this module. Two properties are proven
   * of the outgoing root, in this order.
   *
   * ABSOLUTE (I-009-1). Both call sites have already realpath'd their value, so
   * this can only fire on a platform or seam that broke that guarantee — which
   * is exactly when a silent relative root would be most damaging.
   *
   * Deliberately the REAL `node:path`, not the injected `platformPath` — the
   * rule every outgoing-value check follows, step 3's completeness rule and
   * the step 4/5 root comparisons included. They are all backstops, and keying
   * a backstop off an injectable seam would let one misconfiguration disable
   * the gate and its backstop together.
   *
   * Where this differs from step 3 is the STRENGTH of the check, and only
   * because of what each one sees. Step 3 reads git's raw stdout, which can
   * still be driveless, so it needs the full completeness rule. Both of THIS
   * method's call sites pass `realpath` output, and a real `realpath` cannot
   * return a driveless root, so the stricter rule would add no reachable
   * coverage here — plain absoluteness is the honest statement of what is left
   * to catch.
   *
   * READABLE — the root can be OPENED FOR ENUMERATION, not merely traversed
   * through. Step 2's `realpath` does not already establish this, and the gap
   * is an ordinary POSIX mode rather than a contrived one: `0111` grants search
   * without read. `realpath` needs only search on each component, so it
   * resolves such a directory happily; git needs only search on the root as
   * well, because discovery stats and reads `.git` entries and never LISTS the
   * toplevel, so `rev-parse --show-toplevel` answers normally (git 2.50.1, both
   * observations pinned by the suite). Absent this probe, both arms return a
   * successful resolution naming a directory whose contents the daemon cannot
   * enumerate.
   *
   * The check sits HERE, at the one chokepoint, rather than on the plain-
   * directory arm alone, and that placement is the substance of it. D-009-7 has
   * attach create a default workspace rooted at this value for git and non-git
   * mounts alike, so an unreadable root births the same unusable workspace
   * either way — a mount the operator can neither browse nor run in, recorded
   * as healthy. `Plan-009` T1.5 states the contract being kept: the plain-
   * directory classification is for a directory that exists and is READABLE,
   * and an unreadable path throws rather than resolving.
   *
   * What is probed is the OUTGOING root, which on the git arm need not be the
   * supplied path. Attaching a readable subdirectory of an unreadable
   * repository root is exactly the shape that must refuse, since the root — not
   * the input — is what gets persisted and mounted.
   *
   * Rejections route through `classifyRealpathFailure`, whose errno reading is
   * the same at both call sites: `EACCES` ⇒ `not_readable`, and a root that
   * VANISHED between discovery and this line ⇒ `path_not_found`. ADMISSION
   * only — `probeDirectoryReadable` explains why later readability drift is
   * T2.5's health projection rather than a resolution failure.
   */
  private async finish(canonicalRoot: string, vcsType: VcsType): Promise<RepoRootResolution> {
    if (!nodePath.isAbsolute(canonicalRoot)) {
      throw new RepoRootResolutionError("vcs_error");
    }
    try {
      await this.deps.probeDirectoryReadable(canonicalRoot);
    } catch (thrown: unknown) {
      // Path-free like every other refusal here, for the reason
      // `realpathOrThrow` states: `error-contracts.md §Repo` bars this module
      // from echoing the path, and T1.4's carrier has no channel for one.
      throw new RepoRootResolutionError(classifyRealpathFailure(thrown));
    }
    return { canonicalRoot, vcsType };
  }
}
