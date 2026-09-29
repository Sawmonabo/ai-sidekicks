// Turn-snapshot service coverage: the CAPTURE leg and the window-based RETENTION
// prune (`sweepPrunableRuns` + `pruneSnapshotsForRun`).
//
// REAL GIT, NO MOCKS. Every case drives `../turn-snapshot-service.ts` over a git
// repository in a temporary directory, and the service's `git` seam is left at
// its production default (`runTurnSnapshotGitWithExecFile`) except where a case
// deliberately WRAPS it — never replaces it. That is the whole evidential basis
// here: the capture recipe is a claim about what git does with a particular
// argv, environment and stdin, and a fake would only ever confirm the model this
// suite exists to check.
//
// The wrapping cases each wrap for a reason the recipe itself names:
//
//   * the `HEAD`-advance case has to move the branch BETWEEN two legs of a real
//     capture, which nothing outside the invocation sequence can do;
//   * the induced-failure cases have to make one real leg fail without
//     corrupting the fixture;
//   * the hook-neutralization and validation cases have to read the
//     argv the service assembled — or prove it assembled none;
//   * the exit-0-stderr case has to read the stdio of an invocation the service
//     treated as a success.
//
// The FILESYSTEM seam is replaced rather than wrapped in exactly two cases, both
// about the scratch-index cleanup: an unremovable file is not a state a real
// temporary directory can be talked into on every platform, and the property
// under test is what the `finally` does with the rejection, not what produced
// it.
//
// Coverage map (the cites are the contract, not just the ACs):
//
//   * the execution epoch is the CALLER's value (`0` before any rollback,
//     advanced with each accepted `run.rolled_back`), placed in the ref
//     verbatim and never derived here.
//   * the RETENTION prune, driven over a REAL migrated SQLite database rather
//     than a stubbed row source, because the claim is about a predicate over
//     `run_execution_contexts` and a fake table would assert it against the
//     fake: terminal-but-inside-the-window refs survive (the case that makes
//     "prunes at terminal" fail), an elapsed window prunes while a still-open
//     run — `released_at IS NULL` — survives beside it, and the window boundary
//     is driven to the exact millisecond in both directions.
//
//   * SPARSE-AWARE STAGING. Detection is the `core.sparseCheckout` bit ALONE,
//     driven through all four quadrants of the bit×rules-file matrix: the
//     ordinary sparse root, the bit-set-rules-vanished root that must reach the
//     sparse arm and fail closed, the stale-rules-file-with-the-bit-false root
//     that must run the non-sparse pipeline byte-identically, and the plain
//     non-sparse root. Partition is git's own `sparse-checkout check-rules -z`
//     oracle in its live-rules form, asserted through the fixture where a
//     gitignore-based reimplementation gives the WRONG answer (`/*` plus a nested
//     negation) rather than only where the two agree. Seeding is a copy of the
//     LIVE index taken under git's own `<index>.lock`, driven for lock contention
//     in a main checkout AND in a linked worktree (whose index lives under
//     `.git/worktrees/<id>/`), and for the `provisioned-worktree` sparse
//     INHERITANCE that makes the second fixture reachable at all.
//
//     The `Sparse-Boundary-Paths:` trailer is driven as a FORMAT MARKER — written
//     unconditionally in a sparse root, empty set spelled `[]`, absent in a
//     non-sparse one — and as TYPE-PRESERVING: a path git listed with a trailing
//     slash is recorded WITH it. The `commit-tree` transport from `-m` argv to
//     `-F -` stream is pinned by ARGV (no `-m`, no message bytes on the command
//     line), by OID (a non-sparse capture is byte-identical to the pre-closure
//     pipeline, skipped-trailer case included) and by SIZE — a boundary set
//     serializing past 32767 characters, the bound Windows `CreateProcess` puts on
//     a command line, round-trips through the stream.
//
//     The partition is driven in BOTH directions, and the in-cone one needed its
//     own arm. Porcelain equivalence over a CLEAN worktree cannot fail on the
//     in-cone half: the scratch index is seeded from the live index in a sparse
//     root, so a listing that staged nothing still writes the right tree, and the
//     boundary set subtracts every tracked path back out of the trailer. Measured
//     by mutation — an oracle stubbed to "nothing is in cone" left every clean
//     arm green. The arm holding UNCOMMITTED in-cone content at capture time is
//     what closes that, with an out-of-cone write beside it so a partition that
//     staged everything fails too. A second measurement, kept for whoever mutates
//     this next: DROPPING `-z` from the oracle argv is a weak mutant, not a clean
//     kill. Without it git reads the NUL-joined candidates as ONE line and echoes
//     it with a trailing newline, so every key but the last still matches and
//     only an arm sensitive to the final entry notices.
//
//     BYTE DISCIPLINE ON THE CAPTURE LEG is driven by TWO arms, which between
//     them cover what an earlier revision of this note could only claim by
//     construction. The property: on that leg — and only that leg — `check-rules`
//     candidates go out and come back as raw listing SLICES keyed bijectively
//     through `latin1`, and the boundary SUBTRACTION is keyed the same way against
//     the tree listing's own slices, so no path is reconstructed from a decode
//     before the trailer is built.
//
//       - The REAL-PIPELINE arm writes a multibyte UTF-8 out-of-cone name under a
//         forced `core.quotepath=true` and follows it end to end: `-z` listings
//         defeat the quoting and the trailer records the name verbatim. Every
//         byte is a real byte off a real disk.
//       - The SUBTRACTION arm drives the one case APFS cannot host. The measuring
//         host rejects a non-UTF-8 filename at `creat(2)` (`EILSEQ`), so both
//         listings are SYNTHESIZED through the git seam — a `cone-out/<0xFF>`
//         candidate appended to the capture's `ls-files -co`, and a DISTINCT
//         `cone-out/<0xFE>` appended to the boundary derivation's `ls-tree`. The
//         two decode to the SAME U+FFFD-bearing string and share no bytes, so a
//         `utf8`-keyed subtraction drops the boundary path and a byte-keyed one
//         keeps it. That arm asserts the TRAILER and the staged tree.
//
//
// Verifies invariant:
//
//   * Sparse-faithful capture. A sparse execution root's capture is EQUIVALENT TO
//     PORCELAIN, asserted against `git add -A` under the same config (never
//     against a hand-written expectation) across a matrix of cone, non-cone
//     positive-pattern, top-level-negation and nested-negation definitions, in
//     both a clean and a materialized worktree state. Fail-closed is driven by
//     injecting the below-2.41 unknown-subcommand failure through the git seam
//     (never by requiring an old binary).
//   * Asserted as ground truth (`for-each-ref refs/heads/` byte-identical
//     across the capture, `branch --contains <snapshot>` empty, `HEAD`
//     unmoved), at the namespace boundary (a `runId` that would escape is
//     refused before any git call) and on the environment channel the ref-path
//     guard cannot reach (a capture run under an ambient `GIT_DIR` +
//     `GIT_OBJECT_DIRECTORY` still lands in the EXECUTION ROOT's own store,
//     with the decoy repository empty).
//
//     The ref-component predicate is driven through BOTH halves of its rule and
//     against over-narrowing. The refusal rows include the four DOT shapes an
//     alphabet-only pattern admitted: `run..1` and `run.lock`, which git refuses
//     too but only at `update-ref` — several spawns into a capture whose failures
//     are swallowed into a diagnostic, so the BOUNDARY is what is under test
//     rather than the outcome — and `run.` and `run.LOCK`, which git ACCEPTS
//     (measured on git 2.50.1; both refs are created) and which are refused as
//     this module's own filesystem-aliasing narrowing. The control is a case that
//     CAPTURES successfully under `a.lock.b`, `run.l`, `run-1_2.3` and a real
//     UUIDv7, so a predicate that refused `.lock` as a substring — or every dot —
//     fails there rather than passing the refusal rows. The retention primitive
//     drives one shape from each half, because that path reaches the predicate
//     through a DATABASE row rather than a caller's argument.
//
//     The SYMBOLIC-REF channel is driven on both sides, because a validated name
//     that resolves elsewhere is what no name-based guard can catch: a dangling
//     in-namespace symref squatting the next capture path never mints the branch
//     it points at — git 2.50.1 writes at the validated name, git 2.54.0 refuses
//     the flagged create and the capture is the typed `failed`, and the case
//     accepts either, since the invariant is what both preserve — and on the
//     delete side a symref planted in the namespace is deleted itself rather than
//     its referent. Each is asserted against `refs/heads/` byte-identical, and
//     each fails if `--no-deref` is dropped from its invocation.
//
//     The RETENTION leg carries the invariant on channels the capture leg's cases
//     cannot reach: pruning one run leaves `refs/heads/` and a PREFIX-SIBLING
//     run's refs byte-identical; a `run_execution_contexts` row whose `run_id`
//     would escape the namespace is refused before any git call, from the sweep
//     as well as from the primitive; and a fabricated `for-each-ref` listing
//     naming `refs/heads/main` is DROPPED rather than deleted.
//   * The discriminating case mutates the worktree between two captures of the
//     same `(runId, epoch, turnOrdinal)` and asserts the ref did not move, which
//     is what "never repoints an existing ref at later file state" means; the
//     epoch case then asserts the superseded epoch's ref SURVIVES beside the
//     fresh one.
//   * The discriminating case mutates the worktree between two captures of the
//     same `(runId, epoch, turnOrdinal)` and asserts the ref did not move, which
//     is what "never repoints an existing ref at later file state" means; the
//     epoch case then asserts the superseded epoch's ref SURVIVES beside the
//     fresh one.
//
// The FLAGGED forms act on the validated name and leave `refs/heads/` alone on
// every git measured, and that is the half each case asserts; what the flagged
// CREATE then REPORTS is version-dependent, and the case accepts either answer —
// entry above for the split, rather than a second copy of it here.
//
// Each host-config pin carries a NEGATIVE CONTROL in the same case: the fixture
// re-runs the equivalent leg WITHOUT the pin and the assertion is that the
// result differs. A stability assertion whose pin was already inert would
// otherwise pass for the wrong reason. `core.safecrlf`'s control differs in KIND
// rather than in degree — unpinned, the equivalent staging leg does not produce
// a different tree, it exits fatal. `core.fileMode` is NOT a pin, and its two
// capture cases are built the opposite way round: they carry a PORCELAIN
// control rather than an unpinned one. The service honors that knob as
// probe-written capability config, so the claim to hold is `git add -A`
// equivalence under whatever the host says — which means the reference each
// case compares against is porcelain under the SAME config, not the same leg
// minus a pin. The pair is the point: one case takes a turn-CREATED executable
// (bit lost, and porcelain loses it identically — the recorded residual), the
// other a file executable IN THE BASE COMMIT (recorded `100755` kept, and
// porcelain keeps it identically). A `-c core.fileMode=true` pin passes the
// first and FAILS the second, destroying a recorded exec bit the turn never
// touched.
//
// `core.sparseCheckout` is the one knob the service READS AS INPUT rather than
// pinning, honoring or tolerating, and its cases assert that a sparse root's
// out-of-cone content is RETAINED in the snapshot tree, at porcelain
// equivalence.

import { execFile } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import type { Database as DatabaseType } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ExecutionMode } from "@ai-sidekicks/contracts";

import { openDatabase } from "../../session/migration-runner.js";
import {
  SNAPSHOT_NEUTRALIZED_GIT_ENV_KEYS,
  TurnSnapshotService,
  runTurnSnapshotGitWithExecFile,
  type TurnSnapshotCaptureResult,
  type TurnSnapshotCaptureStep,
  type TurnSnapshotCaptured,
  type TurnSnapshotDiagnostic,
  type TurnSnapshotFilesystem,
  type TurnSnapshotGitRunner,
  type TurnSnapshotRetentionPruneResult,
  type TurnSnapshotRetentionSweepResult,
} from "../turn-snapshot-service.js";

// ----------------------------------------------------------------------------
// Constants
// ----------------------------------------------------------------------------

// Run ids are event-sourced UUIDs; the ref-component validator admits this shape
// and the ref assertions below spell the resulting path LITERALLY rather than
// deriving it from the service, so a builder that changed would be caught.
const RUN_ID = "0192b3c0-1111-7c4a-9b1c-1b7c5b3e8f00";

// The turn-boundary instant the service stamps as author/committer date. FIXED,
// because it is an OID input: the host-independence cases assert two captures
// hash identically, which is only a statement about config if the clock is held.
const FIXED_INSTANT = "2026-01-01T00:00:00.000Z";

const FIXTURE_GIT_TIMEOUT_MS = 30_000;

/**
 * The base repository's project-declared ignore rules, committed by `beforeEach`.
 *
 * Named rather than repeated because the collision cases EXTEND it — a rule that
 * makes their colliding path disposable, appended to the fixture's own — and a
 * case that restated the base rules instead would silently drop one if this
 * fixture ever grew a fourth.
 */
const FIXTURE_IGNORE_RULES = "ignored-dir/\nignored-file.txt\ntracked-but-ignored.txt\n";

/**
 * The per-case budget this file installs for every case, and the floor the four
 * multi-sequence cases below raise for themselves.
 *
 * Sized to the MACHINE rather than to the work, which is the whole difference
 * between it and {@link MULTI_SEQUENCE_CASE_TIMEOUT_MS}. No case in this file is
 * free of git: the top-level `beforeEach` spawns four subprocesses to build the
 * fixture repository before every one of them, which is the floor the fastest
 * case here sits on at 145ms. The identical-state OID case spawns 27 — that
 * `beforeEach` repository, two embedded repositories, two ten-spawn capture
 * pipelines and one assertion read — so its wall-clock cost is set by how
 * contended the host is, not by anything the case counts.
 *
 * Measured on this file, one case at a time: 536ms alone, 984ms under this
 * package's own 79-file parallel run (1.8x), and 1830ms under ordinary CPU
 * contention (3.4x). Those multipliers COMPOSE, and a full-workspace `pnpm test`
 * adds six more packages and the build graph on top of both — which is how a
 * 536ms case reaches Vitest's 5s default. It did, exactly once, while passing
 * 195/195 in isolation. Nothing about that case made it the one: it ranked 72nd
 * of 195 by duration, and 104 of its siblings sit in the same 400-700ms band. At
 * the 5s default the whole file is inside the window, so the case that fails is
 * a lottery ticket rather than a signal, and a budget on the ticket that lost
 * would leave 194 in the drum.
 *
 * Deliberately LARGER than {@link FIXTURE_GIT_TIMEOUT_MS}, for the reason the
 * multi-sequence budget below states in full: a hung FIXTURE spawn hits its own
 * 30s limit first, so the case fails naming the leg rather than reporting a bare
 * "Test timed out".
 *
 * Installed file-scoped rather than in `vitest.config.ts`, and that boundary is
 * the point: the package's other 78 test files are not measured here, and
 * re-budgeting them on this file's evidence would buy silence rather than
 * confidence. A `describe` option reads more naturally and was measured instead:
 * it pushes the longest of the `describe` headers past the 100-column print
 * width, and Prettier then splits the call and re-indents that block's whole
 * body — churn that buries the change and takes `git blame` with it.
 * Vitest resolves the narrower declaration first under either spelling, so a case
 * carrying its own `timeout` still gets it — verified against both forms this
 * file uses, the options object and the positional third argument.
 */
const ORDINARY_CASE_TIMEOUT_MS = 45_000;

vi.setConfig({ testTimeout: ORDINARY_CASE_TIMEOUT_MS });

/**
 * The per-case budget the four MULTI-SEQUENCE cases in this file raise for
 * themselves, above the {@link ORDINARY_CASE_TIMEOUT_MS} floor.
 *
 * Every other case here spawns one capture and lands around a second; four do
 * not, and their cost is set by a COUNT rather than by a fixed handful of
 * spawns — the host-independence case runs four whole capture pipelines plus a porcelain
 * negative control per pin, the cone/non-cone/negation case drives a capture and
 * a porcelain comparison for every sparse definition it walks, the 32-KiB
 * boundary-stream case carries 220 out-of-cone paths end to end, and the
 * linked-worktree lock case builds a second checkout with `worktree add` on top
 * of a sparse fixture before it begins. Measured across four full runs of this
 * file, cases of this kind peaked above Vitest's 5s default (the package config
 * sets none), and one really did time out once on a loaded machine.
 * That is a machine-speed flake, not a regression, and the honest fix is a budget
 * sized to the work rather than a suite that fails when something else is
 * compiling.
 *
 * Deliberately LARGER than {@link FIXTURE_GIT_TIMEOUT_MS}, not equal to it, and
 * that buys exactly one thing: a hung FIXTURE spawn — `spawnFixtureGit` — hits
 * its own 30s limit first, so the case fails
 * naming the leg rather than reporting a bare "Test timed out". It does NOT
 * cover the SERVICE's spawns, which are most of the work in every governed case:
 * {@link buildService} sets no `gitCommandTimeoutMs`, so the service under test
 * runs at its 120s production default, double this budget. A hang inside the
 * service therefore surfaces as a case timeout, by design — threading the
 * fixture's 30s into the constructor would make the sentence above true of every
 * spawn, at the cost of the posture that makes this suite worth anything: the
 * service runs at PRODUCTION seams unless a case deliberately overrides one.
 */
const MULTI_SEQUENCE_CASE_TIMEOUT_MS = 60_000;

/**
 * This suite's INDEPENDENT spelling of the environment variables the service
 * strips, pinned to the service's exported list by set equality below.
 *
 * Eight of these eleven mirror `../workspace/repo-root-resolver.ts`'s discovery
 * redirectors, which the service's list imports rather than re-spells; the other
 * three — `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_NAMESPACE`, `GIT_INDEX_FILE` —
 * are the service's own literals. The imported eight are repeated here
 * deliberately, because the claim under test is about the whole set THIS module
 * strips, not about how it was assembled. A key the resolver adds therefore
 * surfaces here as a census failure rather than as silently widened behavior
 * nothing asserts.
 *
 * `GIT_OBJECT_DIRECTORY` moved INTO that imported set (it bends discovery for
 * every consumer, not only this module's object writes) and out of the service's
 * own literals. The roster is unchanged by that move and deliberately so: this
 * list asserts WHAT is stripped, never where the entry was assembled, so a
 * key crossing the seam must leave the census exactly as it found it.
 */
const EXPECTED_NEUTRALIZED_GIT_ENV_KEYS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS",
  "GIT_NAMESPACE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_INDEX_FILE",
];

// ----------------------------------------------------------------------------
// Real git, fixture side
// ----------------------------------------------------------------------------

interface FixtureGitResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface FixtureGitOptions {
  readonly cwd?: string;
  readonly environmentOverrides?: Readonly<Record<string, string>>;
  /**
   * Written to the child's stdin, which is then closed.
   *
   * One fixture needs it: `update-index --index-info` is the only way to write
   * the three STAGES of an unmerged path, and no `--cacheinfo` spelling reaches
   * a non-zero stage. Added to the fixture rather than worked around because the
   * alternative — provoking a real merge conflict and then narrowing the cone
   * around it — makes the fixture's own construction the fragile part.
   */
  readonly stdin?: string;
}

/**
 * Build the environment fixture git runs under.
 *
 * Hermetic by construction, following the Phase-2 acceptance suite: system and
 * global configuration are switched off, `HOME` and `XDG_CONFIG_HOME` point
 * inside the fixture, and every discovery redirector inherited from the ambient
 * environment is stripped — these fixtures are built while the process working
 * directory is the repository under development, and a `GIT_DIR` leaking in from
 * the harness would point fixture commands at THAT repository.
 *
 * Hermeticity matters twice over here. The porcelain `git add -A` legs are the
 * REFERENCE the capture pipeline is compared against, so a developer's global
 * `core.excludesFile` or `core.autocrlf` would move the reference rather than the
 * subject; and the negative controls set those very values REPO-LOCALLY, which
 * is only a controlled variable if nothing else supplies them.
 *
 * The SERVICE, by contrast, runs under the production environment builder — the
 * ambient `process.env` minus its own strip list. That asymmetry is deliberate:
 * the service's immunity to host config is a claim about its `-c` pins, and
 * handing it a hermetic environment would assert that claim against an
 * environment no daemon ever has.
 */
function buildFixtureEnvironment(fixtureRoot: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_CEILING_DIRECTORIES",
    "GIT_DISCOVERY_ACROSS_FILESYSTEM",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_PARAMETERS",
    "GIT_INDEX_FILE",
    "GIT_NAMESPACE",
  ]) {
    delete environment[key];
  }
  environment["HOME"] = fixtureRoot;
  environment["XDG_CONFIG_HOME"] = join(fixtureRoot, "xdg");
  environment["GIT_CONFIG_NOSYSTEM"] = "1";
  environment["GIT_CONFIG_GLOBAL"] = join(fixtureRoot, "absent-global-gitconfig");
  environment["GIT_TERMINAL_PROMPT"] = "0";
  environment["LC_ALL"] = "C";
  environment["LANG"] = "C";
  environment["GIT_AUTHOR_NAME"] = "Fixture Author";
  environment["GIT_AUTHOR_EMAIL"] = "fixture@example.invalid";
  environment["GIT_COMMITTER_NAME"] = "Fixture Author";
  environment["GIT_COMMITTER_EMAIL"] = "fixture@example.invalid";
  environment["GIT_AUTHOR_DATE"] = "1735689600 +0000";
  environment["GIT_COMMITTER_DATE"] = "1735689600 +0000";
  return environment;
}

/**
 * Spawn fixture git and RESOLVE on any exit status, rejecting only when there
 * was no exit status at all — the Phase-2 acceptance suite's helper, extended
 * with a per-call environment overlay (the porcelain reference legs need
 * `GIT_INDEX_FILE`, and the `commit-tree` reconstruction needs the six-var ident
 * set the service stamps).
 */
function spawnFixtureGit(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv,
  cwd: string,
  stdin?: string,
): Promise<FixtureGitResult> {
  return new Promise<FixtureGitResult>((resolve, reject) => {
    const child = execFile(
      "git",
      [...argv],
      { encoding: "utf8", env: environment, cwd, timeout: FIXTURE_GIT_TIMEOUT_MS },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ exitCode: 0, stdout, stderr });
          return;
        }
        // `ExecFileException.code` admits `null` as well as the string codes a
        // spawn failure carries; only a NUMBER is an exit status.
        const reportedCode: number | string | null | undefined = error.code;
        if (typeof reportedCode !== "number") {
          reject(new Error(`fixture git ${argv.join(" ")} did not run: ${String(error.message)}`));
          return;
        }
        resolve({ exitCode: reportedCode, stdout, stderr });
      },
    ).on("error", reject);
    // Closed on EVERY spawn, supplied or not — a fixture command that reads
    // stdin would otherwise hang on the test runner's, which is exactly the trap
    // the service's own seam closes on its side.
    const childStdin = child.stdin;
    if (childStdin !== null) {
      childStdin.on("error", () => {
        /* the invocation's failure already travels on the exit status */
      });
      if (stdin !== undefined) {
        childStdin.write(stdin);
      }
      childStdin.end();
    }
  });
}

/** One real git repository under the fixture root. */
class FixtureRepository {
  readonly root: string;
  readonly #environment: NodeJS.ProcessEnv;

  constructor(root: string, environment: NodeJS.ProcessEnv) {
    this.root = root;
    this.#environment = environment;
  }

  /** Throws on any non-zero exit; returns trimmed stdout. */
  async git(argv: readonly string[], options: FixtureGitOptions = {}): Promise<string> {
    const result = await this.gitCapturing(argv, options);
    if (result.exitCode !== 0) {
      throw new Error(
        `fixture git ${argv.join(" ")} exited ${String(result.exitCode)}: ${result.stderr}`,
      );
    }
    return result.stdout.trim();
  }

  /** The caller inspects the exit status itself. */
  gitCapturing(
    argv: readonly string[],
    options: FixtureGitOptions = {},
  ): Promise<FixtureGitResult> {
    const environment: NodeJS.ProcessEnv = {
      ...this.#environment,
      ...options.environmentOverrides,
    };
    return spawnFixtureGit(argv, environment, options.cwd ?? this.root, options.stdin);
  }

  write(relativePath: string, contents: string): void {
    const absolute: string = join(this.root, relativePath);
    mkdirSync(join(absolute, ".."), { recursive: true });
    writeFileSync(absolute, contents);
  }

  /** Every ref in the repository, one `<oid> <name>` line per ref, sorted. */
  refListing(pattern?: string): Promise<string> {
    const argv: readonly string[] =
      pattern === undefined
        ? ["for-each-ref", "--format=%(objectname) %(refname)"]
        : ["for-each-ref", "--format=%(objectname) %(refname)", pattern];
    return this.git(argv);
  }

  /**
   * This repository's own index file, resolved through git.
   *
   * NOT `<root>/.git/index`. A linked worktree's `.git` is a FILE, and its index
   * lives under `<main>/.git/worktrees/<id>/index`; the naive spelling
   * `ENOTDIR`s there, and would silently read the MAIN checkout's index anywhere
   * it happened to resolve. This is the same resolution the service performs for
   * its own sparse seed, arrived at here for the same reason.
   */
  async resolvedIndexPath(): Promise<string> {
    const reported: string = await this.git(["rev-parse", "--git-path", "index"]);
    return isAbsolute(reported) ? reported : join(this.root, reported);
  }

  /**
   * The tree porcelain `git add -A` would stage from the current worktree — the
   * REFERENCE the capture pipeline is measured against.
   *
   * Staged against a COPY of the real index rather than the real one, so the
   * fixture's own state is untouched and the answer is the true porcelain answer
   * (an empty scratch index would make every tracked deletion invisible, since
   * there would be nothing in the index to delete).
   *
   * The `add -A` leg tolerates exactly ONE non-zero exit, and no others. The two
   * inputs that make it non-zero-or-noisy are both inputs this reference has to
   * survive rather than refuse:
   *
   *   * an untracked embedded repository, where `add -A` warns on stderr and
   *     exits 0;
   *   * an out-of-cone path in a SPARSE root, where `add -A` exits 1 with the
   *     `paths … outside of your sparse-checkout definition` advice. That advice
   *     is about which paths porcelain DECLINED to update, and the index it
   *     leaves behind is exactly the reference wanted — measured on git 2.50.1:
   *     the tree after the refused `add -A` is byte-identical to staging only the
   *     in-cone listing. Refusing here would make the sparse arms unable to state
   *     the equivalence at all, which is the arm porcelain is most needed for.
   *
   * The tolerance is scoped to SPARSE roots rather than applied blanket, because
   * this helper served eight non-sparse call sites before the sparse arms existed
   * and "ignore the status" would silently relax all of them — an `add -A` that
   * failed on a lock, a bad pathspec or an unwritable index would then hand back
   * a reference tree derived from a half-updated index. The scope is read from
   * `core.sparseCheckout`, deliberately NOT from git's advice string: the wording
   * is prose that may differ between the 2.50.1 this was measured on and the
   * 2.54.x CI runs, and a helper that THROWS on a non-match would turn a reworded
   * message into a red sparse suite on CI and a green one here. The config bit
   * discriminates exactly as well and reads the same on every version.
   * `write-tree`'s status is checked either way, so both legs still have to be
   * genuinely usable.
   */
  async porcelainAddAllTree(scratchIndexPath: string): Promise<string> {
    copyFileSync(await this.resolvedIndexPath(), scratchIndexPath);
    const overrides = { GIT_INDEX_FILE: scratchIndexPath };
    const staged: FixtureGitResult = await this.gitCapturing(["add", "-A"], {
      environmentOverrides: overrides,
    });
    if (staged.exitCode !== 0) {
      const sparseBit: string = await this.git([
        "config",
        "--type=bool",
        "--default=false",
        "--get",
        "core.sparseCheckout",
      ]);
      if (sparseBit !== "true") {
        throw new Error(
          `fixture porcelain git add -A exited ${String(staged.exitCode)}: ${staged.stderr}`,
        );
      }
    }
    return this.git(["write-tree"], { environmentOverrides: overrides });
  }
}

// ----------------------------------------------------------------------------
// Harness
// ----------------------------------------------------------------------------

interface Fixture {
  readonly fixtureRoot: string;
  readonly executionRootsDirectory: string;
  readonly repository: FixtureRepository;
  readonly diagnostics: TurnSnapshotDiagnostic[];
}

let fixture: Fixture;

beforeEach(async () => {
  // `realpathSync` because macOS hands out `/var/...` symlinks for the temporary
  // directory while git reports the resolved `/private/var/...` form.
  const fixtureRoot: string = realpathSync(
    mkdtempSync(join(tmpdir(), "ai-sidekicks-turn-snapshot-")),
  );
  const environment: NodeJS.ProcessEnv = buildFixtureEnvironment(fixtureRoot);
  const repositoryRoot: string = join(fixtureRoot, "execution-root");
  const repository = new FixtureRepository(repositoryRoot, environment);

  // Published BEFORE the first fallible statement — the constructor above does
  // no I/O — so a setup that fails halfway still leaves `afterEach` a fixture
  // root to remove. Assigning at the END would make every setup failure surface
  // as `cannot read properties of undefined` in teardown, masking the real
  // error and leaking the temporary directory.
  fixture = {
    fixtureRoot,
    executionRootsDirectory: join(fixtureRoot, "execution-roots"),
    repository,
    diagnostics: [],
  };

  mkdirSync(repositoryRoot, { recursive: true });
  await repository.git(["-c", "init.defaultBranch=main", "init", "-q", repositoryRoot], {
    cwd: fixtureRoot,
  });
  repository.write("tracked.txt", "tracked v1\n");
  repository.write(".gitignore", FIXTURE_IGNORE_RULES);
  repository.write("tracked-but-ignored.txt", "tracking wins over ignoring\n");
  repository.write("doomed.txt", "deleted during the turn\n");
  await repository.git(["add", "-A"]);
  // `-f`, because the base commit has to contain a file that `.gitignore`
  // matches: "tracked wins over ignored" is only assertable against a file that
  // is genuinely both, and `git add -A` would have skipped it as ignored.
  await repository.git(["add", "-f", "tracked-but-ignored.txt"]);
  await repository.git(["commit", "-q", "-m", "base"]);
});

afterEach(() => {
  // Ambient environment stubs are per-case (the strip-list behavioral case is
  // the only one that sets any); unstubbed here as well as in that case's own
  // `finally`, so a future case cannot leak one into its neighbors.
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(fixture.fixtureRoot, { recursive: true, force: true });
});

/** Seams a case replaces; everything unset stays at the production default. */
interface ServiceOverrides {
  readonly git?: TurnSnapshotGitRunner;
  readonly filesystem?: TurnSnapshotFilesystem;
  readonly now?: () => string;
  readonly emitDiagnostic?: (diagnostic: TurnSnapshotDiagnostic) => void;
  /** Retention only. The capture cases construct WITHOUT one. */
  readonly database?: DatabaseType;
  readonly retentionWindowMs?: number;
}

/** The service under test, at production seams unless a case overrides one. */
function buildService(overrides: ServiceOverrides = {}): TurnSnapshotService {
  return new TurnSnapshotService({
    executionRootsDirectory: fixture.executionRootsDirectory,
    now: overrides.now ?? ((): string => FIXED_INSTANT),
    emitDiagnostic:
      overrides.emitDiagnostic ??
      ((diagnostic: TurnSnapshotDiagnostic): void => {
        fixture.diagnostics.push(diagnostic);
      }),
    ...(overrides.git === undefined ? {} : { git: overrides.git }),
    ...(overrides.filesystem === undefined ? {} : { filesystem: overrides.filesystem }),
    ...(overrides.database === undefined ? {} : { database: overrides.database }),
    ...(overrides.retentionWindowMs === undefined
      ? {}
      : { retentionWindowMs: overrides.retentionWindowMs }),
  });
}

/**
 * The production filesystem seam, with `removePath` replaced by a thrower.
 *
 * `createDirectory` stays real: the point of the cleanup cases is a capture that
 * otherwise runs end to end, so the scratch index has to genuinely exist and the
 * hook-neutralization directory has to be genuinely created.
 */
function buildRemoveFailingFilesystem(reason: Error): TurnSnapshotFilesystem {
  return {
    createDirectory(path: string): Promise<void> {
      mkdirSync(path, { recursive: true });
      return Promise.resolve();
    },
    removePath(): Promise<void> {
      return Promise.reject(reason);
    },
  };
}

/** Populate the worktree with the turn's effects: an edit, a delete, new files. */
function applyTurnEffects(): void {
  const repository: FixtureRepository = fixture.repository;
  repository.write("tracked.txt", "tracked v2 — modified during the turn\n");
  rmSync(join(repository.root, "doomed.txt"));
  repository.write("created.txt", "created during the turn\n");
  repository.write("nested/deep/created.txt", "created deeper\n");
  repository.write("ignored-file.txt", "derived, project-declared disposable\n");
  repository.write("ignored-dir/artifact.bin", "derived\n");
}

/** An untracked embedded git repository with a commit — a gitlink candidate. */
async function createEmbeddedRepository(relativePath: string): Promise<string> {
  const repository: FixtureRepository = fixture.repository;
  const absolute: string = join(repository.root, relativePath);
  mkdirSync(absolute, { recursive: true });
  await repository.git(["-c", "init.defaultBranch=main", "init", "-q", absolute], {
    cwd: repository.root,
  });
  writeFileSync(join(absolute, "inner.txt"), "inner\n");
  await repository.git(["add", "-A"], { cwd: absolute });
  await repository.git(["commit", "-q", "-m", "inner"], { cwd: absolute });
  return repository.git(["rev-parse", "HEAD"], { cwd: absolute });
}

/**
 * An untracked embedded git repository with a commit, at a chosen OBJECT FORMAT
 * and inside a chosen parent — the mixed-format cases' fixture. Returns its
 * `HEAD`, whose hex length is the thing those cases turn on.
 */
async function createEmbeddedRepositoryWithObjectFormat(
  parent: FixtureRepository,
  relativePath: string,
  objectFormat: string,
): Promise<string> {
  const absolute: string = join(parent.root, relativePath);
  mkdirSync(absolute, { recursive: true });
  await parent.git(
    ["-c", "init.defaultBranch=main", "init", "-q", `--object-format=${objectFormat}`, absolute],
    { cwd: parent.root },
  );
  writeFileSync(join(absolute, "inner.txt"), "inner\n");
  await parent.git(["add", "-A"], { cwd: absolute });
  await parent.git(["commit", "-q", "-m", "inner"], { cwd: absolute });
  return parent.git(["rev-parse", "HEAD"], { cwd: absolute });
}

/**
 * An INDEPENDENT execution root at a chosen object format, with the same base
 * commit shape the harness builds.
 *
 * The harness repository is SHA-1, so the SHA-256 SUPERPROJECT direction is not
 * reachable from it; capture takes its execution root per call, which is what
 * makes a second root usable without a second harness.
 */
async function createExecutionRootWithObjectFormat(
  name: string,
  objectFormat: string,
): Promise<FixtureRepository> {
  const root: string = join(fixture.fixtureRoot, name);
  const repository = new FixtureRepository(root, buildFixtureEnvironment(fixture.fixtureRoot));
  mkdirSync(root, { recursive: true });
  await repository.git(
    ["-c", "init.defaultBranch=main", "init", "-q", `--object-format=${objectFormat}`, root],
    { cwd: fixture.fixtureRoot },
  );
  repository.write("tracked.txt", "tracked v1\n");
  repository.write(".gitignore", FIXTURE_IGNORE_RULES);
  await repository.git(["add", "-A"]);
  await repository.git(["commit", "-q", "-m", "base"]);
  return repository;
}

/** An untracked embedded git repository with an UNBORN `HEAD` — not a gitlink. */
async function createCommitlessEmbeddedRepository(relativePath: string): Promise<void> {
  const repository: FixtureRepository = fixture.repository;
  const absolute: string = join(repository.root, relativePath);
  mkdirSync(absolute, { recursive: true });
  await repository.git(["-c", "init.defaultBranch=main", "init", "-q", absolute], {
    cwd: repository.root,
  });
}

/** Narrow to the `captured` arm, failing the case with the actual outcome if not. */
function expectCaptured(
  result: TurnSnapshotCaptureResult,
): Extract<TurnSnapshotCaptureResult, { outcome: "captured" }> {
  expect(result.outcome).toBe("captured");
  if (result.outcome !== "captured") {
    throw new Error("unreachable — asserted above");
  }
  return result;
}

const CAPTURE_DEFAULTS = { runId: RUN_ID, epoch: 0, turnOrdinal: 1 } as const;

// ----------------------------------------------------------------------------
// ----------------------------------------------------------------------------

/** Capture a turn against the fixture repository and narrow to the `captured` arm. */
async function captureTurn(
  service: TurnSnapshotService,
  overrides: { readonly epoch?: number; readonly turnOrdinal?: number } = {},
): Promise<TurnSnapshotCaptured> {
  return expectCaptured(
    await service.captureTurnSnapshot({
      ...CAPTURE_DEFAULTS,
      ...overrides,
      executionRoot: fixture.repository.root,
    }),
  );
}

// ----------------------------------------------------------------------------
// Cases
// ----------------------------------------------------------------------------

describe("TurnSnapshotService.captureTurnSnapshot", () => {
  it("writes the epoch-namespaced ref parented at the base resolved at entry", async () => {
    const repository: FixtureRepository = fixture.repository;
    applyTurnEffects();
    const base: string = await repository.git(["rev-parse", "HEAD"]);

    const result = expectCaptured(
      await buildService().captureTurnSnapshot({
        ...CAPTURE_DEFAULTS,
        executionRoot: repository.root,
      }),
    );

    // The ref path is spelled LITERALLY — the
    // `refs/sidekicks/runs/<runId>/epoch-<E>/turn-<N>` — rather than derived from
    // the service, so a builder that changed shape is caught here rather than
    // agreeing with itself.
    expect(result.ref).toBe(`refs/sidekicks/runs/${RUN_ID}/epoch-0/turn-1`);
    expect(await repository.git(["rev-parse", result.ref])).toBe(result.snapshotCommit);

    // ONE base OID, used for both legs: the recorded first parent is the value
    // resolved at entry, and the reported `baseCommit` is that same value.
    expect(result.baseCommit).toBe(base);
    expect(await repository.git(["rev-parse", `${result.ref}^`])).toBe(base);
    expect(result.skippedEmbeddedRepositories).toEqual([]);

    // The fixed message is a commit-object field and therefore an OID input; it
    // carries no run id, epoch or ordinal (the REF carries all three).
    expect(await repository.git(["log", "-1", "--format=%s", result.ref])).toBe(
      "sidekicks: turn-boundary snapshot",
    );
    // The daemon-owned identity, at a fixed UTC offset — never the user's, and
    // never the host's timezone.
    expect(
      await repository.git(["log", "-1", "--format=%an <%ae>|%ad", "--date=raw", result.ref]),
    ).toBe("AI Sidekicks <snapshots@ai-sidekicks.invalid>|1767225600 +0000");
  });

  it("keeps snapshot refs out of branch history entirely", async () => {
    const repository: FixtureRepository = fixture.repository;
    applyTurnEffects();
    const branchesBefore: string = await repository.refListing("refs/heads/");
    const headBefore: string = await repository.git(["rev-parse", "HEAD"]);
    const symbolicHeadBefore: string = await repository.git(["symbolic-ref", "HEAD"]);

    const result = expectCaptured(
      await buildService().captureTurnSnapshot({
        ...CAPTURE_DEFAULTS,
        executionRoot: repository.root,
      }),
    );

    // Half one: the ref is where the invariant says and NOWHERE else. The full
    // ref listing minus the snapshot leaves exactly the pre-capture branches.
    expect(await repository.refListing("refs/heads/")).toBe(branchesBefore);
    expect(await repository.refListing()).toBe(
      `${branchesBefore}\n${result.snapshotCommit} ${result.ref}`,
    );

    // Half two — the load-bearing one: INVISIBLE TO BRANCH HISTORY. No branch
    // contains the snapshot commit, and `HEAD` did not move (neither its
    // symbolic target nor the commit it resolves to), so branch history, PR
    // preparation and diff attribution see nothing (no-impact).
    expect(await repository.git(["branch", "--contains", result.snapshotCommit])).toBe("");
    expect(await repository.git(["rev-parse", "HEAD"])).toBe(headBefore);
    expect(await repository.git(["symbolic-ref", "HEAD"])).toBe(symbolicHeadBefore);
    expect(await repository.git(["rev-list", "--count", "HEAD"])).toBe("1");
  });

  it("stages a tree byte-identical to `git add -A` under identical inputs", async () => {
    const repository: FixtureRepository = fixture.repository;
    applyTurnEffects();
    // An in-tree `.gitattributes` plus a path it converts. The pipeline pins
    // `core.attributesFile=/dev/null`, which neutralizes the HOST's attributes
    // only — a project's own declaration still governs both legs, so equivalence
    // has to hold on a conversion-affected path, not just on inert ones.
    repository.write(".gitattributes", "*.txt text\n");
    repository.write("converted.txt", "alpha\r\nbeta\r\n");

    const result = expectCaptured(
      await buildService().captureTurnSnapshot({
        ...CAPTURE_DEFAULTS,
        executionRoot: repository.root,
      }),
    );
    const snapshotTree: string = await repository.git(["rev-parse", `${result.ref}^{tree}`]);
    const porcelainTree: string = await repository.porcelainAddAllTree(
      join(fixture.fixtureRoot, "porcelain.index"),
    );

    expect(snapshotTree).toBe(porcelainTree);

    // Named rather than left implicit in the hash: the turn's edit, its deletion
    // (the `--remove` half of the staging leg) and its creations are all in.
    const entries: readonly string[] = (
      await repository.git(["ls-tree", "-r", "--name-only", snapshotTree])
    )
      .split("\n")
      .filter((line) => line !== "");
    expect(entries).toContain("created.txt");
    expect(entries).toContain("nested/deep/created.txt");
    expect(entries).not.toContain("doomed.txt");
    expect(await repository.git(["show", `${snapshotTree}:tracked.txt`])).toBe(
      "tracked v2 — modified during the turn",
    );

    // The conversion itself fired: the blob is LF-normalized, so the equivalence
    // above was asserted on a path both legs genuinely converted rather than on
    // one the attribute happened not to touch.
    const convertedBlob: string = await repository.git([
      "cat-file",
      "-p",
      `${snapshotTree}:converted.txt`,
    ]);
    expect(convertedBlob).toBe("alpha\nbeta");
    expect(convertedBlob).not.toContain("\r");
  });

  it("records a committed untracked embedded repository as a 160000 gitlink", async () => {
    const repository: FixtureRepository = fixture.repository;
    applyTurnEffects();
    const embeddedHead: string = await createEmbeddedRepository("embedded");

    const result = expectCaptured(
      await buildService().captureTurnSnapshot({
        ...CAPTURE_DEFAULTS,
        executionRoot: repository.root,
      }),
    );
    const snapshotTree: string = await repository.git(["rev-parse", `${result.ref}^{tree}`]);

    // The bare pipeline would have OMITTED this repository: `ls-files -o` reports
    // it as the single directory entry `embedded/` and `update-index --add`
    // silently drops it. The normalization pass is what puts it back, in
    // porcelain's own representation.
    expect(await repository.git(["ls-tree", snapshotTree, "embedded"])).toBe(
      `160000 commit ${embeddedHead}\tembedded`,
    );
    expect(result.skippedEmbeddedRepositories).toEqual([]);

    // …and the `git add -A` equivalence extends to this fixture, which is the
    // claim the normalization exists to preserve.
    expect(snapshotTree).toBe(
      await repository.porcelainAddAllTree(join(fixture.fixtureRoot, "porcelain.index")),
    );
  });

  it("succeeds on a staging leg that writes to stderr and exits 0", async () => {
    const repository: FixtureRepository = fixture.repository;
    applyTurnEffects();
    await createEmbeddedRepository("embedded");

    // The seam WRAPS the production runner to read the stdio of an invocation
    // the service treated as a SUCCESS. That is the only way to observe the
    // rule: failure detection is by exit status alone, never by non-empty
    // stderr, and this fixture is the input where the two disagree.
    const stderrByLeg = new Map<string, string>();
    const recordingRunner: TurnSnapshotGitRunner = async (argv, options) => {
      const result = await runTurnSnapshotGitWithExecFile(argv, options);
      if (argv.includes("update-index") && argv.includes("--stdin")) {
        stderrByLeg.set("stage-paths", result.stderr);
      }
      return result;
    };

    const result = expectCaptured(
      await buildService({ git: recordingRunner }).captureTurnSnapshot({
        ...CAPTURE_DEFAULTS,
        executionRoot: repository.root,
      }),
    );

    // `update-index --add` announces the dropped embedded repository and exits
    // 0. A leg check keyed on non-empty stderr would have failed this capture —
    // on precisely the input the normalization pass exists to handle.
    expect(stderrByLeg.get("stage-paths")).toContain("Ignoring path");
    expect(result.skippedEmbeddedRepositories).toEqual([]);
    expect(await repository.git(["rev-parse", result.ref])).toBe(result.snapshotCommit);
    expect(fixture.diagnostics).toEqual([]);
  });

  it("skips and enumerates a commitless embedded repository rather than capturing or throwing", async () => {
    const repository: FixtureRepository = fixture.repository;
    applyTurnEffects();
    await createCommitlessEmbeddedRepository("unborn");

    const result = expectCaptured(
      await buildService().captureTurnSnapshot({
        ...CAPTURE_DEFAULTS,
        executionRoot: repository.root,
      }),
    );

    // Skipped, and ENUMERATED in the capture diagnostic — the spec's word — with
    // the result carrying the same list for a caller that does not subscribe.
    expect(result.skippedEmbeddedRepositories).toEqual(["unborn"]);
    expect(fixture.diagnostics).toEqual([
      {
        kind: "embedded-repositories-skipped",
        runId: RUN_ID,
        epoch: 0,
        turnOrdinal: 1,
        ref: result.ref,
        skippedPaths: ["unborn"],
      },
    ]);
    const snapshotTree: string = await repository.git(["rev-parse", `${result.ref}^{tree}`]);
    expect(await repository.git(["ls-tree", snapshotTree, "unborn"])).toBe("");

    // Equivalence is deliberately NOT asserted on this input: porcelain HARD-FAILS
    // where capture skips. That divergence is the point — capture never blocks
    // the turn — so the control asserts the porcelain failure rather than a tree.
    const porcelain: FixtureGitResult = await repository.gitCapturing(["add", "-A"], {
      environmentOverrides: { GIT_INDEX_FILE: join(fixture.fixtureRoot, "porcelain.index") },
    });
    expect(porcelain.exitCode).not.toBe(0);
    expect(porcelain.stderr).toContain("does not have a commit checked out");
  });

  it("skips a SHA-1 embedded repository in a SHA-256 superproject instead of failing capture", async () => {
    const superproject: FixtureRepository = await createExecutionRootWithObjectFormat(
      "sha256-execution-root",
      "sha256",
    );
    const embeddedHead: string = await createEmbeddedRepositoryWithObjectFormat(
      superproject,
      "nested",
      "sha1",
    );
    // Both repositories are HEALTHY — this is not the unborn case wearing a
    // different hat. The only thing wrong is that their object formats differ.
    expect(await superproject.git(["rev-parse", "--show-object-format"])).toBe("sha256");
    expect(embeddedHead).toHaveLength(40);

    const result = expectCaptured(
      await buildService().captureTurnSnapshot({
        ...CAPTURE_DEFAULTS,
        executionRoot: superproject.root,
      }),
    );

    // The whole point: a capture, not a failure. Unguarded, the `--cacheinfo`
    // insert takes down the entire `normalize-embedded-repositories` step, and
    // every later rollback in the run resolves to `no_snapshot`.
    expect(result.skippedEmbeddedRepositories).toEqual(["nested"]);
    expect(fixture.diagnostics).toEqual([
      {
        kind: "embedded-repositories-skipped",
        runId: RUN_ID,
        epoch: 0,
        turnOrdinal: 1,
        ref: result.ref,
        skippedPaths: ["nested"],
      },
    ]);
    const snapshotTree: string = await superproject.git(["rev-parse", `${result.ref}^{tree}`]);
    expect(await superproject.git(["ls-tree", snapshotTree, "nested"])).toBe("");
    // …and the rest of the worktree is captured normally, so the skip is one
    // path wide rather than a quietly empty snapshot.
    expect(await superproject.git(["ls-tree", snapshotTree, "tracked.txt"])).toContain("blob");

    // The NEGATIVE CONTROL for the predicate: the insert the service no longer
    // reaches genuinely refuses this OID, so the skip is closing a real failure
    // rather than pre-empting one that would have worked.
    const controlIndex: string = join(fixture.fixtureRoot, "mixed-format.index");
    const controlEnvironment = { GIT_INDEX_FILE: controlIndex };
    await superproject.git(["read-tree", "HEAD"], { environmentOverrides: controlEnvironment });
    const refusal: FixtureGitResult = await superproject.gitCapturing(
      ["update-index", "--add", "--cacheinfo", `160000,${embeddedHead},nested`],
      { environmentOverrides: controlEnvironment },
    );
    expect(refusal.exitCode).not.toBe(0);
    expect(refusal.stderr).toContain("expects <mode>,<sha1>,<path>");
  });

  it("skips a SHA-256 embedded repository in a SHA-1 superproject, the mirror direction", async () => {
    const repository: FixtureRepository = fixture.repository;
    applyTurnEffects();
    const embeddedHead: string = await createEmbeddedRepositoryWithObjectFormat(
      repository,
      "nested",
      "sha256",
    );
    // The harness repository is SHA-1, so this is the comparison running the
    // other way. A length test rather than a format-name test would be the same
    // thing; a `catch` around the insert would be neither, and would swallow an
    // index-lock failure with it.
    expect(await repository.git(["rev-parse", "--show-object-format"])).toBe("sha1");
    expect(embeddedHead).toHaveLength(64);

    const result = expectCaptured(
      await buildService().captureTurnSnapshot({
        ...CAPTURE_DEFAULTS,
        executionRoot: repository.root,
      }),
    );

    expect(result.skippedEmbeddedRepositories).toEqual(["nested"]);
    const snapshotTree: string = await repository.git(["rev-parse", `${result.ref}^{tree}`]);
    expect(await repository.git(["ls-tree", snapshotTree, "nested"])).toBe("");
    expect(await repository.git(["ls-tree", snapshotTree, "created.txt"])).toContain("blob");
  });

  it("FAILS the capture when the embedded HEAD probe exits zero without an object id", async () => {
    const repository: FixtureRepository = fixture.repository;
    applyTurnEffects();
    // A HEALTHY, RECORDABLE embedded repository — the discriminator of this case.
    // The two skip classes are both genuinely unrecordable, so enumerating them
    // costs the snapshot nothing it could have held; this one is a `160000`
    // gitlink the capture is able to record, which is why a skip here would be a
    // silent narrowing rather than an honest degrade.
    await createEmbeddedRepository("embedded");
    const refsBefore: string = await repository.refListing();
    const embeddedRoot: string = join(repository.root, "embedded");

    // Exit ZERO with stdout that is not an object id — the shape bare
    // `git rev-parse HEAD` produces on a miss, echoing its own argument. Keyed on
    // the `-C` DIRECTORY rather than on the subcommand: the capture's own base
    // resolution runs the identical `rev-parse --verify HEAD` against the
    // execution root, and only the embedded one is under test here.
    const echoingRunner: TurnSnapshotGitRunner = async (argv, options) => {
      if (argv.includes(embeddedRoot) && argv.includes("rev-parse")) {
        return { stdout: Buffer.from("HEAD\n"), stderr: "" };
      }
      return runTurnSnapshotGitWithExecFile(argv, options);
    };

    const result = await buildService({ git: echoingRunner }).captureTurnSnapshot({
      ...CAPTURE_DEFAULTS,
      executionRoot: repository.root,
    });

    // Refused through the capture funnel under its own step — never skipped, and
    // never a throw either, since capture is still not a turn gate.
    expect(result).toEqual({
      outcome: "failed",
      ref: `refs/sidekicks/runs/${RUN_ID}/epoch-0/turn-1`,
      failedStep: "normalize-embedded-repositories",
    });
    expect(fixture.diagnostics).toHaveLength(1);
    expect(fixture.diagnostics[0]).toMatchObject({
      kind: "capture-failed",
      runId: RUN_ID,
      epoch: 0,
      turnOrdinal: 1,
      failedStep: "normalize-embedded-repositories",
      detail: "git did not report an object id",
    });
    // The negative half of the same assertion: the path was NOT enumerated as an
    // unrecordable repository, which is the report a swallow produced.
    expect(
      fixture.diagnostics.some((diagnostic) => diagnostic.kind === "embedded-repositories-skipped"),
    ).toBe(false);
    // And nothing was published — a failed capture leaves the ref namespace and
    // the scratch-index directory exactly as it found them.
    expect(await repository.refListing()).toBe(refsBefore);
    expect(readdirSync(join(fixture.executionRootsDirectory, ".snapshot-indexes"))).toEqual([]);
  });

  it("keeps the snapshot message's bytes when nothing was skipped, and records the skips when something was", async () => {
    const repository: FixtureRepository = fixture.repository;
    applyTurnEffects();
    const service: TurnSnapshotService = buildService();

    // The 99% capture: no skip, so the message must still be exactly the fixed
    // subject specifies. This is the determinism guarantee the trailer had to be
    // designed around — a trailer on every capture would have changed every
    // snapshot OID in the repository.
    const clean: TurnSnapshotCaptured = await captureTurn(service);
    expect(await repository.git(["cat-file", "commit", clean.snapshotCommit])).toMatch(
      /\n\nsidekicks: turn-boundary snapshot$/,
    );
    expect(await repository.git(["cat-file", "commit", clean.snapshotCommit])).not.toContain(
      "Skipped-Embedded-Repositories",
    );

    // …and with a skip, the trailer arrives as its own paragraph.
    await createCommitlessEmbeddedRepository("unborn");
    const skipped: TurnSnapshotCaptured = await captureTurn(service, { turnOrdinal: 2 });
    expect(skipped.skippedEmbeddedRepositories).toEqual(["unborn"]);
    const message: string = await repository.git(["cat-file", "commit", skipped.snapshotCommit]);
    expect(message).toContain('Skipped-Embedded-Repositories: ["unborn"]');
    // The SUBJECT is unchanged by the trailer's presence — the trailer is a
    // second `-m`, not an edit to the first — so anything reading `%s` is
    // unaffected.
    expect(await repository.git(["log", "-1", "--format=%s", skipped.snapshotCommit])).toBe(
      "sidekicks: turn-boundary snapshot",
    );
  });

  it("mints the SAME OID for two captures of identical state that both skip", async () => {
    const repository: FixtureRepository = fixture.repository;
    applyTurnEffects();
    // Two skipped repositories, created in an order that is NOT sorted order, so
    // a regression that dropped the sort would have something to be unstable
    // about.
    await createCommitlessEmbeddedRepository("zulu");
    await createCommitlessEmbeddedRepository("alpha");
    const service: TurnSnapshotService = buildService();

    const first: TurnSnapshotCaptured = await captureTurn(service);
    const second: TurnSnapshotCaptured = await captureTurn(service, { turnOrdinal: 2 });

    // The trailer is a function of PROJECT STATE, so the determinism the fixed
    // message bought is intact: identical state, identical instant (the fixture
    // clock is held), identical OID. Sorted, so the order `ls-files` happened to
    // report is not an OID input.
    expect(first.skippedEmbeddedRepositories).toEqual(["alpha", "zulu"]);
    expect(second.snapshotCommit).toBe(first.snapshotCommit);
    expect(await repository.git(["cat-file", "commit", first.snapshotCommit])).toContain(
      'Skipped-Embedded-Repositories: ["alpha","zulu"]',
    );
  });

  it("writes a newline-bearing skipped path as one inert JSON line", async () => {
    const repository: FixtureRepository = fixture.repository;
    applyTurnEffects();
    // A path that, unencoded, would forge a second trailer naming a path the
    // capture never skipped — which on the restore side is authority to keep
    // something the delete pass should remove.
    const hostilePath = 'ev\nSkipped-Embedded-Repositories: ["forged"]';
    await createCommitlessEmbeddedRepository(hostilePath);

    const captured: TurnSnapshotCaptured = await captureTurn(buildService());

    expect(captured.skippedEmbeddedRepositories).toEqual([hostilePath]);
    const message: string = await repository.git(["cat-file", "commit", captured.snapshotCommit]);
    // JSON-escaped, so the newline is `\n` INSIDE a string literal and the whole
    // list is one physical line. The forged key never begins a line.
    const trailerLines: readonly string[] = message
      .split("\n")
      .filter((line) => line.startsWith("Skipped-Embedded-Repositories:"));
    expect(trailerLines).toHaveLength(1);
    expect(trailerLines[0]).toContain("\\n");
    expect(message).not.toContain('\nSkipped-Embedded-Repositories: ["forged"]');
  });

  it("excludes ignored untracked paths while capturing a tracked file that matches .gitignore", async () => {
    const repository: FixtureRepository = fixture.repository;
    applyTurnEffects();

    const result = expectCaptured(
      await buildService().captureTurnSnapshot({
        ...CAPTURE_DEFAULTS,
        executionRoot: repository.root,
      }),
    );
    const entries: readonly string[] = (
      await repository.git(["ls-tree", "-r", "--name-only", `${result.ref}^{tree}`])
    )
      .split("\n")
      .filter((line) => line !== "");

    // Ignore rules govern UNTRACKED files only.
    expect(entries).not.toContain("ignored-file.txt");
    expect(entries).not.toContain("ignored-dir/artifact.bin");
    // …so tracking wins over ignoring: a tracked file matching `.gitignore` is
    // captured like any other tracked file.
    expect(entries).toContain("tracked-but-ignored.txt");
    // The `.gitignore` itself is captured, which is what makes the restore leg's
    // untracked-delete pass able to honor the same rules.
    expect(entries).toContain(".gitignore");
  });

  it(
    "mints a host-config-independent OID across autocrlf, commitEncoding and excludesFile",
    { timeout: MULTI_SEQUENCE_CASE_TIMEOUT_MS },
    async () => {
      const repository: FixtureRepository = fixture.repository;
      applyTurnEffects();
      // A CRLF worktree file is what gives `core.autocrlf` something to convert.
      repository.write("crlf.txt", "line one\r\nline two\r\n");
      const service: TurnSnapshotService = buildService();

      const baseline = expectCaptured(
        await service.captureTurnSnapshot({
          ...CAPTURE_DEFAULTS,
          executionRoot: repository.root,
        }),
      );
      const baselineTree: string = await repository.git(["rev-parse", `${baseline.ref}^{tree}`]);

      // --- host `core.autocrlf` ------------------------------------------------
      await repository.git(["config", "core.autocrlf", "true"]);
      const underAutocrlf = expectCaptured(
        await service.captureTurnSnapshot({
          ...CAPTURE_DEFAULTS,
          turnOrdinal: 2,
          executionRoot: repository.root,
        }),
      );
      expect(underAutocrlf.snapshotCommit).toBe(baseline.snapshotCommit);
      // NEGATIVE CONTROL: unpinned staging under the same config re-hashes the CRLF
      // bytes to LF blobs and lands a DIFFERENT tree. The pin is load-bearing.
      expect(await repository.porcelainAddAllTree(join(fixture.fixtureRoot, "p1.index"))).not.toBe(
        baselineTree,
      );
      await repository.git(["config", "--unset", "core.autocrlf"]);

      // --- host `i18n.commitEncoding` -----------------------------------------
      await repository.git(["config", "i18n.commitEncoding", "ISO-8859-1"]);
      const underEncoding = expectCaptured(
        await service.captureTurnSnapshot({
          ...CAPTURE_DEFAULTS,
          turnOrdinal: 3,
          executionRoot: repository.root,
        }),
      );
      expect(underEncoding.snapshotCommit).toBe(baseline.snapshotCommit);
      // NEGATIVE CONTROL, and simultaneously a RECONSTRUCTION of the whole commit
      // recipe: the fixture re-runs `commit-tree` over the same tree, parent,
      // message and six-var ident/date set. WITH the pin it reproduces the
      // service's OID exactly; without it, the host encoding writes an `encoding`
      // header and the OID moves.
      const identityOverrides = {
        GIT_AUTHOR_NAME: "AI Sidekicks",
        GIT_AUTHOR_EMAIL: "snapshots@ai-sidekicks.invalid",
        GIT_AUTHOR_DATE: "1767225600 +0000",
        GIT_COMMITTER_NAME: "AI Sidekicks",
        GIT_COMMITTER_EMAIL: "snapshots@ai-sidekicks.invalid",
        GIT_COMMITTER_DATE: "1767225600 +0000",
      };
      const commitTreeArgv: readonly string[] = [
        "commit-tree",
        baselineTree,
        "-p",
        baseline.baseCommit,
        "-m",
        "sidekicks: turn-boundary snapshot",
      ];
      expect(
        await repository.git(["-c", "i18n.commitEncoding=utf-8", ...commitTreeArgv], {
          environmentOverrides: identityOverrides,
        }),
      ).toBe(baseline.snapshotCommit);
      expect(
        await repository.git(commitTreeArgv, { environmentOverrides: identityOverrides }),
      ).not.toBe(baseline.snapshotCommit);
      await repository.git(["config", "--unset", "i18n.commitEncoding"]);

      // --- host `core.excludesFile` -------------------------------------------
      // A developer's private ignore patterns are not project declarations, so an
      // untracked project file matching one must still be captured.
      const excludesFile: string = join(fixture.fixtureRoot, "host-excludes");
      writeFileSync(excludesFile, "created.txt\n");
      await repository.git(["config", "core.excludesFile", excludesFile]);
      const underExcludes = expectCaptured(
        await service.captureTurnSnapshot({
          ...CAPTURE_DEFAULTS,
          turnOrdinal: 4,
          executionRoot: repository.root,
        }),
      );
      expect(underExcludes.snapshotCommit).toBe(baseline.snapshotCommit);
      // NEGATIVE CONTROL: porcelain DOES consult the host excludes and silently
      // omits the file — which is precisely why the recipe is plumbing with
      // explicit exclusion flags rather than `git add -A`.
      const porcelainUnderExcludes: string = await repository.porcelainAddAllTree(
        join(fixture.fixtureRoot, "p2.index"),
      );
      expect(porcelainUnderExcludes).not.toBe(baselineTree);
      expect(
        await repository.git(["ls-tree", "-r", "--name-only", porcelainUnderExcludes]),
      ).not.toContain("created.txt");
    },
  );

  it("seeds the scratch index past a replace ref planted on the base commit", async () => {
    const repository: FixtureRepository = fixture.repository;
    applyTurnEffects();
    const baseCommit: string = await repository.git(["rev-parse", "HEAD"]);

    // The attacker's base: the real one minus a path that is BOTH index-tracked
    // and ignored-by-rule. That class is the whole fixture, and it is the only
    // one that can survive the re-listing: `ls-files -o` will not name an ignored
    // path, so `--add --remove` can neither re-add it nor notice it missing. What
    // the seed drops here, the snapshot loses silently.
    const attackerIndex: string = join(fixture.fixtureRoot, "replace-attacker.index");
    const attackerEnvironment = { GIT_INDEX_FILE: attackerIndex };
    await repository.git(["read-tree", baseCommit], {
      environmentOverrides: attackerEnvironment,
    });
    await repository.git(["update-index", "--force-remove", "tracked-but-ignored.txt"], {
      environmentOverrides: attackerEnvironment,
    });
    const attackerTree: string = await repository.git(["write-tree"], {
      environmentOverrides: attackerEnvironment,
    });
    const attackerCommit: string = await repository.git(["commit-tree", attackerTree, "-m", "x"]);
    await repository.git(["update-ref", `refs/replace/${baseCommit}`, attackerCommit]);

    // IN-CASE NEGATIVE CONTROL, and it runs FIRST so the fixture is proven
    // hostile before the assertion that depends on it: an unpinned `read-tree` of
    // the very same base OID seeds from the replacement and the path is gone.
    const controlIndex: string = join(fixture.fixtureRoot, "replace-control.index");
    await repository.git(["read-tree", baseCommit], {
      environmentOverrides: { GIT_INDEX_FILE: controlIndex },
    });
    expect(
      await repository.git(["ls-files", "tracked-but-ignored.txt"], {
        environmentOverrides: { GIT_INDEX_FILE: controlIndex },
      }),
    ).toBe("");

    const captured: TurnSnapshotCaptured = await captureTurn(buildService());

    // Pinned, the capture seeds from the object it named, so the path is in the
    // snapshot — and the `add -A` equivalence the capture contract is stated in
    // survives a hostile replace ref.
    const snapshotTree: string = await repository.git([
      "rev-parse",
      `${captured.snapshotCommit}^{tree}`,
    ]);
    expect(await repository.git(["ls-tree", snapshotTree, "tracked-but-ignored.txt"])).toContain(
      "blob",
    );
    // The parent recorded is the id the service resolved, not the substitute.
    expect(captured.baseCommit).toBe(baseCommit);
  });

  it("captures under a host `core.safecrlf` that would otherwise make staging FATAL", async () => {
    const repository: FixtureRepository = fixture.repository;
    const service: TurnSnapshotService = buildService();
    // The project's own declaration — checked in, deliberately honored, and the
    // thing that gives the host's reversibility check something to object to. A
    // `core.safecrlf` with no attribute in play converts nothing and refuses
    // nothing.
    repository.write(".gitattributes", "*.txt text\n");
    await repository.git(["add", ".gitattributes"]);
    await repository.git(["commit", "-q", "-m", "in-tree attributes"]);
    await repository.git(["config", "core.safecrlf", "true"]);
    repository.write("crlf.txt", "line one\r\nline two\r\n");

    const captured: TurnSnapshotCaptured = await captureTurn(service);

    // What git ACTUALLY produced, read back rather than assumed: the in-tree
    // attribute still normalized the blob to LF, and the worktree still holds the
    // CRLF bytes the turn wrote. The pin removed the host's VETO, not the
    // project's conversion.
    const blob: FixtureGitResult = await repository.gitCapturing([
      "cat-file",
      "-p",
      `${captured.ref}^{tree}:crlf.txt`,
    ]);
    expect(blob.exitCode).toBe(0);
    expect(blob.stdout).toBe("line one\nline two\n");
    expect(readFileSync(join(repository.root, "crlf.txt"), "utf8")).toBe(
      "line one\r\nline two\r\n",
    );

    // NEGATIVE CONTROL: the same `update-index --add` conversion decision, pinned
    // exactly as the recipe pins it MINUS `core.safecrlf=false`, is fatal against
    // this fixture — so the capture above is a statement about the pin and not
    // about a host setting that was inert. Driven against a scratch index, so the
    // fixture's own index is untouched either way.
    const scratchIndexPath: string = join(fixture.fixtureRoot, "safecrlf.index");
    const scratchOverrides = { GIT_INDEX_FILE: scratchIndexPath, GIT_ATTR_NOSYSTEM: "1" };
    await repository.git(["read-tree", "HEAD"], { environmentOverrides: scratchOverrides });
    const stagingArgv: readonly string[] = [
      "-c",
      "core.autocrlf=false",
      "-c",
      "core.attributesFile=/dev/null",
      "update-index",
      "--add",
      "--",
      "crlf.txt",
    ];
    const unpinned: FixtureGitResult = await repository.gitCapturing(stagingArgv, {
      environmentOverrides: scratchOverrides,
    });
    expect(unpinned.exitCode).not.toBe(0);
    expect(unpinned.stderr).toContain("CRLF would be replaced by LF");
    // …and the ONE added pin is what closes it: capture availability stops
    // depending on host config.
    const pinned: FixtureGitResult = await repository.gitCapturing(
      ["-c", "core.safecrlf=false", ...stagingArgv],
      { environmentOverrides: scratchOverrides },
    );
    expect(pinned.exitCode).toBe(0);
  });

  it("returns the recorded OID and leaves the ref unmoved on a duplicate capture", async () => {
    const repository: FixtureRepository = fixture.repository;
    applyTurnEffects();
    const service: TurnSnapshotService = buildService();

    const first = expectCaptured(
      await service.captureTurnSnapshot({ ...CAPTURE_DEFAULTS, executionRoot: repository.root }),
    );

    // The DISCRIMINATING step: the worktree moves on between the two captures.
    // A duplicate capture over unchanged content would be satisfied by a service
    // that repointed the ref, because the new commit would hash identically.
    repository.write("created.txt", "content that arrived AFTER the first capture\n");

    const second = await service.captureTurnSnapshot({
      ...CAPTURE_DEFAULTS,
      executionRoot: repository.root,
    });

    expect(second).toEqual({
      outcome: "already-captured",
      ref: first.ref,
      snapshotCommit: first.snapshotCommit,
    });
    expect(await repository.git(["rev-parse", first.ref])).toBe(first.snapshotCommit);
    // Idempotent SUCCESS, not a failure: nothing was diagnosed.
    expect(fixture.diagnostics).toEqual([]);
  });

  it("mints a fresh ref for the same turn ordinal under a new epoch", async () => {
    const repository: FixtureRepository = fixture.repository;
    applyTurnEffects();
    const service: TurnSnapshotService = buildService();

    const epochZero = expectCaptured(
      await service.captureTurnSnapshot({ ...CAPTURE_DEFAULTS, executionRoot: repository.root }),
    );
    // A rollback happened: the run engine advanced the epoch and re-executed the
    // same position, whose content differs from the superseded attempt's.
    repository.write("created.txt", "re-executed after the rollback\n");
    const epochOne = expectCaptured(
      await service.captureTurnSnapshot({
        ...CAPTURE_DEFAULTS,
        epoch: 1,
        executionRoot: repository.root,
      }),
    );

    expect(epochOne.ref).toBe(`refs/sidekicks/runs/${RUN_ID}/epoch-1/turn-1`);
    expect(epochOne.snapshotCommit).not.toBe(epochZero.snapshotCommit);
    // The superseded epoch's ref SURVIVES, still naming its own tree: "mints a
    // distinct ref" is satisfiable by a service that clobbered the old one, so
    // the old one is what this asserts.
    expect(await repository.git(["rev-parse", epochZero.ref])).toBe(epochZero.snapshotCommit);
    expect(await repository.refListing("refs/sidekicks/")).toBe(
      `${epochZero.snapshotCommit} ${epochZero.ref}\n${epochOne.snapshotCommit} ${epochOne.ref}`,
    );
  });

  it("places the caller-supplied epoch in the ref verbatim", async () => {
    const repository: FixtureRepository = fixture.repository;
    applyTurnEffects();

    // `7` can only have come from the caller, which is the pure-callee property
    // and the "supplied, never derived".
    const result = expectCaptured(
      await buildService().captureTurnSnapshot({
        ...CAPTURE_DEFAULTS,
        epoch: 7,
        turnOrdinal: 12,
        executionRoot: repository.root,
      }),
    );

    expect(result.ref).toBe(`refs/sidekicks/runs/${RUN_ID}/epoch-7/turn-12`);
    expect(await repository.refListing("refs/sidekicks/")).toBe(
      `${result.snapshotCommit} ${result.ref}`,
    );
  });

  it("records the base resolved at entry as the parent when HEAD advances mid-capture", async () => {
    const repository: FixtureRepository = fixture.repository;
    applyTurnEffects();
    const base: string = await repository.git(["rev-parse", "HEAD"]);

    // The seam WRAPS the production runner: the capture is real, and the branch
    // moves between the `read-tree` leg and the `commit-tree` leg — exactly the
    // window in which passing symbolic `HEAD` to both legs would record an
    // old-HEAD tree under a new-HEAD parent.
    let advanced = false;
    const advancingRunner: TurnSnapshotGitRunner = async (argv, options) => {
      const result = await runTurnSnapshotGitWithExecFile(argv, options);
      if (!advanced && argv.includes("read-tree")) {
        advanced = true;
        await repository.git(["commit", "-q", "--allow-empty", "-m", "landed mid-capture"]);
      }
      return result;
    };

    const result = expectCaptured(
      await buildService({ git: advancingRunner }).captureTurnSnapshot({
        ...CAPTURE_DEFAULTS,
        executionRoot: repository.root,
      }),
    );

    expect(advanced).toBe(true);
    const movedHead: string = await repository.git(["rev-parse", "HEAD"]);
    expect(movedHead).not.toBe(base);
    // A later restore therefore draws the typed `head_moved` refusal instead of
    // anti-diffing the landed commit's files into the worktree.
    expect(result.baseCommit).toBe(base);
    expect(await repository.git(["rev-parse", `${result.ref}^`])).toBe(base);
    expect(await repository.git(["rev-parse", `${result.ref}^`])).not.toBe(movedHead);
  });

  it("reports an induced capture failure as a typed result plus a diagnostic, never a throw", async () => {
    const repository: FixtureRepository = fixture.repository;
    applyTurnEffects();
    const refsBefore: string = await repository.refListing();

    const failingRunner: TurnSnapshotGitRunner = async (argv, options) => {
      if (argv.includes("write-tree")) {
        throw new Error("induced write-tree failure");
      }
      return runTurnSnapshotGitWithExecFile(argv, options);
    };

    // No `rejects` wrapper anywhere: the assertion IS that this resolves. Capture
    // is not a turn gate, so the turn boundary must complete regardless.
    const result = await buildService({ git: failingRunner }).captureTurnSnapshot({
      ...CAPTURE_DEFAULTS,
      executionRoot: repository.root,
    });

    expect(result).toEqual({
      outcome: "failed",
      ref: `refs/sidekicks/runs/${RUN_ID}/epoch-0/turn-1`,
      failedStep: "write-tree",
    });
    expect(fixture.diagnostics).toHaveLength(1);
    const diagnostic: TurnSnapshotDiagnostic | undefined = fixture.diagnostics[0];
    expect(diagnostic?.kind).toBe("capture-failed");
    expect(diagnostic).toMatchObject({
      runId: RUN_ID,
      epoch: 0,
      turnOrdinal: 1,
      failedStep: "write-tree",
      detail: "induced write-tree failure",
    });
    // Nothing was published: a failed capture leaves the ref namespace untouched.
    expect(await repository.refListing()).toBe(refsBefore);
    // …and leaves no scratch index behind. The `finally` runs on the failure path
    // too, which is what keeps a daemon that fails captures from accumulating
    // index files in its own execution-roots directory forever.
    expect(readdirSync(join(fixture.executionRootsDirectory, ".snapshot-indexes"))).toEqual([]);
  });

  it("reports an update-ref failure as `write-ref` when no ref explains it", async () => {
    const repository: FixtureRepository = fixture.repository;
    applyTurnEffects();
    const refsBefore: string = await repository.refListing();

    // Only the compare-and-swap is induced to fail. The existence probe behind it
    // runs for REAL and finds nothing, because no ref was ever written — the
    // double-failure branch. Rethrowing is the only honest exit: reporting
    // `already-captured` here would hand a snapshot OID for a snapshot that does
    // not exist. (This case pins the rethrow and the `write-ref` cursor; the
    // probe's exact-read flags are defense in depth behind the runner's
    // exit-status check and `#requireObjectId`, per the service header.)
    let updateRefAttempts = 0;
    const failingRunner: TurnSnapshotGitRunner = async (argv, options) => {
      if (argv.includes("update-ref")) {
        updateRefAttempts += 1;
        throw new Error("induced update-ref failure");
      }
      return runTurnSnapshotGitWithExecFile(argv, options);
    };

    const result = await buildService({ git: failingRunner }).captureTurnSnapshot({
      ...CAPTURE_DEFAULTS,
      executionRoot: repository.root,
    });

    expect(updateRefAttempts).toBe(1);
    expect(result).toEqual({
      outcome: "failed",
      ref: `refs/sidekicks/runs/${RUN_ID}/epoch-0/turn-1`,
      failedStep: "write-ref",
    });
    expect(fixture.diagnostics).toHaveLength(1);
    expect(fixture.diagnostics[0]).toMatchObject({
      kind: "capture-failed",
      failedStep: "write-ref",
      detail: "induced update-ref failure",
    });
    // The tree and commit objects the failed capture minted are unreferenced and
    // `git gc`'s to collect; what matters is that the namespace gained nothing.
    expect(await repository.refListing()).toBe(refsBefore);
  });

  it("resolves when the diagnostic sink THROWS from inside the failure reporter", async () => {
    const repository: FixtureRepository = fixture.repository;
    applyTurnEffects();

    const failingRunner: TurnSnapshotGitRunner = async (argv, options) => {
      if (argv.includes("write-tree")) {
        throw new Error("induced write-tree failure");
      }
      return runTurnSnapshotGitWithExecFile(argv, options);
    };
    // The sink is called from INSIDE `#failCapture`, so an unguarded throw here
    // replaces the typed failure with a thrown one — an observability fault
    // escalated into a turn-blocking fault, which is the inversion the whole
    // never-throws contract exists to prevent.
    const observed: TurnSnapshotDiagnostic[] = [];
    const throwingSink = (diagnostic: TurnSnapshotDiagnostic): void => {
      observed.push(diagnostic);
      throw new Error("induced sink failure");
    };

    const result = await buildService({
      git: failingRunner,
      emitDiagnostic: throwingSink,
    }).captureTurnSnapshot({ ...CAPTURE_DEFAULTS, executionRoot: repository.root });

    // Not vacuous: the sink genuinely ran and genuinely threw.
    expect(observed).toHaveLength(1);
    expect(observed[0]?.kind).toBe("capture-failed");
    expect(result).toEqual({
      outcome: "failed",
      ref: `refs/sidekicks/runs/${RUN_ID}/epoch-0/turn-1`,
      failedStep: "write-tree",
    });
  });

  it("resolves when the diagnostic sink throws on the validate-inputs arm", async () => {
    const repository: FixtureRepository = fixture.repository;
    const refsBefore: string = await repository.refListing();

    // The validation arm is the one where the diagnostic IS the entire failure
    // channel — the typed result carries no `detail` — so it is also the arm
    // where a sink throw would be most tempting to let through. It reaches the
    // sink before a single git process is spawned.
    let sinkCalls = 0;
    const throwingSink = (): void => {
      sinkCalls += 1;
      throw new Error("induced sink failure");
    };

    const result = await buildService({ emitDiagnostic: throwingSink }).captureTurnSnapshot({
      ...CAPTURE_DEFAULTS,
      runId: "../../heads/main",
      executionRoot: repository.root,
    });

    expect(sinkCalls).toBe(1);
    expect(result).toEqual({ outcome: "failed", ref: null, failedStep: "validate-inputs" });
    expect(await repository.refListing()).toBe(refsBefore);
  });

  it("resolves when the diagnostic sink is async and its promise REJECTS", async () => {
    const repository: FixtureRepository = fixture.repository;
    applyTurnEffects();

    const failingRunner: TurnSnapshotGitRunner = async (argv, options) => {
      if (argv.includes("write-tree")) {
        throw new Error("induced write-tree failure");
      }
      return runTurnSnapshotGitWithExecFile(argv, options);
    };
    // No cast: a promise-returning function IS assignable to the seam's
    // `(diagnostic) => void`, which is exactly the hazard. An OTel exporter with
    // a transient failure rejects a promise nobody holds, and Node's default
    // `--unhandled-rejections=throw` takes the daemon down by a path no `try`
    // around the call can see.
    const observed: TurnSnapshotDiagnostic[] = [];
    const rejectingSink = (diagnostic: TurnSnapshotDiagnostic): Promise<void> => {
      observed.push(diagnostic);
      return Promise.reject(new Error("induced exporter failure"));
    };

    const result = await buildService({
      git: failingRunner,
      emitDiagnostic: rejectingSink,
    }).captureTurnSnapshot({ ...CAPTURE_DEFAULTS, executionRoot: repository.root });

    // An escaped rejection is reported OUTSIDE any case and fails the run with a
    // non-zero exit (verified against an unguarded build), so surviving the
    // macrotask below is the containment assertion — the case itself would still
    // read as passing. The rest just proves it wasn't vacuous.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(observed).toHaveLength(1);
    expect(result).toEqual({
      outcome: "failed",
      ref: `refs/sidekicks/runs/${RUN_ID}/epoch-0/turn-1`,
      failedStep: "write-tree",
    });
  });

  it("removes the scratch index after a successful capture", async () => {
    const repository: FixtureRepository = fixture.repository;
    applyTurnEffects();

    await buildService().captureTurnSnapshot({
      ...CAPTURE_DEFAULTS,
      executionRoot: repository.root,
    });

    // The temp index lives OUTSIDE the worktree by construction — a
    // worktree-resident one would surface to this very pipeline's `ls-files -o`
    // listing as stray untracked content — and does not outlive its capture.
    expect(readdirSync(join(fixture.executionRootsDirectory, ".snapshot-indexes"))).toEqual([]);
    expect(existsSync(join(repository.root, ".snapshot-indexes"))).toBe(false);
    expect(await repository.git(["status", "--porcelain", "--ignored=no"])).not.toContain(
      "snapshot-index",
    );
  });

  it("leaves the execution root's OWN index untouched, staged work included", async () => {
    const repository: FixtureRepository = fixture.repository;
    applyTurnEffects();
    // The user's staging area, mid-turn: a staged modification and a staged
    // addition, neither committed. This is the state the out-of-worktree index
    // exists to protect, and the state every other case in this file leaves
    // EMPTY — which is why they would all still pass if `GIT_INDEX_FILE` stopped
    // reaching the index-touching legs. The pipeline would then run `read-tree`
    // against the real index, produce the IDENTICAL snapshot OID, and silently
    // discard the user's staged work.
    await repository.git(["add", "tracked.txt", "created.txt"]);
    const statusBefore: string = await repository.git(["status", "--porcelain"]);
    const stagedBefore: string = await repository.git(["diff", "--cached", "--name-only"]);
    // The fixture is genuinely in the state the assertion needs — otherwise the
    // byte-equality below would hold trivially for an empty index.
    expect(stagedBefore).toBe("created.txt\ntracked.txt");
    expect(statusBefore).toContain("M  tracked.txt");
    expect(statusBefore).toContain("A  created.txt");

    const result = expectCaptured(
      await buildService().captureTurnSnapshot({
        ...CAPTURE_DEFAULTS,
        executionRoot: repository.root,
      }),
    );

    expect(await repository.git(["status", "--porcelain"])).toBe(statusBefore);
    expect(await repository.git(["diff", "--cached", "--name-only"])).toBe(stagedBefore);
    // …and the snapshot happened anyway, from the same worktree. Untouched index,
    // captured state — the two claims are only interesting together.
    expect(await repository.git(["rev-parse", result.ref])).toBe(result.snapshotCommit);
  });

  it("reports a scratch-index directory it cannot create as its own step", async () => {
    const repository: FixtureRepository = fixture.repository;
    applyTurnEffects();
    const snapshotIndexDirectory: string = join(
      fixture.executionRootsDirectory,
      ".snapshot-indexes",
    );

    // An EACCES on the daemon's OWN execution-roots directory. The step cursor
    // has to name this leg rather than the first git one: reported as
    // `resolve-base`, it would send an operator to look at the repository —
    // which is fine — while the actual fault is in a directory the repository
    // has nothing to do with.
    const failingFilesystem: TurnSnapshotFilesystem = {
      createDirectory(path: string): Promise<void> {
        if (path === snapshotIndexDirectory) {
          return Promise.reject(new Error("EACCES: permission denied, mkdir"));
        }
        mkdirSync(path, { recursive: true });
        return Promise.resolve();
      },
      removePath(): Promise<void> {
        return Promise.resolve();
      },
    };

    const result = await buildService({ filesystem: failingFilesystem }).captureTurnSnapshot({
      ...CAPTURE_DEFAULTS,
      executionRoot: repository.root,
    });

    expect(result).toEqual({
      outcome: "failed",
      ref: `refs/sidekicks/runs/${RUN_ID}/epoch-0/turn-1`,
      failedStep: "prepare-scratch-index" satisfies TurnSnapshotCaptureStep,
    });
    expect(fixture.diagnostics).toHaveLength(1);
    expect(fixture.diagnostics[0]).toMatchObject({
      kind: "capture-failed",
      failedStep: "prepare-scratch-index",
      detail: "EACCES: permission denied, mkdir",
    });
  });

  it("still resolves when the scratch-index cleanup fails on the SUCCESS arm", async () => {
    const repository: FixtureRepository = fixture.repository;
    applyTurnEffects();
    const cleanupFailure = new Error("EPERM: operation not permitted, unlink");

    // The `finally` is the one statement outside the failure funnel: a rejection
    // there — an antivirus scanner holding the file, a filesystem seam that
    // throws — would replace the typed result and break the never-throws
    // contract from the one line written to be inconsequential.
    const result = expectCaptured(
      await buildService({
        filesystem: buildRemoveFailingFilesystem(cleanupFailure),
      }).captureTurnSnapshot({
        ...CAPTURE_DEFAULTS,
        executionRoot: repository.root,
      }),
    );

    // The capture is intact: the ref is written and the reported OID is on disk.
    expect(await repository.git(["rev-parse", result.ref])).toBe(result.snapshotCommit);
    // The injection was NOT inert — the scratch index really did survive, which
    // is what makes the resolution above a statement about the `finally` rather
    // than about a cleanup that quietly succeeded.
    expect(readdirSync(join(fixture.executionRootsDirectory, ".snapshot-indexes"))).toHaveLength(1);
    // Best-effort, but never silent: an undeletable scratch index is reported.
    expect(fixture.diagnostics).toHaveLength(1);
    expect(fixture.diagnostics[0]).toMatchObject({
      kind: "scratch-index-cleanup-failed",
      runId: RUN_ID,
      epoch: 0,
      turnOrdinal: 1,
      detail: cleanupFailure.message,
    });
  });

  it("preserves the typed failure when the scratch-index cleanup ALSO fails", async () => {
    const repository: FixtureRepository = fixture.repository;
    applyTurnEffects();
    const cleanupFailure = new Error("EBUSY: resource busy or locked, unlink");
    const failingRunner: TurnSnapshotGitRunner = async (argv, options) => {
      if (argv.includes("write-tree")) {
        throw new Error("induced write-tree failure");
      }
      return runTurnSnapshotGitWithExecFile(argv, options);
    };

    // The worst arm: the capture already failed, the diagnostic was already
    // emitted, and the report is sitting in the return value when cleanup throws
    // on the way out. An unguarded `finally` discards BOTH.
    const result = await buildService({
      git: failingRunner,
      filesystem: buildRemoveFailingFilesystem(cleanupFailure),
    }).captureTurnSnapshot({
      ...CAPTURE_DEFAULTS,
      executionRoot: repository.root,
    });

    expect(result).toEqual({
      outcome: "failed",
      ref: `refs/sidekicks/runs/${RUN_ID}/epoch-0/turn-1`,
      failedStep: "write-tree",
    });
    // Both conditions reported, in the order they happened, neither swallowing
    // the other.
    expect(fixture.diagnostics.map((diagnostic) => diagnostic.kind)).toEqual([
      "capture-failed",
      "scratch-index-cleanup-failed",
    ]);
  });

  it("refuses every unusable ref component before any git call", async () => {
    const repository: FixtureRepository = fixture.repository;
    applyTurnEffects();
    const refsBefore: string = await repository.refListing();

    const invocations: string[][] = [];
    const recordingRunner: TurnSnapshotGitRunner = buildRecordingRunner(invocations);

    // Table-driven, because the guard is a DISJUNCTION: a suite that drove only
    // the `runId` arm would let the epoch and ordinal arms be deleted without a
    // single failure. The first row is the invariant's own case — a `runId`
    // that would name a BRANCH — and the rest are the shapes that would
    // interpolate a nonsense segment into the ref path.
    const rows: readonly {
      readonly label: string;
      readonly overrides: {
        readonly runId?: string;
        readonly epoch?: number;
        readonly turnOrdinal?: number;
      };
    }[] = [
      { label: "runId escaping the namespace", overrides: { runId: "../../heads/main" } },
      { label: "runId with a path separator", overrides: { runId: "run/1" } },
      { label: "runId with a leading dash", overrides: { runId: "-run" } },
      { label: "empty runId", overrides: { runId: "" } },
      { label: "runId with a reflog spelling", overrides: { runId: "run@{0}" } },
      // The DOT shapes the character class alone admitted. The first two are
      // refused by git as well — measured on git 2.50.1, `check-ref-format` and
      // `update-ref` both refuse `refs/sidekicks/runs/run..1/epoch-0/turn-1` and
      // the `run.lock` spelling — but they are refused HERE because a refusal
      // arriving from git is a swallowed capture failure rather than a typed one,
      // which is the same reason the escaping spelling above does not rely on it.
      { label: "runId with consecutive dots", overrides: { runId: "run..1" } },
      { label: "runId with a .lock suffix", overrides: { runId: "run.lock" } },
      // These two git ACCEPTS (measured on git 2.50.1: both refs are created), so
      // each is this module's own narrowing rather than an echo of a git rule —
      // a trailing dot because Win32 strips it from a path component, so `run.`
      // and `run` would share one loose-ref directory, and `.LOCK` because git's
      // rule is case-sensitive while APFS and NTFS are not, so the directory
      // would be the path of a sibling ref's own lock file.
      { label: "runId with a trailing dot", overrides: { runId: "run." } },
      { label: "runId with an upper-case .LOCK suffix", overrides: { runId: "run.LOCK" } },
      { label: "negative epoch", overrides: { epoch: -1 } },
      { label: "fractional epoch", overrides: { epoch: 1.5 } },
      { label: "negative turn ordinal", overrides: { turnOrdinal: -3 } },
      { label: "non-numeric turn ordinal", overrides: { turnOrdinal: Number.NaN } },
    ];

    for (const [index, row] of rows.entries()) {
      const result = await buildService({ git: recordingRunner }).captureTurnSnapshot({
        ...CAPTURE_DEFAULTS,
        ...row.overrides,
        executionRoot: repository.root,
      });
      expect(result, row.label).toEqual({
        outcome: "failed",
        ref: null,
        failedStep: "validate-inputs",
      });
      expect(fixture.diagnostics, row.label).toHaveLength(index + 1);
      expect(fixture.diagnostics[index], row.label).toMatchObject({
        kind: "capture-failed",
        ref: null,
        failedStep: "validate-inputs",
      });
    }

    // BEFORE any git call — git's own `check-ref-format` would also refuse the
    // escaping spelling, but a refusal arriving from git is a capture failure
    // this service swallows into a diagnostic, so the namespace guard cannot be
    // delegated to it.
    expect(invocations).toEqual([]);
    expect(await repository.refListing()).toBe(refsBefore);
  });

  it("still accepts run ids that only RESEMBLE the refused dot shapes", async () => {
    const repository: FixtureRepository = fixture.repository;
    applyTurnEffects();

    // The over-narrowing control for the four dot rows above. Each of these is
    // accepted by `git check-ref-format` (measured on git 2.50.1) and must stay
    // accepted here: a predicate that refused `.lock` as a SUBSTRING, or every
    // dot outright, would pass the refusal rows while quietly breaking callers.
    // Driven as real captures rather than against the predicate, so the evidence
    // is a ref that exists at the spelled path.
    const acceptedRunIds: readonly string[] = [
      "a.lock.b", // `.lock` present, but not as the suffix
      "run.l", // a prefix of the reserved suffix
      "run-1_2.3", // the full punctuation alphabet, dots included
      RUN_ID, // the shape production actually issues — a UUIDv7
    ];

    for (const [index, runId] of acceptedRunIds.entries()) {
      const captured: TurnSnapshotCaptured = expectCaptured(
        await buildService().captureTurnSnapshot({
          ...CAPTURE_DEFAULTS,
          runId,
          turnOrdinal: index + 1,
          executionRoot: repository.root,
        }),
      );
      expect(captured.ref, runId).toBe(`refs/sidekicks/runs/${runId}/epoch-0/turn-${index + 1}`);
      expect(await repository.git(["rev-parse", captured.ref]), runId).toBe(
        captured.snapshotCommit,
      );
    }
    expect(fixture.diagnostics).toEqual([]);
  });

  it("reports a clock that is not an ISO instant as a commit-tree failure", async () => {
    const repository: FixtureRepository = fixture.repository;
    applyTurnEffects();
    const refsBefore: string = await repository.refListing();

    // The injected clock is the one input that can be wrong without git being
    // wrong. Stamping an `Invalid Date` would mint a commit git accepts and
    // nobody can reason about, so the recipe refuses instead — and refuses the
    // way every other failure does, through the funnel.
    const result = await buildService({ now: () => "not-an-instant" }).captureTurnSnapshot({
      ...CAPTURE_DEFAULTS,
      executionRoot: repository.root,
    });

    expect(result).toEqual({
      outcome: "failed",
      ref: `refs/sidekicks/runs/${RUN_ID}/epoch-0/turn-1`,
      failedStep: "commit-tree" satisfies TurnSnapshotCaptureStep,
    });
    expect(fixture.diagnostics).toHaveLength(1);
    expect(fixture.diagnostics[0]).toMatchObject({
      kind: "capture-failed",
      failedStep: "commit-tree",
      detail: "turn-snapshot clock did not return an ISO-8601 instant",
    });
    expect(await repository.refListing()).toBe(refsBefore);
    expect(readdirSync(join(fixture.executionRootsDirectory, ".snapshot-indexes"))).toEqual([]);
  });

  it("renders to console.warn when no diagnostic sink is injected", async () => {
    const repository: FixtureRepository = fixture.repository;
    applyTurnEffects();
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {
      /* the rendering is the assertion; the output is not wanted in the run */
    });

    // Built WITHOUT `emitDiagnostic`, which every other case injects — so the
    // default sink is exercised rather than described. TRIPWIRE: this is the
    // interim `console.warn` standing in for the OTel diagnostic names; when
    // the daemon grows a telemetry substrate, this case moves to it.
    const service = new TurnSnapshotService({
      executionRootsDirectory: fixture.executionRootsDirectory,
      now: () => FIXED_INSTANT,
    });
    const result = await service.captureTurnSnapshot({
      ...CAPTURE_DEFAULTS,
      runId: "../../heads/main",
      executionRoot: repository.root,
    });

    expect(result.outcome).toBe("failed");
    expect(warnings).toHaveBeenCalledTimes(1);
    expect(warnings).toHaveBeenCalledWith(
      "turn-snapshot capture-failed: run=../../heads/main epoch=0 turn=1",
      expect.objectContaining({
        kind: "capture-failed",
        failedStep: "validate-inputs",
        ref: null,
      }),
    );
  });

  it("pins its roster to the service's exported strip list — set equality both ways", () => {
    // The behavioral case below asserts on TWO variables — `GIT_DIR` and
    // `GIT_OBJECT_DIRECTORY`, the ones that demonstrably bite; `GIT_NAMESPACE`
    // is stubbed alongside them and deliberately asserted nothing about. Set
    // equality is what keeps the other nine from going silently unasserted: a
    // key added to the service's list and to nothing else fails here, and a key
    // dropped from it fails here too. The two spellings stay independent, so
    // neither side can drift alone.
    expect([...EXPECTED_NEUTRALIZED_GIT_ENV_KEYS].sort()).toStrictEqual(
      [...SNAPSHOT_NEUTRALIZED_GIT_ENV_KEYS].sort(),
    );
  });

  it("captures into the execution root under a hijacked ambient environment", async () => {
    const repository: FixtureRepository = fixture.repository;
    applyTurnEffects();
    const decoyRepository: string = join(fixture.fixtureRoot, "decoy.git");
    const hijackedObjectDirectory: string = join(fixture.fixtureRoot, "hijacked-objects");
    await repository.git(["init", "-q", "--bare", "-b", "main", decoyRepository], {
      cwd: fixture.fixtureRoot,
    });

    // The environment is the channel no ref-path validation can reach, and the
    // variables below are the ones that DEMONSTRABLY bite (all confirmed on git
    // 2.50.1, `-C <root>` notwithstanding):
    //
    //   * `GIT_DIR` wins over `-C`: `rev-parse --verify HEAD` resolves the decoy
    //     repository's HEAD and `write-tree` reports the decoy's index, so an
    //     unstripped one writes a correctly-spelled snapshot ref into a store
    //     the caller never named;
    //   * `GIT_OBJECT_DIRECTORY` set without `GIT_DIR` makes git refuse
    //     discovery outright (`not a git repository`, exit 128) — an unstripped
    //     one is a daemon that captures nothing at all.
    //
    // `GIT_NAMESPACE` rides along and is asserted NOTHING about, deliberately:
    // local ref plumbing ignores it (a namespaced `update-ref` writes the
    // unprefixed path and reads back from a clean environment), so a case that
    // claimed the strip was what kept the ref out of `refs/namespaces/` would
    // pass whether or not the strip happened. It is stubbed only to prove it is
    // harmless in the mix.
    let result: TurnSnapshotCaptureResult;
    try {
      vi.stubEnv("GIT_DIR", decoyRepository);
      vi.stubEnv("GIT_OBJECT_DIRECTORY", hijackedObjectDirectory);
      vi.stubEnv("GIT_NAMESPACE", "hijacked");
      result = await buildService().captureTurnSnapshot({
        ...CAPTURE_DEFAULTS,
        executionRoot: repository.root,
      });
    } finally {
      // Restored before the assertions, so the fixture's own reads below are
      // never themselves running under the hijack.
      vi.unstubAllEnvs();
    }

    const captured = expectCaptured(result);
    expect(captured.ref).toBe(`refs/sidekicks/runs/${RUN_ID}/epoch-0/turn-1`);
    // In the EXECUTION ROOT's repository, resolving to the reported OID…
    expect(await repository.refListing("refs/sidekicks/")).toBe(
      `${captured.snapshotCommit} ${captured.ref}`,
    );
    expect(await repository.git(["cat-file", "-t", captured.snapshotCommit])).toBe("commit");
    // …and nowhere else: the decoy has no refs at all, and the hijacked object
    // store was never even created.
    expect(
      await repository.git(["--git-dir", decoyRepository, "for-each-ref", "--format=%(refname)"]),
    ).toBe("");
    expect(existsSync(hijackedObjectDirectory)).toBe(false);
  });

  it("never touches refs/heads when a DANGLING symref squats the capture path", async () => {
    const repository: FixtureRepository = fixture.repository;
    applyTurnEffects();

    // The create side's own symref channel, and the one the create-only CAS does
    // NOT cover: git splits a symbolic-ref update into an update of its referent
    // and moves the must-not-exist check there, so "this ref must not exist"
    // stops being a statement about the validated name. A LIVE referent refuses
    // either way; a DANGLING one is the hole. The turn path is predictable from
    // inside the run, so it can be squatted before the capture that will use it.
    const squattedRef = `refs/sidekicks/runs/${RUN_ID}/epoch-0/turn-1`;
    const hostileBranch = "refs/heads/evil";
    await repository.git(["symbolic-ref", squattedRef, hostileBranch]);
    const headsBefore: string = await repository.refListing("refs/heads/");
    // Non-vacuity: the target really is dangling, which is the whole precondition
    // — against an EXISTING branch the CAS refuses and this case proves nothing.
    expect(headsBefore).not.toContain(hostileBranch);
    expect(
      (await repository.gitCapturing(["rev-parse", "--verify", hostileBranch])).exitCode,
    ).not.toBe(0);

    const result: TurnSnapshotCaptureResult = await buildService().captureTurnSnapshot({
      ...CAPTURE_DEFAULTS,
      executionRoot: repository.root,
    });

    // FIRST and UNBRANCHED, because it is the one claim that does not depend on
    // which git is running — and because it is the assertion that kills a dropped
    // `--no-deref` on every version. Unflagged, this same create writes
    // `refs/heads/evil` at the snapshot commit and exits 0 (git transfers the
    // must-not-exist check to the referent), reporting a successful capture: a
    // daemon write outside the namespace, silent. Measured unflagged on BOTH of
    // the git versions named below, so the mutant lands on the `captured` arm on
    // either one — moved inside that arm, these two assertions would let it
    // survive on the other.
    expect(await repository.refListing("refs/heads/")).toBe(headsBefore);
    expect(
      (await repository.gitCapturing(["rev-parse", "--verify", hostileBranch])).exitCode,
    ).not.toBe(0);

    // What the FLAGGED create then DOES with the squatted name is git-version
    // dependent, and the outcome tag is the only thing that splits:
    //
    //   * git 2.50.1 — the local suite's version, which drives the `captured` arm.
    //     The create succeeds: the write lands on the validated in-namespace name,
    //     replacing the planted pointer with an ordinary snapshot ref, and branch
    //     history never learns the ref existed.
    //   * git 2.54.0 — CI's version, which drives the `failed` arm. The same
    //     flagged create REFUSES over a dangling in-namespace symref (the
    //     refs-transaction hardening whose lineage is git 2.52's fix for `fetch`
    //     clobbering dangling symrefs). The service catches the refusal, its
    //     existence probe reads nothing back — a dangling symref does not resolve
    //     for `show-ref --verify` — and the rethrow reaches the funnel as the
    //     typed `failed` at `write-ref`.
    //
    // Both arms are accepted here because both PRESERVE the invariant: a squatted
    // capture path that refuses fail-closed with a diagnostic, leaving the turn to
    // proceed, is the capture-never-blocks-the-turn posture, not a breach.
    if (result.outcome === "captured") {
      const captured = expectCaptured(result);
      // The invariant as a whole-repository claim, not a per-branch one: every ref
      // this capture produced is inside the run's own namespace.
      // (`for-each-ref` sorts by refname, so `refs/heads/…` precedes `refs/sidekicks/…`.)
      expect(await repository.refListing()).toBe(
        `${headsBefore}\n${captured.snapshotCommit} ${squattedRef}`,
      );
      // And the capture is TRUTHFUL rather than merely safe — the reported ref
      // really does hold the reported snapshot commit.
      expect(captured.ref).toBe(squattedRef);
      expect(await repository.git(["rev-parse", "--verify", squattedRef])).toBe(
        captured.snapshotCommit,
      );
      expect(fixture.diagnostics).toEqual([]);
    } else {
      // The WHOLE typed shape, so a third outcome fails here rather than passing
      // through this arm unexamined — an `already-captured` above all, which would
      // mean the existence probe had fabricated an OID for a snapshot that was
      // never written.
      expect(result).toEqual({
        outcome: "failed",
        ref: squattedRef,
        failedStep: "write-ref" satisfies TurnSnapshotCaptureStep,
      });
      // A refusal is a REFUSAL, not a half-write: the planted pointer survives
      // exactly as planted. Read back with `symbolic-ref` rather than the listing
      // helper every other assertion in this case uses — `for-each-ref` OMITS a
      // dangling symref entirely, so a listing claim about the survivor would be
      // vacuous.
      expect(await repository.git(["symbolic-ref", squattedRef])).toBe(hostileBranch);
      // …and for that same reason the whole-repository listing is `refs/heads/`
      // alone: no snapshot ref was written, and the survivor is invisible to it.
      expect(await repository.refListing()).toBe(headsBefore);
      // Diagnosed rather than silent, and carrying the step that failed. The
      // detail is Node's echoed argv followed by git's stderr, so it is asserted on
      // the ARGV token: pinning git's refusal wording would re-break on the next
      // version that rewords it.
      expect(fixture.diagnostics).toHaveLength(1);
      expect(fixture.diagnostics[0]).toMatchObject({
        kind: "capture-failed",
        runId: RUN_ID,
        epoch: 0,
        turnOrdinal: 1,
        ref: squattedRef,
        failedStep: "write-ref",
      });
      expect((fixture.diagnostics[0] as { readonly detail: string }).detail).toContain(
        "update-ref",
      );
    }
  });

  it("prepends the hook-neutralization flags to every invocation", async () => {
    const repository: FixtureRepository = fixture.repository;
    applyTurnEffects();
    await createEmbeddedRepository("embedded");

    const invocations: string[][] = [];
    const recordingRunner: TurnSnapshotGitRunner = buildRecordingRunner(invocations);

    expectCaptured(
      await buildService({ git: recordingRunner }).captureTurnSnapshot({
        ...CAPTURE_DEFAULTS,
        executionRoot: repository.root,
      }),
    );

    // Structural, not per-call-site: the quantifier holds because there is one
    // private entry point, so this asserts the WHOLE recorded set — including the
    // invocation the normalization pass makes inside the embedded repository.
    expect(invocations.length).toBeGreaterThan(1);
    const neutralizationDirectory: string = join(
      fixture.executionRootsDirectory,
      ".hook-neutralization",
    );
    for (const argv of invocations) {
      expect(argv.slice(0, 4)).toEqual([
        "-c",
        `core.hooksPath=${neutralizationDirectory}`,
        "-c",
        "core.fsmonitor=false",
      ]);
    }
    // The directory the flag points at exists and is EMPTY — an empty directory
    // is the mechanism, not the path alone.
    expect(readdirSync(neutralizationDirectory)).toEqual([]);
  });

  // Mode bits need POSIX.
  const itOnPosix = it.skipIf(process.platform === "win32");

  itOnPosix(
    "CHARACTERIZES the honored core.fileMode residual — a turn-created exec bit is LOST",
    async () => {
      const repository: FixtureRepository = fixture.repository;
      applyTurnEffects();
      // NOT a blessing of this outcome, and not a bug either — the same posture
      // as the sparse residual case. The service's header honors
      // `core.fileMode` as probe-written capability config, and records THIS as
      // the residual that honoring costs. A residual asserted only in prose is
      // one that silently changes.
      repository.write("build.sh", "#!/bin/sh\necho build\n");
      chmodSync(join(repository.root, "build.sh"), 0o755);
      await repository.git(["config", "core.fileMode", "false"]);

      const captured: TurnSnapshotCaptured = await captureTurn(buildService());

      // The bit is gone from the snapshot: a file the turn CREATED is staged
      // from a mode git was told not to trust.
      expect(await repository.git(["ls-tree", `${captured.ref}^{tree}`, "build.sh"])).toContain(
        "100644 blob",
      );

      // IN-CASE PORCELAIN CONTROL, and the whole reason this is a residual and
      // not a defect: `git add -A` under the SAME host config records exactly
      // the same `100644`. asks for add -A tree equivalence, so honoring the
      // knob keeps the contract while pinning it `true` would have broken it —
      // see this describe's tracked-file case for the half that pin got wrong.
      const porcelainTree: string = await repository.porcelainAddAllTree(
        join(fixture.fixtureRoot, "filemode-created.index"),
      );
      expect(await repository.git(["ls-tree", porcelainTree, "build.sh"])).toContain("100644 blob");
    },
  );

  itOnPosix(
    "honors a TRACKED file's recorded 100755 under core.fileMode=false, as add -A does",
    async () => {
      const repository: FixtureRepository = fixture.repository;
      // The discriminating half, and the cell that reversed this knob's
      // disposition: the file is EXECUTABLE IN THE BASE COMMIT, so its mode is a
      // recorded fact rather than a disk observation.
      repository.write("tool.sh", "#!/bin/sh\necho tool\n");
      chmodSync(join(repository.root, "tool.sh"), 0o755);
      await repository.git(["add", "-A"]);
      await repository.git(["commit", "-q", "-m", "exec base"]);
      expect(await repository.git(["ls-tree", "HEAD", "tool.sh"])).toContain("100755 blob");

      applyTurnEffects();
      // The turn drops the bit on disk, and the host says disk modes are not to
      // be trusted. Under `false` git believes the RECORD, not the disk.
      chmodSync(join(repository.root, "tool.sh"), 0o644);
      await repository.git(["config", "core.fileMode", "false"]);

      const captured: TurnSnapshotCaptured = await captureTurn(buildService());

      // A `-c core.fileMode=true` pin on the staging leg records `100644` here —
      // the seeded scratch index carries no stat data, so `update-index`
      // re-stats every path and the pin makes lstat outrank the base commit's
      // recorded mode. That is a recorded exec bit destroyed for a file the turn
      // never meant to change, which is why the pin came out.
      expect(await repository.git(["ls-tree", `${captured.ref}^{tree}`, "tool.sh"])).toContain(
        "100755 blob",
      );

      // The porcelain control, again the standard the capture is held to: under
      // the same host config `git add -A` also keeps `100755`, so the honored
      // knob leaves capture and porcelain agreeing in BOTH directions — the
      // created-file cell above and the tracked-file cell here.
      const porcelainTree: string = await repository.porcelainAddAllTree(
        join(fixture.fixtureRoot, "filemode-tracked.index"),
      );
      expect(await repository.git(["ls-tree", porcelainTree, "tool.sh"])).toContain("100755 blob");
    },
  );
});

// ----------------------------------------------------------------------------
// ----------------------------------------------------------------------------
//
// The sparse cases need one thing the rest of this suite does not: a way to put
// a repository into a sparse state that is NOT cone mode, because the closure's
// oracle claim is about git's whole sparsity matcher and cone mode exercises the
// easy half of it. `sparse-checkout set --no-cone` is deprecated-but-present on
// every git this project supports; the fixtures below write
// `$GIT_DIR/info/sparse-checkout` and set the bits directly instead, which is
// both what `--no-cone` does and what a repository configured by some other tool
// looks like — the state the daemon actually has to survive.

/**
 * Put `repository` into a NON-CONE sparse state with the given patterns, then
 * make the worktree match.
 *
 * `read-tree -mu HEAD` is git's own way of applying a changed sparse definition
 * to the working tree: it re-projects the current tree through the new patterns,
 * materializing what is now in and removing what is now out. Doing it this way
 * rather than through `sparse-checkout set` is what keeps `core.sparseCheckoutCone`
 * genuinely false — the porcelain rewrites the patterns into cone form.
 */
async function applyNonConeSparseDefinition(
  repository: FixtureRepository,
  patterns: readonly string[],
): Promise<void> {
  const gitDirectory: string = await repository.git(["rev-parse", "--absolute-git-dir"]);
  mkdirSync(join(gitDirectory, "info"), { recursive: true });
  writeFileSync(join(gitDirectory, "info", "sparse-checkout"), `${patterns.join("\n")}\n`);
  await repository.git(["config", "core.sparseCheckout", "true"]);
  await repository.git(["config", "core.sparseCheckoutCone", "false"]);
  await repository.git(["read-tree", "-mu", "HEAD"]);
}

/**
 * The single assertion every porcelain-equivalence arm makes: the tree the
 * service captured IS the tree `git add -A` would stage from this worktree under
 * the same config.
 *
 * A COMPARATIVE assertion rather than a literal path list, and that is the
 * suite's existing `core.fileMode` idiom applied to a knob whose behavior is
 * genuinely git's to define. A literal expectation would encode this suite's
 * model of what a given sparse definition admits — the very reimplementation the
 * service refuses to do — and would go version-fragile the moment git changed a
 * matcher corner.
 */
async function expectCapturePorcelainEquivalent(
  repository: FixtureRepository,
  captured: TurnSnapshotCaptured,
  scratchIndexName: string,
): Promise<void> {
  expect(await repository.git(["rev-parse", `${captured.ref}^{tree}`])).toBe(
    await repository.porcelainAddAllTree(join(fixture.fixtureRoot, scratchIndexName)),
  );
}

/**
 * The `Sparse-Boundary-Paths:` trailer's recorded PATHS as bytes, or `null` when
 * the snapshot carries no such trailer.
 *
 * BYTES, because the trailer records `latin1` byte keys and asserting on the
 * decoded strings would assert on this helper's decode rather than on what the
 * capture preserved. The chain here is the production one exactly — the commit
 * object is UTF-8 text, `JSON.parse` recovers one code point per path byte, and
 * `latin1` turns those back into the bytes git emitted.
 *
 * Read through the SERVICE's runner rather than through {@link FixtureRepository},
 * whose `git` spawns with `encoding: "utf8"` and would mangle exactly the byte
 * sequences these arms exist to measure.
 */
async function readSparseBoundaryTrailerBytes(
  repository: FixtureRepository,
  snapshotCommit: string,
): Promise<readonly Buffer[] | null> {
  const body: Buffer = (
    await runTurnSnapshotGitWithExecFile(
      ["-C", repository.root, "cat-file", "commit", snapshotCommit],
      { timeoutMs: FIXTURE_GIT_TIMEOUT_MS },
    )
  ).stdout;
  for (const line of body.toString("utf8").split("\n")) {
    if (line.startsWith("Sparse-Boundary-Paths:")) {
      const recorded = JSON.parse(
        line.slice("Sparse-Boundary-Paths:".length).trim(),
      ) as readonly string[];
      return recorded.map((pathKey) => Buffer.from(pathKey, "latin1"));
    }
  }
  return null;
}

/**
 * The same trailer read as TEXT, for the arms whose paths are plain ASCII.
 *
 * ASCII is where the byte keys and their decoding coincide, so these arms stay
 * readable; anything non-ASCII must go through
 * {@link readSparseBoundaryTrailerBytes}, which is the assertion that actually
 * pins the format.
 */
async function readSparseBoundaryTrailer(
  repository: FixtureRepository,
  snapshotCommit: string,
): Promise<readonly string[] | null> {
  const recorded: readonly Buffer[] | null = await readSparseBoundaryTrailerBytes(
    repository,
    snapshotCommit,
  );
  return recorded === null ? null : recorded.map((pathBytes) => pathBytes.toString("utf8"));
}

/**
 * A git seam that fails ONE leg, identified by a predicate over the argv, with a
 * rejection carrying `stderr` exactly as the production runner does.
 *
 * This is how the below-2.41 floor is driven. Requiring an old git binary would
 * make the case unrunnable on every machine that has a current one — including
 * CI, which runs 2.54 — so what is under test is the SERVICE's disposition of an
 * unknown-subcommand failure, which is a claim about this module and is fully
 * observable through the seam. The seam is WRAPPED, not replaced: every other leg
 * really runs, so the failure lands in a genuine pipeline.
 */
function buildLegFailingRunner(
  matches: (argv: readonly string[]) => boolean,
  message: string,
): TurnSnapshotGitRunner {
  return async (argv, options) => {
    if (matches(argv)) {
      return Promise.reject(Object.assign(new Error(message), { stderr: message }));
    }
    return runTurnSnapshotGitWithExecFile(argv, options);
  };
}

describe("TurnSnapshotService sparse execution roots", () => {
  it(
    "matches porcelain across cone, non-cone and NEGATION definitions, clean and materialized",
    async () => {
      const repository: FixtureRepository = fixture.repository;
      // The negation fixture is the load-bearing one. A `/*` include plus a nested
      // `!/a/b/` re-exclusion is where the gitignore machinery this module already
      // runs gives the WRONG answer (measured on git 2.50.1: it scores
      // `a/b/deep.txt` includable, and the sparsity matcher does not), so a
      // partition built on the exclude pipeline instead of on `check-rules` passes
      // the cone arm and fails here.
      repository.write("cone-in/kept.txt", "in cone\n");
      repository.write("cone-out/excluded.txt", "out of cone\n");
      repository.write("a/top.txt", "a top\n");
      repository.write("a/b/deep.txt", "a b deep\n");
      repository.write("a/b/c/deeper.txt", "a b c deeper\n");
      await repository.git(["add", "-A"]);
      await repository.git(["commit", "-q", "-m", "sparse matrix fixture"]);

      const service: TurnSnapshotService = buildService();
      let turnOrdinal = 0;

      // Each arm: apply the definition, capture, assert porcelain equivalence.
      // CONE mode first — the ordinary shape, and the control that a failure in a
      // later arm is about the matcher rather than about the pipeline.
      await repository.git(["sparse-checkout", "set", "cone-in"]);
      turnOrdinal += 1;
      await expectCapturePorcelainEquivalent(
        repository,
        await captureTurn(service, { turnOrdinal }),
        "porcelain-cone.index",
      );

      // NON-CONE POSITIVE PATTERN.
      await repository.git(["sparse-checkout", "disable"]);
      await applyNonConeSparseDefinition(repository, ["/cone-in/", "/*.txt", "/.gitignore"]);
      turnOrdinal += 1;
      await expectCapturePorcelainEquivalent(
        repository,
        await captureTurn(service, { turnOrdinal }),
        "porcelain-noncone.index",
      );

      // TOP-LEVEL NEGATION — everything, minus one top-level directory.
      await applyNonConeSparseDefinition(repository, ["/*", "!/cone-out/"]);
      turnOrdinal += 1;
      await expectCapturePorcelainEquivalent(
        repository,
        await captureTurn(service, { turnOrdinal }),
        "porcelain-negate-top.index",
      );

      // NESTED NEGATION — the case a gitignore-based oracle gets wrong.
      await applyNonConeSparseDefinition(repository, ["/*", "!/a/b/"]);
      turnOrdinal += 1;
      await expectCapturePorcelainEquivalent(
        repository,
        await captureTurn(service, { turnOrdinal }),
        "porcelain-negate-nested.index",
      );

      // …and the same definition with the worktree MATERIALIZED at out-of-cone
      // paths, which is a different index state entirely: `read-tree -mu` cleared
      // skip-worktree for nothing, but writing at an out-of-cone path leaves a file
      // git's own listing reports as untracked. Porcelain and the capture have to
      // still agree about it.
      repository.write("a/b/deep.txt", "materialized out-of-cone edit\n");
      repository.write("a/b/stray.txt", "materialized out-of-cone stray\n");
      turnOrdinal += 1;
      await expectCapturePorcelainEquivalent(
        repository,
        await captureTurn(service, { turnOrdinal }),
        "porcelain-materialized.index",
      );
    },
    MULTI_SEQUENCE_CASE_TIMEOUT_MS,
  );

  it("stages UNCOMMITTED in-cone work, not just the partition's exclusions", async () => {
    const repository: FixtureRepository = fixture.repository;
    // Every other porcelain arm above compares a CLEAN worktree, and on a clean
    // worktree the scratch index's live-index seed already carries the whole
    // answer: an in-cone listing that staged NOTHING would still write the right
    // tree, because `update-index` with empty stdin is a no-op over a seeded
    // index. Measured, by making the matcher call return the empty set — the
    // suite stayed green on every arm but one, and the boundary trailer stayed
    // small too, since it subtracts every tracked path back out. So this arm
    // holds UNCOMMITTED in-cone content at capture time, which is the shape that
    // actually fails when the partition's in-cone half goes wrong.
    repository.write("cone-in/kept.txt", "committed content\n");
    repository.write("cone-out/excluded.txt", "out of cone\n");
    await repository.git(["add", "-A"]);
    await repository.git(["commit", "-q", "-m", "in-cone staging fixture"]);
    await repository.git(["sparse-checkout", "set", "cone-in"]);

    // Both kinds: a MODIFICATION to a tracked in-cone file and a NEW untracked
    // one. The out-of-cone write beside them is the control — the same capture
    // that has to carry these two has to keep excluding that one, so a partition
    // that simply staged everything passes neither.
    repository.write("cone-in/kept.txt", "UNCOMMITTED edit\n");
    repository.write("cone-in/added.txt", "UNCOMMITTED addition\n");
    repository.write("cone-out/materialized.txt", "materialized out of cone\n");

    const captured: TurnSnapshotCaptured = await captureTurn(buildService());

    expect(await repository.git(["cat-file", "blob", `${captured.ref}:cone-in/kept.txt`])).toBe(
      "UNCOMMITTED edit",
    );
    expect(await repository.git(["cat-file", "blob", `${captured.ref}:cone-in/added.txt`])).toBe(
      "UNCOMMITTED addition",
    );
    expect(
      await repository.git(["ls-tree", "-r", "--name-only", `${captured.ref}^{tree}`]),
    ).not.toContain("cone-out/materialized.txt");
    await expectCapturePorcelainEquivalent(repository, captured, "porcelain-in-cone-work.index");
  });

  it("inherits sparsity into a linked WORKTREE root and captures it faithfully", async () => {
    const repository: FixtureRepository = fixture.repository;
    // Detection is ROOT-KEYED and mode-agnostic, and this is the fixture that
    // makes that assertable rather than asserted: `git worktree add` copies the
    // sparse state, so a `provisioned-worktree` root is sparse without anything in
    // the daemon saying so. A detector keyed on the mode would classify this root
    // non-sparse and lose its out-of-cone content.
    repository.write("cone-in/kept.txt", "in cone\n");
    repository.write("cone-out/excluded.txt", "out of cone\n");
    await repository.git(["add", "-A"]);
    await repository.git(["commit", "-q", "-m", "sparse fixture"]);
    await repository.git(["sparse-checkout", "set", "cone-in"]);

    const worktreeRoot: string = join(fixture.fixtureRoot, "linked-worktree");
    await repository.git(["worktree", "add", "-q", "-b", "feature/sparse", worktreeRoot]);
    const worktree = new FixtureRepository(
      worktreeRoot,
      buildFixtureEnvironment(fixture.fixtureRoot),
    );
    // Inheritance, asserted rather than assumed — if a future git stopped copying
    // the state, this case would otherwise silently become a non-sparse one.
    expect(await worktree.git(["config", "--type=bool", "--get", "core.sparseCheckout"])).toBe(
      "true",
    );
    expect(existsSync(join(worktreeRoot, "cone-out"))).toBe(false);

    const service: TurnSnapshotService = buildService();
    const captured: TurnSnapshotCaptured = expectCaptured(
      await service.captureTurnSnapshot({ ...CAPTURE_DEFAULTS, executionRoot: worktreeRoot }),
    );
    await expectCapturePorcelainEquivalent(worktree, captured, "porcelain-worktree.index");
    expect(
      await worktree.git(["ls-tree", "-r", "--name-only", `${captured.ref}^{tree}`]),
    ).toContain("cone-out/excluded.txt");
  });

  it("round-trips content staged with `add --sparse` before the cone shrank", async () => {
    const repository: FixtureRepository = fixture.repository;
    // The LIVE-INDEX SEED's discriminating fixture. The user stages out-of-cone
    // content, then narrows the cone; the live index now legitimately differs
    // from `HEAD` at that path, and `read-tree <base>` — the pre-closure seed —
    // records the BASE's blob rather than the staged one. Only a seed taken from
    // the live index can see what was staged.
    repository.write("cone-in/kept.txt", "in cone\n");
    repository.write("cone-out/excluded.txt", "base content\n");
    await repository.git(["add", "-A"]);
    await repository.git(["commit", "-q", "-m", "sparse fixture"]);
    repository.write("cone-out/excluded.txt", "STAGED out-of-cone content\n");
    await repository.git(["add", "--sparse", "cone-out/excluded.txt"]);
    await repository.git(["sparse-checkout", "set", "cone-in"]);

    const captured: TurnSnapshotCaptured = await captureTurn(buildService());
    await expectCapturePorcelainEquivalent(repository, captured, "porcelain-staged.index");
    // Ground truth, independent of the porcelain comparison: the recorded blob is
    // the STAGED content, which is the byte the `<base>` seed could not reach.
    expect(
      await repository.git([
        "cat-file",
        "blob",
        `${captured.snapshotCommit}:cone-out/excluded.txt`,
      ]),
    ).toBe("STAGED out-of-cone content");
  });

  it("records out-of-cone untracked and intent-to-add paths as the BOUNDARY SET", async () => {
    const repository: FixtureRepository = fixture.repository;
    repository.write("cone-in/kept.txt", "in cone\n");
    repository.write("cone-out/tracked.txt", "tracked out of cone\n");
    await repository.git(["add", "-A"]);
    await repository.git(["commit", "-q", "-m", "sparse fixture"]);
    await repository.git(["sparse-checkout", "set", "cone-in"]);
    // Both shapes the snapshot tree cannot hold, created after the cone narrowed.
    mkdirSync(join(repository.root, "cone-out"), { recursive: true });
    repository.write("cone-out/untracked.txt", "untracked out of cone\n");
    repository.write("cone-out/intent.txt", "intent-to-add out of cone\n");
    await repository.git(["add", "-N", "--sparse", "cone-out/intent.txt"]);

    const captured: TurnSnapshotCaptured = await captureTurn(buildService());

    // THE INTENT-TO-ADD GUARD, asserted COMPARATIVELY. Whether `write-tree` omits
    // an intent-to-add entry is git's call, so the claim under test is that the
    // capture agrees with porcelain about it — an absolute expectation would go
    // version-fragile if a future git changed that disposition, while agreement
    // holds either way.
    await expectCapturePorcelainEquivalent(repository, captured, "porcelain-boundary.index");

    // The boundary set is exactly the two paths the tree could not hold. The
    // tracked out-of-cone path is NOT in it — the live-index seed recorded it, so
    // the restore has a copy and no exemption is owed.
    expect(await readSparseBoundaryTrailer(repository, captured.snapshotCommit)).toEqual([
      "cone-out/intent.txt",
      "cone-out/untracked.txt",
    ]);
    const snapshotPaths: string = await repository.git([
      "ls-tree",
      "-r",
      "--name-only",
      `${captured.ref}^{tree}`,
    ]);
    expect(snapshotPaths).toContain("cone-out/tracked.txt");
    expect(snapshotPaths).not.toContain("cone-out/intent.txt");
    expect(snapshotPaths).not.toContain("cone-out/untracked.txt");
  });

  it("always writes the trailer in a sparse root; an empty set spells `[]`", async () => {
    const repository: FixtureRepository = fixture.repository;
    repository.write("cone-in/kept.txt", "in cone\n");
    repository.write("cone-out/excluded.txt", "out of cone\n");
    await repository.git(["add", "-A"]);
    await repository.git(["commit", "-q", "-m", "sparse fixture"]);
    await repository.git(["sparse-checkout", "set", "cone-in"]);

    // No untracked and no intent-to-add out-of-cone content, so the boundary set
    // is EMPTY — and the trailer is written anyway. That is the format marker:
    // presence has to mean "a sparse-aware capture wrote this" all by itself, or
    // the absent-trailer vintage below is undecidable in the common case.
    const service: TurnSnapshotService = buildService();
    const captured: TurnSnapshotCaptured = await captureTurn(service);
    expect(await readSparseBoundaryTrailer(repository, captured.snapshotCommit)).toEqual([]);

    // OID DETERMINISM survives the unconditional trailer: a second capture of the
    // identical state at a later turn mints the identical TREE, and its commit
    // differs only in the ref it is written at. The message is an OID input, so a
    // trailer whose encoding was unstable would break this.
    const second: TurnSnapshotCaptured = await captureTurn(service, { turnOrdinal: 2 });
    expect(second.snapshotCommit).toBe(captured.snapshotCommit);
  });

  it("orders BOTH trailers, skipped before sparse, as their own paragraphs", async () => {
    const repository: FixtureRepository = fixture.repository;
    // Trailer ORDER is message bytes and therefore OID bytes, so it is fixed
    // rather than incidental — and this is the only fixture where both trailers
    // are present at once. It also drives the three-paragraph form of the `-F -`
    // stream, which the two-paragraph regression guard below cannot reach.
    repository.write("cone-in/kept.txt", "in cone\n");
    await repository.git(["add", "-A"]);
    await repository.git(["commit", "-q", "-m", "sparse fixture"]);
    await repository.git(["sparse-checkout", "set", "cone-in"]);
    mkdirSync(join(repository.root, "cone-out"), { recursive: true });
    repository.write("cone-out/boundary.txt", "existed at the boundary\n");
    await createCommitlessEmbeddedRepository("cone-in/unborn");

    const captured: TurnSnapshotCaptured = await captureTurn(buildService());
    expect(captured.skippedEmbeddedRepositories).toEqual(["cone-in/unborn"]);

    // The UNTRIMMED channel, deliberately: the message's terminating newline is
    // one of the two properties that make the `-F -` stream byte-equivalent to
    // the `-m` argv it replaced (the other is the blank-line join, which the
    // paragraph boundaries below assert), and a trimmed read cannot see it.
    const body: string = (
      await repository.gitCapturing(["cat-file", "commit", captured.snapshotCommit])
    ).stdout;
    const message: string = body.slice(body.indexOf("\n\n") + 2);
    expect(message).toBe(
      "sidekicks: turn-boundary snapshot\n\n" +
        'Skipped-Embedded-Repositories: ["cone-in/unborn"]\n\n' +
        'Sparse-Boundary-Paths: ["cone-out/boundary.txt"]\n',
    );
  });

  it("runs the NON-SPARSE pipeline byte-identically: no trailer, same `-F -` OID", async () => {
    const repository: FixtureRepository = fixture.repository;
    // The regression guard for the transport conversion. The commit is
    // reconstructed with fixture git using the `-m` spellings the service used to
    // pass, and the service's `-F -` stream has to mint the SAME OID — for the
    // one-paragraph message and, below, for the two-paragraph skipped-trailer
    // form, which is where a join-without-terminate would diverge.
    applyTurnEffects();
    const service: TurnSnapshotService = buildService();
    const captured: TurnSnapshotCaptured = await captureTurn(service);

    expect(await readSparseBoundaryTrailer(repository, captured.snapshotCommit)).toBeNull();
    const identity = {
      GIT_AUTHOR_NAME: "AI Sidekicks",
      GIT_AUTHOR_EMAIL: "snapshots@ai-sidekicks.invalid",
      GIT_AUTHOR_DATE: "1767225600 +0000",
      GIT_COMMITTER_NAME: "AI Sidekicks",
      GIT_COMMITTER_EMAIL: "snapshots@ai-sidekicks.invalid",
      GIT_COMMITTER_DATE: "1767225600 +0000",
    };
    expect(
      await repository.git(
        [
          "-c",
          "i18n.commitEncoding=utf-8",
          "commit-tree",
          `${captured.ref}^{tree}`,
          "-p",
          captured.baseCommit,
          "-m",
          "sidekicks: turn-boundary snapshot",
        ],
        { environmentOverrides: identity },
      ),
    ).toBe(captured.snapshotCommit);

    // The TWO-PARAGRAPH form, driven through a real skipped embedded repository
    // so the trailer is the service's own bytes rather than this case's guess.
    await createCommitlessEmbeddedRepository("unborn");
    const skipped: TurnSnapshotCaptured = await captureTurn(service, { turnOrdinal: 2 });
    expect(skipped.skippedEmbeddedRepositories).toEqual(["unborn"]);
    expect(
      await repository.git(
        [
          "-c",
          "i18n.commitEncoding=utf-8",
          "commit-tree",
          `${skipped.ref}^{tree}`,
          "-p",
          skipped.baseCommit,
          "-m",
          "sidekicks: turn-boundary snapshot",
          "-m",
          'Skipped-Embedded-Repositories: ["unborn"]',
        ],
        { environmentOverrides: identity },
      ),
    ).toBe(skipped.snapshotCommit);
  });

  it("passes the message on STDIN, never on the argv", async () => {
    // The argv bound this conversion removes is invisible from the OID, so it is
    // asserted on the argv itself: `commit-tree` carries `-F -` and no `-m`, and
    // no element of the command line is the message. A future edit that "simply"
    // re-inlined the trailers would pass every OID assertion above and fail here.
    const invocations: string[][] = [];
    const service: TurnSnapshotService = buildService({ git: buildRecordingRunner(invocations) });
    await captureTurn(service);

    const commitTree: string[] | undefined = invocations.find((argv) =>
      argv.includes("commit-tree"),
    );
    expect(commitTree).toBeDefined();
    expect(commitTree).toContain("-F");
    expect(commitTree).not.toContain("-m");
    expect(commitTree?.some((element) => element.includes("turn-boundary snapshot"))).toBe(false);
    expect(commitTree?.at(-1)).toBe("-");
  });

  it("classifies a stale rules file with the bit FALSE as NON-sparse", async () => {
    const repository: FixtureRepository = fixture.repository;
    // The CONVERSE QUADRANT. Detection is the bit alone, so a leftover
    // `$GIT_DIR/info/sparse-checkout` from a disabled sparse checkout must not
    // pull the root onto the sparse arm — the worktree is intact and the
    // non-sparse pipeline is correct for it. Measured: `sparse-checkout disable`
    // leaves the patterns file behind and clears only the bit.
    repository.write("cone-in/kept.txt", "in cone\n");
    repository.write("cone-out/excluded.txt", "out of cone\n");
    await repository.git(["add", "-A"]);
    await repository.git(["commit", "-q", "-m", "sparse fixture"]);
    await repository.git(["sparse-checkout", "set", "cone-in"]);
    await repository.git(["sparse-checkout", "disable"]);
    const gitDirectory: string = await repository.git(["rev-parse", "--absolute-git-dir"]);
    expect(existsSync(join(gitDirectory, "info", "sparse-checkout"))).toBe(true);
    expect(
      await repository.git([
        "config",
        "--type=bool",
        "--default=false",
        "--get",
        "core.sparseCheckout",
      ]),
    ).toBe("false");

    const captured: TurnSnapshotCaptured = await captureTurn(buildService());
    // Non-sparse pipeline, byte-identically: no trailer at all, and the tree is
    // still porcelain's.
    expect(await readSparseBoundaryTrailer(repository, captured.snapshotCommit)).toBeNull();
    await expectCapturePorcelainEquivalent(repository, captured, "porcelain-stale-rules.index");
  });

  it("FAILS CLOSED at `check-sparse-rules` when the bit is set but rules vanished", async () => {
    const repository: FixtureRepository = fixture.repository;
    // The quadrant the detection rule exists for. The bit is set, the rules file
    // is gone, and the worktree still holds every out-of-cone path — measured on
    // git 2.50.1, porcelain `add -A` still records them. A detector that folded
    // "the rules parse" into its predicate would classify this NON-sparse, run
    // the `read-tree <base>` seed and drop exactly what porcelain keeps.
    repository.write("cone-in/kept.txt", "in cone\n");
    repository.write("cone-out/excluded.txt", "out of cone\n");
    await repository.git(["add", "-A"]);
    await repository.git(["commit", "-q", "-m", "sparse fixture"]);
    await repository.git(["sparse-checkout", "set", "cone-in", "cone-out"]);
    const gitDirectory: string = await repository.git(["rev-parse", "--absolute-git-dir"]);
    rmSync(join(gitDirectory, "info", "sparse-checkout"));
    expect(existsSync(join(repository.root, "cone-out", "excluded.txt"))).toBe(true);

    const service: TurnSnapshotService = buildService();
    const result: TurnSnapshotCaptureResult = await service.captureTurnSnapshot({
      ...CAPTURE_DEFAULTS,
      executionRoot: repository.root,
    });
    expect(result).toMatchObject({ outcome: "failed", failedStep: "check-sparse-rules" });
    expect(fixture.diagnostics).toContainEqual(
      expect.objectContaining({ kind: "capture-failed", failedStep: "check-sparse-rules" }),
    );
    // Never a partial capture: no ref was written, so a rollback reports
    // `no_snapshot` rather than restoring a snapshot with a hole in it.
    expect(await repository.refListing("refs/sidekicks/")).toBe("");
  });

  it("FAILS CLOSED at `check-sparse-rules` on a git too old to know the subcommand", async () => {
    const repository: FixtureRepository = fixture.repository;
    repository.write("cone-in/kept.txt", "in cone\n");
    repository.write("cone-out/excluded.txt", "out of cone\n");
    await repository.git(["add", "-A"]);
    await repository.git(["commit", "-q", "-m", "sparse fixture"]);
    await repository.git(["sparse-checkout", "set", "cone-in"]);

    // The below-2.41 floor, driven through the SEAM rather than by requiring an
    // old binary — see `buildLegFailingRunner`. The rule under test is the
    // service's: a matcher it cannot run is a typed failure, never a degrade to
    // the unpartitioned listing, which would be the shipped defect under a new
    // name.
    const service: TurnSnapshotService = buildService({
      git: buildLegFailingRunner(
        (argv) => argv.includes("check-rules"),
        "git: 'sparse-checkout check-rules' is not a git command.",
      ),
    });
    const result: TurnSnapshotCaptureResult = await service.captureTurnSnapshot({
      ...CAPTURE_DEFAULTS,
      executionRoot: repository.root,
    });
    expect(result).toMatchObject({ outcome: "failed", failedStep: "check-sparse-rules" });
    expect(await repository.refListing("refs/sidekicks/")).toBe("");
  });

  it("reports an unreadable `core.sparseCheckout` as `detect-sparse-root`", async () => {
    const repository: FixtureRepository = fixture.repository;
    repository.write("cone-in/kept.txt", "in cone\n");
    await repository.git(["add", "-A"]);
    await repository.git(["commit", "-q", "-m", "sparse fixture"]);
    await repository.git(["sparse-checkout", "set", "cone-in"]);

    // The detection leg's own floor. With `--default=false` an UNSET key is a
    // clean `false` at exit 0, so the only rejection left is a repository whose
    // config could not be read — and defaulting that to the non-sparse pipeline
    // is precisely the silent loss the whole closure is against.
    const service: TurnSnapshotService = buildService({
      git: buildLegFailingRunner(
        (argv) => argv.includes("config") && argv.includes("core.sparseCheckout"),
        "fatal: unable to read config file",
      ),
    });
    const result: TurnSnapshotCaptureResult = await service.captureTurnSnapshot({
      ...CAPTURE_DEFAULTS,
      executionRoot: repository.root,
    });
    expect(result).toMatchObject({ outcome: "failed", failedStep: "detect-sparse-root" });
  });

  it("does NOT let the cone rescue a gitignored in-cone path", async () => {
    const repository: FixtureRepository = fixture.repository;
    // The negative control for the partition's SCOPE. The cone decides which
    // paths the matcher admits; it never decides which paths are ignorable. An
    // implementation that replaced the exclude pipeline with the cone test — or
    // that ran the cone test on the wrong side of it — would capture this
    // project-declared disposable file, which says it must not.
    repository.write("cone-in/kept.txt", "in cone\n");
    repository.write("cone-in/ignored-file.txt", "in cone AND project-declared disposable\n");
    await repository.git(["add", "cone-in/kept.txt"]);
    await repository.git(["commit", "-q", "-m", "sparse fixture"]);
    repository.write(".gitignore", `${FIXTURE_IGNORE_RULES}cone-in/ignored-file.txt\n`);
    await repository.git(["add", ".gitignore"]);
    await repository.git(["commit", "-q", "-m", "ignore the in-cone artifact"]);
    await repository.git(["sparse-checkout", "set", "cone-in"]);

    const captured: TurnSnapshotCaptured = await captureTurn(buildService());
    const snapshotPaths: string = await repository.git([
      "ls-tree",
      "-r",
      "--name-only",
      `${captured.ref}^{tree}`,
    ]);
    expect(snapshotPaths).toContain("cone-in/kept.txt");
    expect(snapshotPaths).not.toContain("cone-in/ignored-file.txt");
    await expectCapturePorcelainEquivalent(repository, captured, "porcelain-ignored-in-cone.index");
  });

  it("fails the capture at `seed-index` when the repository index is LOCKED", async () => {
    const repository: FixtureRepository = fixture.repository;
    // A REAL held lock, not an injected seam. The property under test is that
    // this leg honors git's own lockfile protocol, so simulating the contention
    // would assert the simulation. The lock is created the way git creates one —
    // exclusively, at `<index>.lock` — and removed by this case, never by the
    // service, which is the other half of the protocol.
    repository.write("cone-in/kept.txt", "in cone\n");
    await repository.git(["add", "-A"]);
    await repository.git(["commit", "-q", "-m", "sparse fixture"]);
    await repository.git(["sparse-checkout", "set", "cone-in"]);

    const gitDirectory: string = await repository.git(["rev-parse", "--absolute-git-dir"]);
    const lockPath: string = join(gitDirectory, "index.lock");
    writeFileSync(lockPath, "");
    try {
      const service: TurnSnapshotService = buildService();
      expect(
        await service.captureTurnSnapshot({
          ...CAPTURE_DEFAULTS,
          executionRoot: repository.root,
        }),
      ).toMatchObject({ outcome: "failed", failedStep: "seed-index" });
      // The service did NOT remove a lock it did not create. A leg that cleaned up
      // on failure would corrupt the repository of whatever process really holds
      // it — the exact harm the protocol prevents.
      expect(existsSync(lockPath)).toBe(true);
    } finally {
      rmSync(lockPath, { force: true });
    }

    // …and the lock released, the same capture succeeds. Without this the case
    // would pass against a leg that always failed.
    expect(
      (
        await buildService().captureTurnSnapshot({
          ...CAPTURE_DEFAULTS,
          executionRoot: repository.root,
        })
      ).outcome,
    ).toBe("captured");
  });

  it(
    "locks the LINKED WORKTREE's own index, not the main checkout's",
    async () => {
      const repository: FixtureRepository = fixture.repository;
      // The linked-worktree layout is why the index path comes from `rev-parse
      // --git-path index` rather than from `<root>/.git/index`. A linked worktree
      // keeps its index under `<main>/.git/worktrees/<id>/index`, so the naive
      // spelling would lock and copy the MAIN checkout's index — a different
      // worktree's staged state recorded as this one's snapshot.
      repository.write("cone-in/kept.txt", "in cone\n");
      repository.write("cone-out/excluded.txt", "out of cone\n");
      await repository.git(["add", "-A"]);
      await repository.git(["commit", "-q", "-m", "sparse fixture"]);
      await repository.git(["sparse-checkout", "set", "cone-in"]);

      const worktreeRoot: string = join(fixture.fixtureRoot, "linked-worktree");
      await repository.git(["worktree", "add", "-q", "-b", "feature/sparse-lock", worktreeRoot]);
      const worktree = new FixtureRepository(
        worktreeRoot,
        buildFixtureEnvironment(fixture.fixtureRoot),
      );
      const worktreeIndexPath: string = await worktree.resolvedIndexPath();
      // The layout, asserted rather than assumed — this is the whole reason the
      // service resolves the index path through git instead of spelling it.
      expect(worktreeIndexPath).toContain(join(".git", "worktrees"));

      const lockPath = `${worktreeIndexPath}.lock`;
      writeFileSync(lockPath, "");
      try {
        expect(
          await buildService().captureTurnSnapshot({
            ...CAPTURE_DEFAULTS,
            executionRoot: worktreeRoot,
          }),
        ).toMatchObject({ outcome: "failed", failedStep: "seed-index" });
      } finally {
        rmSync(lockPath, { force: true });
      }

      // THE DISCRIMINATOR: with only the MAIN checkout's index locked, the
      // worktree's capture succeeds. A leg that resolved the index path naively
      // would fail here, which is what makes the arm above about the right file.
      const mainLockPath: string = join(
        await repository.git(["rev-parse", "--absolute-git-dir"]),
        "index.lock",
      );
      writeFileSync(mainLockPath, "");
      try {
        expect(
          (
            await buildService().captureTurnSnapshot({
              ...CAPTURE_DEFAULTS,
              executionRoot: worktreeRoot,
            })
          ).outcome,
        ).toBe("captured");
      } finally {
        rmSync(mainLockPath, { force: true });
      }
    },
    MULTI_SEQUENCE_CASE_TIMEOUT_MS,
  );

  it("fails the capture where PORCELAIN fails it on an UNMERGED out-of-cone entry", async () => {
    const repository: FixtureRepository = fixture.repository;
    // PARITY, not a bespoke rule. An unmerged entry is one `write-tree` refuses,
    // and the closure must not turn that refusal into a silently-dropped path.
    // The stages are written directly with `update-index --index-info`, because a
    // real merge conflict at an out-of-cone path is not reachable — git resolves
    // sparseness before it merges.
    repository.write("cone-in/kept.txt", "in cone\n");
    repository.write("cone-out/conflicted.txt", "base\n");
    await repository.git(["add", "-A"]);
    await repository.git(["commit", "-q", "-m", "sparse fixture"]);
    await repository.git(["sparse-checkout", "set", "cone-in"]);

    const baseBlob: string = await repository.git(["rev-parse", "HEAD:cone-out/conflicted.txt"]);
    const oursBlob: string = await repository.git(["hash-object", "-w", "--stdin"], {
      stdin: "ours\n",
    });
    const theirsBlob: string = await repository.git(["hash-object", "-w", "--stdin"], {
      stdin: "theirs\n",
    });
    await repository.git(["update-index", "--index-info"], {
      stdin:
        `0 0000000000000000000000000000000000000000\tcone-out/conflicted.txt\n` +
        `100644 ${baseBlob} 1\tcone-out/conflicted.txt\n` +
        `100644 ${oursBlob} 2\tcone-out/conflicted.txt\n` +
        `100644 ${theirsBlob} 3\tcone-out/conflicted.txt\n`,
    });
    expect(await repository.git(["ls-files", "-u", "cone-out/conflicted.txt"])).toContain(" 1\t");

    // PORCELAIN'S ANSWER FIRST, so the assertion below is a parity claim rather
    // than a stipulation about what the service ought to do with an input git
    // itself decides about.
    const porcelainIndex: string = join(fixture.fixtureRoot, "porcelain-unmerged.index");
    copyFileSync(await repository.resolvedIndexPath(), porcelainIndex);
    const porcelainWriteTree: FixtureGitResult = await repository.gitCapturing(["write-tree"], {
      environmentOverrides: { GIT_INDEX_FILE: porcelainIndex },
    });

    // Asserted, not branched on. `write-tree` has never been able to write an
    // unmerged path into a tree, and a case whose interesting arm was conditional
    // would pass vacuously the day this fixture stopped producing one.
    expect(porcelainWriteTree.exitCode).not.toBe(0);
    expect(porcelainWriteTree.stderr).toContain("unmerged");

    // So the capture is the typed failure at the leg that refused — never a
    // snapshot silently missing the unmerged path, which is the failure mode the
    // sparse partition could plausibly have introduced by filtering it out of the
    // staging listing.
    expect(
      await buildService().captureTurnSnapshot({
        ...CAPTURE_DEFAULTS,
        executionRoot: repository.root,
      }),
    ).toMatchObject({ outcome: "failed", failedStep: "write-tree" });
    expect(await repository.refListing("refs/sidekicks/")).toBe("");
  });

  it(
    "carries a boundary set past the 32-KiB command-line bound on the `-F -` stream",
    async () => {
      const repository: FixtureRepository = fixture.repository;
      // The transport conversion's SIZE claim. The trailer is unbounded by
      // construction — it names every out-of-cone untracked path at the boundary —
      // so the message is caller-influenced data, and `-m` puts caller-influenced
      // data on a command line. 32767 characters is where Windows `CreateProcess`
      // stops accepting one; POSIX hosts allow far more, which is exactly why an
      // argv transport would have passed here and failed there. The stream has no
      // such bound, and this drives a set past it end to end.
      repository.write("cone-in/kept.txt", "in cone\n");
      await repository.git(["add", "-A"]);
      await repository.git(["commit", "-q", "-m", "sparse fixture"]);
      await repository.git(["sparse-checkout", "set", "cone-in"]);

      mkdirSync(join(repository.root, "cone-out"), { recursive: true });
      const filler: string = "b".repeat(150);
      const boundaryPaths: readonly string[] = Array.from(
        { length: 220 },
        (_unused, index) => `cone-out/${String(index).padStart(4, "0")}-${filler}.txt`,
      );
      for (const boundaryPath of boundaryPaths) {
        repository.write(boundaryPath, `boundary ${boundaryPath}\n`);
      }

      const service: TurnSnapshotService = buildService();
      const captured: TurnSnapshotCaptured = await captureTurn(service);

      const trailer: readonly string[] | null = await readSparseBoundaryTrailer(
        repository,
        captured.snapshotCommit,
      );
      expect(trailer).toEqual([...boundaryPaths].sort());
      // The bound itself, asserted on the SERIALIZED line rather than assumed from
      // the path count — a future filler length that quietly fell under it would
      // otherwise leave this case named for a property it no longer drives.
      expect(JSON.stringify(trailer).length).toBeGreaterThan(32_767);
    },
    MULTI_SEQUENCE_CASE_TIMEOUT_MS,
  );

  it("carries a MULTIBYTE out-of-cone name through capture under `core.quotepath`", async () => {
    const repository: FixtureRepository = fixture.repository;
    // The capture leg's byte discipline, measured on real bytes off a real disk.
    // `core.quotepath=true` is the host setting that makes git render non-ASCII
    // paths as C-quoted escapes in its PORCELAIN output; every listing this module
    // reads is `-z`, which git documents as defeating that quoting, and the whole
    // partition rests on it — a quoted echo would key the in-cone map on a
    // different string than the listing slice and drop the path from the snapshot.
    //
    // A CJK name rather than an accented Latin one, deliberately: APFS normalizes
    // filenames to NFD, so `café` would round-trip through a different byte
    // sequence than it was written with and the arm would be measuring the
    // filesystem's normalization instead of git's quoting.
    await repository.git(["config", "core.quotepath", "true"]);
    repository.write("cone-in/kept.txt", "in cone\n");
    await repository.git(["add", "-A"]);
    await repository.git(["commit", "-q", "-m", "sparse fixture"]);
    await repository.git(["sparse-checkout", "set", "cone-in"]);
    mkdirSync(join(repository.root, "cone-out"), { recursive: true });
    repository.write("cone-out/日本語.txt", "multibyte out of cone\n");

    const service: TurnSnapshotService = buildService();
    const captured: TurnSnapshotCaptured = await captureTurn(service);
    await expectCapturePorcelainEquivalent(repository, captured, "porcelain-multibyte.index");
    // VERBATIM in the trailer, asserted on BYTES: not `cone-out/\346\227\245…`,
    // which is what a leg reading porcelain output under this config would have
    // recorded, and not a re-encoding of a decode either. The trailer holds
    // `latin1` keys, so the round trip through `JSON.stringify` → the commit
    // message's own UTF-8 → `JSON.parse` → `latin1` has to reproduce the file
    // name's original bytes exactly.
    expect(await readSparseBoundaryTrailerBytes(repository, captured.snapshotCommit)).toEqual([
      Buffer.from("cone-out/日本語.txt", "utf8"),
    ]);
  });

  it("subtracts the boundary set BYTE-EXACTLY; paths that decode alike stay distinct", async () => {
    const repository: FixtureRepository = fixture.repository;
    // SYNTHESIZED ON BOTH SIDES, and scoped to match: this arm drives
    // `#deriveSparseBoundaryPaths`' KEYING and asserts only the trailer and the
    // staged tree. It claims nothing about the delete pass or the restore, because
    // neither listing here came off a disk — APFS rejects a non-UTF-8 filename at
    // `creat(2)` with `EILSEQ` (measured), so the repository this arm needs cannot
    // exist on the measuring host and the seam is the only honest way in.
    //
    // The two injected paths share NO bytes and decode to the SAME string: `0xFF`
    // and `0xFE` are both invalid UTF-8 lead bytes and both become U+FFFD. So a
    // subtraction keyed on decoded strings sees the tree already holding the
    // boundary candidate and drops it from the trailer; one keyed on bytes does
    // not. The dropped path is what the restore then destroys — for an
    // intent-to-add entry the pre-drop skips it and `read-tree --reset -u` unlinks
    // its only on-disk copy.
    repository.write("cone-in/kept.txt", "in cone\n");
    await repository.git(["add", "-A"]);
    await repository.git(["commit", "-q", "-m", "sparse fixture"]);
    await repository.git(["sparse-checkout", "set", "cone-in"]);

    const invalidCandidate: Buffer = Buffer.concat([Buffer.from("cone-out/"), Buffer.from([0xff])]);
    const invalidTreePath: Buffer = Buffer.concat([Buffer.from("cone-out/"), Buffer.from([0xfe])]);
    const NUL: Buffer = Buffer.from([0]);
    // Matched on the flags AFTER the subcommand, the same discipline
    // `isBoundaryDropListing` documents: `-co` is unique to the capture listing,
    // and `--name-only` is unique to the boundary derivation's `ls-tree` (the
    // restore's tree listing carries modes and object ids).
    const injectingRunner: TurnSnapshotGitRunner = async (argv, options) => {
      const result = await runTurnSnapshotGitWithExecFile(argv, options);
      const lsFilesIndex: number = argv.indexOf("ls-files");
      if (
        lsFilesIndex !== -1 &&
        argv.slice(lsFilesIndex + 1).join(" ") === "-co --exclude-per-directory=.gitignore -z"
      ) {
        return { ...result, stdout: Buffer.concat([result.stdout, invalidCandidate, NUL]) };
      }
      if (argv.includes("ls-tree") && argv.includes("--name-only")) {
        return { ...result, stdout: Buffer.concat([result.stdout, invalidTreePath, NUL]) };
      }
      return result;
    };

    const service: TurnSnapshotService = buildService({ git: injectingRunner });
    const captured: TurnSnapshotCaptured = await captureTurn(service);

    // SURVIVES the subtraction, and is recorded as ITS OWN BYTES. The trailer used
    // to spell this `cone-out/�` — a decode at the trailer boundary, and the
    // residual the suite header used to name — which made the recorded path
    // indistinguishable from the unrelated tree path the injection put beside it.
    // The `0xFF` here is what proves the whole lifecycle is byte-keyed: capture
    // subtracts on bytes AND records them, so the restore matches on bytes too.
    expect(await readSparseBoundaryTrailerBytes(repository, captured.snapshotCommit)).toEqual([
      invalidCandidate,
    ]);
    // The injection perturbed the SUBTRACTION only: the staged tree is still the
    // one porcelain builds, so the out-of-cone candidate never reached staging and
    // the in-cone half of the partition is byte-identical to an un-injected run.
    await expectCapturePorcelainEquivalent(repository, captured, "porcelain-byte-exact.index");
  });

  it("records a non-descended boundary DIRECTORY with its slash", async () => {
    const repository: FixtureRepository = fixture.repository;
    // At CAPTURE an out-of-cone untracked embedded repository is one `ls-files -o`
    // entry with a trailing slash — git refuses to descend it, so the capture
    // cannot enumerate what is inside. Recording the slash says the recorded name
    // stands for a subtree.
    repository.write("cone-in/kept.txt", "in cone\n");
    await repository.git(["add", "-A"]);
    await repository.git(["commit", "-q", "-m", "sparse fixture"]);
    await repository.git(["sparse-checkout", "set", "cone-in"]);
    mkdirSync(join(repository.root, "cone-out"), { recursive: true });
    await createEmbeddedRepository("cone-out/nested");
    writeFileSync(join(repository.root, "cone-out", "nested", "payload.txt"), "boundary payload\n");

    const service: TurnSnapshotService = buildService();
    const captured: TurnSnapshotCaptured = await captureTurn(service);
    // TYPE-PRESERVING: recorded WITH the slash git listed it with.
    expect(await readSparseBoundaryTrailer(repository, captured.snapshotCommit)).toEqual([
      "cone-out/nested/",
    ]);
  });
});

// ----------------------------------------------------------------------------
// ----------------------------------------------------------------------------
//
// A REAL migrated SQLite database, not a stubbed row source. The retention leg's
// whole content is a predicate over `run_execution_contexts` — `released_at`
// plus the window, and `git_common_dir` as the git dir — so a fake table would
// assert the predicate against the fake, including the mode-conditional CHECK
// that decides which companion rows a context legally has. Seeding through the
// real DDL is also what keeps the `provisioned-worktree` cases honest: each one
// really does carry the root row its mode requires.

const RETENTION_SESSION_ID = "0192b3c0-3333-7c4a-9b1c-1b7c5b3e8f00";
const RETENTION_MOUNT_ID = "0192b3c0-4444-7c4a-9b1c-1b7c5b3e8f00";
const RETENTION_WORKSPACE_ID = "0192b3c0-5555-7c4a-9b1c-1b7c5b3e8f00";

/** The sweep's "now". Held, so every window assertion is arithmetic and not luck. */
const RETENTION_NOW = "2026-06-01T00:00:00.000Z";

/** Released 31 days before {@link RETENTION_NOW} — outside the 7-day default window. */
const RELEASED_LONG_AGO = "2026-05-01T00:00:00.000Z";

/** Released 1 day before {@link RETENTION_NOW} — terminal, but still INSIDE the window. */
const RELEASED_RECENTLY = "2026-05-31T00:00:00.000Z";

/**
 * A second run id that is a strict PREFIX-EXTENSION of {@link RUN_ID}.
 *
 * Deliberately not just "another uuid": the enumeration pattern is
 * `refs/sidekicks/runs/<runId>/`, and the failure this guards against is a
 * pattern that matched by prefix rather than by path segment, which only a
 * sibling whose id STARTS with the pruned one can catch.
 */
const SIBLING_RUN_ID = `${RUN_ID}b`;

const UNSAFE_RUN_ID = "../../heads/main";

let retentionDatabase: DatabaseType | null = null;

/** Open a migrated database inside the fixture root and seed the mount + workspace. */
function openRetentionDatabase(): DatabaseType {
  const database: DatabaseType = openDatabase(join(fixture.fixtureRoot, "daemon.db"));
  retentionDatabase = database;
  database
    .prepare(
      `INSERT INTO repo_mounts (
         id, node_id, local_path, canonical_root, state, attached_at, updated_at
       ) VALUES (@id, 'node-1', @root, @root, 'attached', @now, @now)`,
    )
    .run({
      id: RETENTION_MOUNT_ID,
      root: fixture.repository.root,
      now: RETENTION_NOW,
    });
  database
    .prepare(
      `INSERT INTO workspaces (
         id, session_id, repo_mount_id, execution_mode, fs_root, state, created_at, updated_at
       ) VALUES (
         @id, @session_id, @repo_mount_id, 'provisioned-worktree', @root, 'ready', @now, @now
       )`,
    )
    .run({
      id: RETENTION_WORKSPACE_ID,
      session_id: RETENTION_SESSION_ID,
      repo_mount_id: RETENTION_MOUNT_ID,
      root: fixture.repository.root,
      now: RETENTION_NOW,
    });
  return database;
}

function closeRetentionDatabase(): void {
  const database: DatabaseType | null = retentionDatabase;
  retentionDatabase = null;
  if (database !== null && database.open) {
    database.close();
  }
}

interface RunContextSeed {
  readonly runId: string;
  readonly executionMode: ExecutionMode;
  readonly executionRoot: string;
  /** What the sweep runs its ref ops through. The whole point of the column. */
  readonly gitCommonDir: string;
  /** `null` is a run that is still OPEN — never a prune candidate. */
  readonly releasedAt: string | null;
}

/**
 * Seed one `run_execution_contexts` row plus exactly the companion rows its
 * mode's CHECK requires: every mode carries a branch context, and the
 * `provisioned-worktree` mode carries its own root row. The CHECK refuses a row
 * without them.
 */
function insertRunExecutionContext(database: DatabaseType, seed: RunContextSeed): void {
  let worktreeId: string | null = null;

  if (seed.executionMode === "provisioned-worktree") {
    worktreeId = `worktree-${seed.runId}`;
    database
      .prepare(
        `INSERT INTO worktrees (
           id, repo_mount_id, created_by_session_id, created_by_run_id,
           branch_name, fs_root, state, created_at, updated_at
         ) VALUES (@id, @repo_mount_id, @session_id, @run_id, @branch, @root, 'ready', @now, @now)`,
      )
      .run({
        id: worktreeId,
        repo_mount_id: RETENTION_MOUNT_ID,
        session_id: RETENTION_SESSION_ID,
        run_id: seed.runId,
        branch: `feature/${seed.runId}`,
        root: seed.executionRoot,
        now: RETENTION_NOW,
      });
  }

  const branchContextId: string = `branch-context-${seed.runId}`;
  database
    .prepare(
      `INSERT INTO branch_contexts (
         id, workspace_id, worktree_id, base_branch, head_branch, created_at, updated_at
       ) VALUES (@id, @workspace_id, @worktree_id, 'main', @head, @now, @now)`,
    )
    .run({
      id: branchContextId,
      workspace_id: RETENTION_WORKSPACE_ID,
      worktree_id: worktreeId,
      head: `feature/${seed.runId}`,
      now: RETENTION_NOW,
    });

  database
    .prepare(
      `INSERT INTO run_execution_contexts (
         run_id, session_id, workspace_id, execution_mode, execution_root, git_common_dir,
         worktree_id, branch_context_id, created_at, released_at
       ) VALUES (
         @run_id, @session_id, @workspace_id, @execution_mode, @execution_root, @git_common_dir,
         @worktree_id, @branch_context_id, @now, @released_at
       )`,
    )
    .run({
      run_id: seed.runId,
      session_id: RETENTION_SESSION_ID,
      workspace_id: RETENTION_WORKSPACE_ID,
      execution_mode: seed.executionMode,
      execution_root: seed.executionRoot,
      git_common_dir: seed.gitCommonDir,
      worktree_id: worktreeId,
      branch_context_id: branchContextId,
      now: RETENTION_NOW,
      released_at: seed.releasedAt,
    });
}

/** The fixture repository's own git directory — the surviving canonical store. */
function canonicalGitDirectory(): string {
  return join(fixture.repository.root, ".git");
}

/** A retention-wired service: the real DB, the held clock, the production git seam. */
function buildRetentionService(
  database: DatabaseType,
  overrides: ServiceOverrides = {},
): TurnSnapshotService {
  return buildService({ database, now: (): string => RETENTION_NOW, ...overrides });
}

/** A git seam that records every argv the service assembled, then really runs it. */
function buildRecordingRunner(invocations: string[][]): TurnSnapshotGitRunner {
  return async (argv, options) => {
    invocations.push([...argv]);
    return runTurnSnapshotGitWithExecFile(argv, options);
  };
}

describe("TurnSnapshotService retention prune", () => {
  afterEach(() => {
    // Before the outer hook removes the fixture root out from under the handle.
    closeRetentionDatabase();
  });

  it("retains a terminal run whose retention window has NOT elapsed", async () => {
    const repository: FixtureRepository = fixture.repository;
    const database: DatabaseType = openRetentionDatabase();
    const service: TurnSnapshotService = buildRetentionService(database);
    applyTurnEffects();
    await captureTurn(service);
    const refsBefore: string = await repository.refListing("refs/sidekicks/");
    expect(refsBefore).not.toBe("");

    // Terminal — `released_at` is stamped — but only one day ago against a
    // seven-day window. This is the case that distinguishes window-based
    // retention from a terminal-invoked prune: at terminal the refs must still
    // be there, because a rollback is something a user reaches for afterwards.
    insertRunExecutionContext(database, {
      runId: RUN_ID,
      executionMode: "provisioned-worktree",
      executionRoot: repository.root,
      gitCommonDir: canonicalGitDirectory(),
      releasedAt: RELEASED_RECENTLY,
    });

    const sweep: TurnSnapshotRetentionSweepResult = await service.sweepPrunableRuns();

    expect(sweep).toEqual({
      examinedRunIds: [],
      prunedRunIds: [],
      deletedRefs: [],
      skipped: [],
    });
    expect(await repository.refListing("refs/sidekicks/")).toBe(refsBefore);
    expect(fixture.diagnostics).toEqual([]);
  });

  it("prunes an elapsed window while a still-open run is retained", async () => {
    const repository: FixtureRepository = fixture.repository;
    const database: DatabaseType = openRetentionDatabase();
    const service: TurnSnapshotService = buildRetentionService(database);
    applyTurnEffects();
    const elapsed = await captureTurn(service, { turnOrdinal: 1 });
    const stillOpen = expectCaptured(
      await service.captureTurnSnapshot({
        ...CAPTURE_DEFAULTS,
        runId: SIBLING_RUN_ID,
        turnOrdinal: 1,
        executionRoot: repository.root,
      }),
    );

    insertRunExecutionContext(database, {
      runId: RUN_ID,
      executionMode: "provisioned-worktree",
      executionRoot: repository.root,
      gitCommonDir: canonicalGitDirectory(),
      releasedAt: RELEASED_LONG_AGO,
    });
    // `released_at IS NULL` — the run has not reached terminal at all. Age is
    // irrelevant to it, which is what the NULL arm of the predicate means.
    insertRunExecutionContext(database, {
      runId: SIBLING_RUN_ID,
      executionMode: "provisioned-worktree",
      executionRoot: repository.root,
      gitCommonDir: canonicalGitDirectory(),
      releasedAt: null,
    });

    const sweep: TurnSnapshotRetentionSweepResult = await service.sweepPrunableRuns();

    expect(sweep.examinedRunIds).toEqual([RUN_ID]);
    expect(sweep.prunedRunIds).toEqual([RUN_ID]);
    expect(sweep.deletedRefs).toEqual([elapsed.ref]);
    expect(sweep.skipped).toEqual([]);
    expect(await repository.refListing("refs/sidekicks/")).toBe(
      `${stillOpen.snapshotCommit} ${stillOpen.ref}`,
    );
    // No skips, so no enumeration diagnostic: the quiet path is asserted too.
    expect(fixture.diagnostics).toEqual([]);
  });

  it("applies the configured window to the exact millisecond, both directions", async () => {
    const repository: FixtureRepository = fixture.repository;
    const database: DatabaseType = openRetentionDatabase();
    // One minute, so the boundary is expressible without a day of arithmetic.
    const windowMs = 60_000;
    const service: TurnSnapshotService = buildRetentionService(database, {
      retentionWindowMs: windowMs,
    });
    applyTurnEffects();
    const atBoundary = await captureTurn(service, { turnOrdinal: 1 });
    const insideWindow = expectCaptured(
      await service.captureTurnSnapshot({
        ...CAPTURE_DEFAULTS,
        runId: SIBLING_RUN_ID,
        turnOrdinal: 1,
        executionRoot: repository.root,
      }),
    );

    const cutoffMs: number = Date.parse(RETENTION_NOW) - windowMs;
    insertRunExecutionContext(database, {
      runId: RUN_ID,
      executionMode: "provisioned-worktree",
      executionRoot: repository.root,
      gitCommonDir: canonicalGitDirectory(),
      // EXACTLY at the cutoff — the predicate is `<=`, so this one goes.
      releasedAt: new Date(cutoffMs).toISOString(),
    });
    insertRunExecutionContext(database, {
      runId: SIBLING_RUN_ID,
      executionMode: "provisioned-worktree",
      executionRoot: repository.root,
      gitCommonDir: canonicalGitDirectory(),
      // One millisecond newer — the window has NOT closed.
      releasedAt: new Date(cutoffMs + 1).toISOString(),
    });

    const sweep: TurnSnapshotRetentionSweepResult = await service.sweepPrunableRuns();

    expect(sweep.deletedRefs).toEqual([atBoundary.ref]);
    expect(await repository.refListing("refs/sidekicks/")).toBe(
      `${insideWindow.snapshotCommit} ${insideWindow.ref}`,
    );
  });

  it("deletes only the named run's namespace — heads and a sibling run survive", async () => {
    const repository: FixtureRepository = fixture.repository;
    const database: DatabaseType = openRetentionDatabase();
    const service: TurnSnapshotService = buildRetentionService(database);
    applyTurnEffects();
    // Two epochs and two ordinals for the pruned run, so "deleted the run's
    // refs" is a claim about a SET rather than about one ref.
    const first = await captureTurn(service, { epoch: 0, turnOrdinal: 1 });
    const second = await captureTurn(service, { epoch: 1, turnOrdinal: 2 });
    const sibling = expectCaptured(
      await service.captureTurnSnapshot({
        ...CAPTURE_DEFAULTS,
        runId: SIBLING_RUN_ID,
        executionRoot: repository.root,
      }),
    );
    await repository.git(["branch", "release/1.0"]);
    const headsBefore: string = await repository.refListing("refs/heads/");
    const siblingRefsBefore: string = await repository.refListing(
      `refs/sidekicks/runs/${SIBLING_RUN_ID}/`,
    );
    insertRunExecutionContext(database, {
      runId: RUN_ID,
      executionMode: "provisioned-worktree",
      executionRoot: repository.root,
      gitCommonDir: canonicalGitDirectory(),
      releasedAt: RELEASED_LONG_AGO,
    });

    const pruned: TurnSnapshotRetentionPruneResult = await service.pruneSnapshotsForRun(RUN_ID);

    expect(pruned.skipped).toBeNull();
    expect([...pruned.deletedRefs].sort()).toEqual([first.ref, second.ref].sort());
    // The invariant, as ground truth on both surfaces: branch history is
    // untouched, and the prefix-extension sibling — whose ref path starts with
    // the pruned run's id — kept every ref it had.
    expect(await repository.refListing("refs/heads/")).toBe(headsBefore);
    expect(await repository.refListing(`refs/sidekicks/runs/${SIBLING_RUN_ID}/`)).toBe(
      siblingRefsBefore,
    );
    expect(await repository.refListing("refs/sidekicks/")).toBe(
      `${sibling.snapshotCommit} ${sibling.ref}`,
    );
  });

  it("deletes a SYMBOLIC ref planted in the run namespace, never its target branch", async () => {
    const repository: FixtureRepository = fixture.repository;
    const database: DatabaseType = openRetentionDatabase();
    const service: TurnSnapshotService = buildRetentionService(database);
    applyTurnEffects();
    const captured = await captureTurn(service);

    // The attack the name check cannot see, because the name is LEGITIMATE: a
    // symbolic ref at a well-formed in-namespace path whose target is a branch.
    // `symbolic-ref` destroys nothing when it runs and needs no approval — it
    // writes a pointer — and the damage arrives a full retention window later,
    // inside an unattended background sweep. `for-each-ref` reports it with
    // `%(objectname)` resolved THROUGH the symref, so the listing entry is a
    // 40-hex oid at an in-prefix name: the parser accepts it correctly, and the
    // compare-and-swap matches, because the oid it carries is already the
    // branch's. Only `--no-deref` stands between this row and a deleted branch.
    const checkedOutBranch: string = await repository.git(["symbolic-ref", "HEAD"]);
    const plantedRef = `refs/sidekicks/runs/${RUN_ID}/epoch-0/turn-9`;
    await repository.git(["symbolic-ref", plantedRef, checkedOutBranch]);
    const branchTipBefore: string = await repository.git([
      "rev-parse",
      "--verify",
      checkedOutBranch,
    ]);
    const headsBefore: string = await repository.refListing("refs/heads/");
    expect(headsBefore).toContain(checkedOutBranch);
    // The listing the prune will act on really does resolve through the symref —
    // if this stopped being true the case would pass while testing nothing.
    expect(await repository.refListing(`refs/sidekicks/runs/${RUN_ID}/`)).toContain(
      `${branchTipBefore} ${plantedRef}`,
    );
    insertRunExecutionContext(database, {
      runId: RUN_ID,
      executionMode: "provisioned-worktree",
      executionRoot: repository.root,
      gitCommonDir: canonicalGitDirectory(),
      releasedAt: RELEASED_LONG_AGO,
    });

    const sweep: TurnSnapshotRetentionSweepResult = await service.sweepPrunableRuns();

    // The invariant, on the surface that matters: branch history byte-identical.
    // Measured on git 2.50.1 — WITHOUT `--no-deref` this same argv deletes the
    // branch, leaves the symref dangling, exits 0, and the pass reports a clean
    // prune with `skipped: null`. WITH it, the deletion lands on the symref.
    expect(await repository.refListing("refs/heads/")).toBe(headsBefore);
    expect(await repository.git(["rev-parse", "--verify", checkedOutBranch])).toBe(branchTipBefore);
    // And the in-namespace pointer is gone, along with the real snapshot: the
    // flag scopes the delete, it does not skip the entry.
    expect(await repository.refListing("refs/sidekicks/")).toBe("");
    expect([...sweep.deletedRefs].sort()).toEqual([captured.ref, plantedRef].sort());
    expect(sweep.skipped).toEqual([]);
    expect(fixture.diagnostics).toEqual([]);
  });

  it("refuses a namespace-escaping run id from the SWEEP before any git call", async () => {
    const repository: FixtureRepository = fixture.repository;
    const database: DatabaseType = openRetentionDatabase();
    const invocations: string[][] = [];
    const service: TurnSnapshotService = buildRetentionService(database, {
      git: buildRecordingRunner(invocations),
    });
    const headsBefore: string = await repository.refListing("refs/heads/");
    expect(headsBefore).not.toBe("");

    // A hostile ROW rather than a hostile argument: the sweep's ids come from
    // the table, so the table is where this invariant is actually exposed.
    insertRunExecutionContext(database, {
      runId: UNSAFE_RUN_ID,
      executionMode: "provisioned-worktree",
      executionRoot: repository.root,
      gitCommonDir: canonicalGitDirectory(),
      releasedAt: RELEASED_LONG_AGO,
    });

    const sweep: TurnSnapshotRetentionSweepResult = await service.sweepPrunableRuns();

    expect(sweep.examinedRunIds).toEqual([UNSAFE_RUN_ID]);
    expect(sweep.prunedRunIds).toEqual([]);
    expect(sweep.deletedRefs).toEqual([]);
    expect(sweep.skipped).toEqual([
      {
        runId: UNSAFE_RUN_ID,
        reason: "unsafe-run-id",
        detail: "run id is not a safe ref path component",
      },
    ]);
    // Refused BEFORE git, not by git: not one invocation was assembled. Relying
    // on git's own `refusing to update ref with bad name` would report a
    // successful prune of nothing here, which is indistinguishable from the
    // idempotent re-prune case.
    expect(invocations).toEqual([]);
    expect(await repository.refListing("refs/heads/")).toBe(headsBefore);
    expect(fixture.diagnostics).toEqual([
      {
        kind: "retention-prune-skipped",
        examinedRunCount: 1,
        skipped: sweep.skipped,
      },
    ]);
  });

  it("refuses a namespace-escaping run id from the PRIMITIVE before any git call", async () => {
    const repository: FixtureRepository = fixture.repository;
    const database: DatabaseType = openRetentionDatabase();
    const invocations: string[][] = [];
    const service: TurnSnapshotService = buildRetentionService(database, {
      git: buildRecordingRunner(invocations),
    });
    const headsBefore: string = await repository.refListing("refs/heads/");
    insertRunExecutionContext(database, {
      runId: UNSAFE_RUN_ID,
      executionMode: "bound-root",
      executionRoot: repository.root,
      gitCommonDir: canonicalGitDirectory(),
      releasedAt: null,
    });

    const pruned: TurnSnapshotRetentionPruneResult =
      await service.pruneSnapshotsForRun(UNSAFE_RUN_ID);

    expect(pruned).toEqual({
      runId: UNSAFE_RUN_ID,
      deletedRefs: [],
      skipped: {
        runId: UNSAFE_RUN_ID,
        reason: "unsafe-run-id",
        detail: "run id is not a safe ref path component",
      },
    });
    expect(invocations).toEqual([]);
    expect(await repository.refListing("refs/heads/")).toBe(headsBefore);
    // A REFUSAL, not a fault — no diagnostic, exactly as the capture leg's typed
    // refusals produce none.
    expect(fixture.diagnostics).toEqual([]);
  });

  it("refuses a DOT-SHAPED run id from the primitive before any git call", async () => {
    const repository: FixtureRepository = fixture.repository;
    const database: DatabaseType = openRetentionDatabase();
    const invocations: string[][] = [];
    const service: TurnSnapshotService = buildRetentionService(database, {
      git: buildRecordingRunner(invocations),
    });
    const headsBefore: string = await repository.refListing("refs/heads/");

    // The prune path reaches `isSafeRefComponent` through a DATABASE row rather
    // than through a caller's argument, so a predicate tightened only where the
    // capture leg consults it would leave this side admitting shapes the
    // enumeration then interpolates into a `for-each-ref` prefix. One shape from
    // each half of the rule: `run..1` git refuses too, `run.` git ACCEPTS
    // (measured on git 2.50.1) and only this predicate stops.
    for (const runId of ["run..1", "run."]) {
      insertRunExecutionContext(database, {
        runId,
        executionMode: "bound-root",
        executionRoot: repository.root,
        gitCommonDir: canonicalGitDirectory(),
        releasedAt: null,
      });

      expect(await service.pruneSnapshotsForRun(runId), runId).toEqual({
        runId,
        deletedRefs: [],
        skipped: {
          runId,
          reason: "unsafe-run-id",
          detail: "run id is not a safe ref path component",
        },
      });
    }

    expect(invocations).toEqual([]);
    expect(await repository.refListing("refs/heads/")).toBe(headsBefore);
    expect(fixture.diagnostics).toEqual([]);
  });

  it("drops a listing entry outside the run prefix instead of deleting it", async () => {
    const repository: FixtureRepository = fixture.repository;
    const database: DatabaseType = openRetentionDatabase();
    const headCommit: string = await repository.git(["rev-parse", "HEAD"]);
    const deletions: string[][] = [];

    // An channel a validated `runId` cannot cover: git's own pattern matching.
    // The enumeration is FABRICATED to name a branch, which is what a
    // `for-each-ref` that matched more than it was asked for would look like from
    // this module's side.
    const hostileListingRunner: TurnSnapshotGitRunner = async (argv, options) => {
      if (argv.includes("for-each-ref")) {
        return { stdout: Buffer.from(`${headCommit} refs/heads/main\n`, "utf8"), stderr: "" };
      }
      if (argv.includes("update-ref")) {
        deletions.push([...argv]);
      }
      return runTurnSnapshotGitWithExecFile(argv, options);
    };
    const service: TurnSnapshotService = buildRetentionService(database, {
      git: hostileListingRunner,
    });
    const headsBefore: string = await repository.refListing("refs/heads/");
    insertRunExecutionContext(database, {
      runId: RUN_ID,
      executionMode: "provisioned-worktree",
      executionRoot: repository.root,
      gitCommonDir: canonicalGitDirectory(),
      releasedAt: RELEASED_LONG_AGO,
    });

    const sweep: TurnSnapshotRetentionSweepResult = await service.sweepPrunableRuns();

    expect(sweep.prunedRunIds).toEqual([RUN_ID]);
    expect(sweep.deletedRefs).toEqual([]);
    expect(deletions).toEqual([]);
    expect(await repository.refListing("refs/heads/")).toBe(headsBefore);
  });

  it("refuses a ref whose oid moved since the enumeration, reporting the partial prune", async () => {
    const repository: FixtureRepository = fixture.repository;
    const database: DatabaseType = openRetentionDatabase();
    applyTurnEffects();
    const capturing: TurnSnapshotService = buildRetentionService(database);
    const first = await captureTurn(capturing, { turnOrdinal: 1 });
    const second = await captureTurn(capturing, { turnOrdinal: 2 });
    // A real object that is NOT the snapshot commit — the snapshot's own parent.
    const staleObjectId: string = await repository.git(["rev-parse", "HEAD"]);

    // The deletion names the oid the enumeration read, so it is a
    // compare-and-swap. This listing reports a STALE oid for the second ref,
    // which is what a ref that moved between the two commands would look like.
    const staleListingRunner: TurnSnapshotGitRunner = async (argv, options) => {
      if (argv.includes("for-each-ref")) {
        return {
          stdout: Buffer.from(
            `${first.snapshotCommit} ${first.ref}\n${staleObjectId} ${second.ref}\n`,
            "utf8",
          ),
          stderr: "",
        };
      }
      return runTurnSnapshotGitWithExecFile(argv, options);
    };
    insertRunExecutionContext(database, {
      runId: RUN_ID,
      executionMode: "provisioned-worktree",
      executionRoot: repository.root,
      gitCommonDir: canonicalGitDirectory(),
      releasedAt: RELEASED_LONG_AGO,
    });

    const pruned: TurnSnapshotRetentionPruneResult = await buildRetentionService(database, {
      git: staleListingRunner,
    }).pruneSnapshotsForRun(RUN_ID);

    // CONVERGENT: the refs it really deleted are reported alongside the reason
    // it stopped, rather than the pass claiming to be atomic in either
    // direction.
    expect(pruned.deletedRefs).toEqual([first.ref]);
    expect(pruned.skipped).toMatchObject({ runId: RUN_ID, reason: "ref-delete-failed" });
    expect(pruned.skipped?.detail).toContain(second.ref);
    // The compare-and-swap held: the ref whose oid disagreed still exists.
    expect(await repository.refListing("refs/sidekicks/")).toBe(
      `${second.snapshotCommit} ${second.ref}`,
    );
  });

  it("prunes a RETIRED-AND-REMOVED worktree run through git_common_dir", async () => {
    const repository: FixtureRepository = fixture.repository;
    const database: DatabaseType = openRetentionDatabase();
    const service: TurnSnapshotService = buildRetentionService(database);
    const worktreeRoot: string = join(fixture.fixtureRoot, "linked-worktree");
    await repository.git(["worktree", "add", "-q", "-b", "feature/run", worktreeRoot]);

    // What gate records at context creation, read the way it reads it — not
    // hardcoded, so the fixture cannot agree with the service by accident.
    const recordedCommonDirectory: string = await repository.git(
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd: worktreeRoot },
    );

    const captured = expectCaptured(
      await service.captureTurnSnapshot({ ...CAPTURE_DEFAULTS, executionRoot: worktreeRoot }),
    );
    // The premise, established rather than assumed: a ref written from INSIDE a
    // linked worktree lands in the SHARED common object store.
    expect(await repository.refListing("refs/sidekicks/")).toBe(
      `${captured.snapshotCommit} ${captured.ref}`,
    );

    insertRunExecutionContext(database, {
      runId: RUN_ID,
      executionMode: "provisioned-worktree",
      executionRoot: worktreeRoot,
      gitCommonDir: recordedCommonDirectory,
      releasedAt: RELEASED_LONG_AGO,
    });

    // The physical retirement: the execution root is GONE while the window is
    // still open. A sweep that pruned through `execution_root` would find
    // nothing here and leak these refs forever.
    rmSync(worktreeRoot, { recursive: true, force: true });
    await repository.git(["worktree", "prune"]);
    expect(existsSync(worktreeRoot)).toBe(false);

    const sweep: TurnSnapshotRetentionSweepResult = await service.sweepPrunableRuns();

    expect(sweep.prunedRunIds).toEqual([RUN_ID]);
    expect(sweep.deletedRefs).toEqual([captured.ref]);
    expect(sweep.skipped).toEqual([]);
    expect(await repository.refListing("refs/sidekicks/")).toBe("");
  });

  it("skips a REMOVED repository as git-dir-absent and still prunes the candidates behind it", async () => {
    const repository: FixtureRepository = fixture.repository;
    const database: DatabaseType = openRetentionDatabase();
    const service: TurnSnapshotService = buildRetentionService(database);
    applyTurnEffects();
    const survivor = expectCaptured(
      await service.captureTurnSnapshot({
        ...CAPTURE_DEFAULTS,
        runId: SIBLING_RUN_ID,
        executionRoot: repository.root,
      }),
    );
    const removedRepositoryRoot: string = join(fixture.fixtureRoot, "removed-repo");

    // The unusable candidate is released EARLIER, so it sorts FIRST. That
    // ordering is the whole test: a `try` outside the loop would strand the
    // second candidate, and the sweep would look like it had nothing to do.
    insertRunExecutionContext(database, {
      runId: RUN_ID,
      executionMode: "provisioned-worktree",
      executionRoot: removedRepositoryRoot,
      gitCommonDir: join(removedRepositoryRoot, ".git"),
      releasedAt: RELEASED_LONG_AGO,
    });
    insertRunExecutionContext(database, {
      runId: SIBLING_RUN_ID,
      executionMode: "provisioned-worktree",
      executionRoot: repository.root,
      gitCommonDir: canonicalGitDirectory(),
      releasedAt: "2026-05-02T00:00:00.000Z",
    });

    const sweep: TurnSnapshotRetentionSweepResult = await service.sweepPrunableRuns();

    expect(sweep.examinedRunIds).toEqual([RUN_ID, SIBLING_RUN_ID]);
    expect(sweep.prunedRunIds).toEqual([SIBLING_RUN_ID]);
    expect(sweep.deletedRefs).toEqual([survivor.ref]);
    expect(sweep.skipped).toHaveLength(1);
    // ABSENT, not merely unusable: the mode is `provisioned-worktree`, so nothing
    // was supposed to remove this store. A removed repository is skipped and
    // enumerated in the diagnostic.
    expect(sweep.skipped[0]).toMatchObject({ runId: RUN_ID, reason: "git-dir-absent" });
    expect(sweep.skipped[0]?.detail).toContain("not a git repository");
    // Enumerated, never fatal — and enumerated ONCE for the whole pass.
    expect(fixture.diagnostics).toEqual([
      {
        kind: "retention-prune-skipped",
        examinedRunCount: 2,
        skipped: sweep.skipped,
      },
    ]);
    expect(await repository.refListing("refs/sidekicks/")).toBe("");
  });

  it("is idempotent — a second prune of an already-pruned run no-ops", async () => {
    const repository: FixtureRepository = fixture.repository;
    const database: DatabaseType = openRetentionDatabase();
    const service: TurnSnapshotService = buildRetentionService(database);
    applyTurnEffects();
    const captured = await captureTurn(service);
    insertRunExecutionContext(database, {
      runId: RUN_ID,
      executionMode: "provisioned-worktree",
      executionRoot: repository.root,
      gitCommonDir: canonicalGitDirectory(),
      releasedAt: RELEASED_LONG_AGO,
    });

    const first: TurnSnapshotRetentionPruneResult = await service.pruneSnapshotsForRun(RUN_ID);
    const refsAfterFirst: string = await repository.refListing();
    const second: TurnSnapshotRetentionPruneResult = await service.pruneSnapshotsForRun(RUN_ID);

    expect(first).toEqual({ runId: RUN_ID, deletedRefs: [captured.ref], skipped: null });
    // Not "the same result": an EMPTY one. The second prune enumerated nothing,
    // so it issued no `update-ref -d` at all — which is why the whole ref set is
    // still byte-identical rather than merely equivalent.
    expect(second).toEqual({ runId: RUN_ID, deletedRefs: [], skipped: null });
    expect(await repository.refListing()).toBe(refsAfterFirst);
    expect(fixture.diagnostics).toEqual([]);
  });

  it("reports an absent execution-context row as a skip, not as an empty success", async () => {
    const database: DatabaseType = openRetentionDatabase();
    const service: TurnSnapshotService = buildRetentionService(database);
    const unknownRunId = "0192b3c0-9999-7c4a-9b1c-1b7c5b3e8f00";

    const pruned: TurnSnapshotRetentionPruneResult =
      await service.pruneSnapshotsForRun(unknownRunId);

    // "I found nothing" and "I could not look" must never read the same. An
    // empty `deletedRefs` with `skipped: null` is the idempotent case above.
    expect(pruned).toEqual({
      runId: unknownRunId,
      deletedRefs: [],
      skipped: {
        runId: unknownRunId,
        reason: "run-context-absent",
        detail: "no run_execution_contexts row",
      },
    });
  });

  it("diagnoses a candidate-read failure instead of rejecting into the timer", async () => {
    const database: DatabaseType = openRetentionDatabase();
    const service: TurnSnapshotService = buildRetentionService(database);
    // The prepared statement outlives the handle it was prepared on — what a
    // shutdown racing a sweep tick looks like from inside the sweep.
    database.close();

    const sweep: TurnSnapshotRetentionSweepResult = await service.sweepPrunableRuns();

    expect(sweep).toEqual({
      examinedRunIds: [],
      prunedRunIds: [],
      deletedRefs: [],
      skipped: [],
    });
    expect(fixture.diagnostics).toHaveLength(1);
    expect(fixture.diagnostics[0]).toMatchObject({ kind: "retention-sweep-failed" });
    expect((fixture.diagnostics[0] as { readonly detail: string }).detail).toContain(
      "database connection is not open",
    );
  });

  it("diagnoses a clock that did not return an ISO-8601 instant", async () => {
    const repository: FixtureRepository = fixture.repository;
    const database: DatabaseType = openRetentionDatabase();
    applyTurnEffects();
    // Captured through a service with a GOOD clock, so the fixture's refs exist
    // and the assertion below is about the sweep rather than about the capture.
    await captureTurn(buildRetentionService(database));
    const refsBefore: string = await repository.refListing("refs/sidekicks/");
    insertRunExecutionContext(database, {
      runId: RUN_ID,
      executionMode: "provisioned-worktree",
      executionRoot: repository.root,
      gitCommonDir: canonicalGitDirectory(),
      releasedAt: RELEASED_LONG_AGO,
    });

    const sweep: TurnSnapshotRetentionSweepResult = await buildRetentionService(database, {
      now: (): string => "the day before yesterday",
    }).sweepPrunableRuns();

    expect(sweep.examinedRunIds).toEqual([]);
    // Fails CLOSED: an unusable cutoff prunes nothing rather than defaulting to
    // an epoch cutoff that would have swept every run in the table.
    expect(await repository.refListing("refs/sidekicks/")).toBe(refsBefore);
    expect(fixture.diagnostics).toEqual([
      {
        kind: "retention-sweep-failed",
        // The message names the CUTOFF rather than the clock, because the `null`
        // channel now carries two causes — this one and a representable clock
        // whose difference from the window is out of Date's range.
        detail: "turn-snapshot retention cutoff is not a representable instant",
      },
    ]);
  });

  it("throws from both retention entry points when constructed without a database", async () => {
    // Capture-only wiring: no database at all.
    const service: TurnSnapshotService = buildService();

    // A mis-wired daemon must not be indistinguishable from a daemon with
    // nothing to prune, so this is the one condition the never-throws posture
    // deliberately does not cover. Asserted on the MESSAGE: without the guard,
    // an incidental `TypeError` on an undefined statement would satisfy a bare
    // `rejects.toThrow()`.
    await expect(service.sweepPrunableRuns()).rejects.toThrow(
      /retention leg needs a `database` dependency/,
    );
    await expect(service.pruneSnapshotsForRun(RUN_ID)).rejects.toThrow(
      /retention leg needs a `database` dependency/,
    );
    expect(fixture.diagnostics).toEqual([]);
  });

  it("renders the skip enumeration through the default console.warn sink", async () => {
    const database: DatabaseType = openRetentionDatabase();
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {
      /* the rendering is the assertion; the output is not wanted in the run */
    });
    // Built WITHOUT `emitDiagnostic`, so the default sink is exercised rather
    // than described. TRIPWIRE, as on the capture-leg case: this is the interim
    // `console.warn` standing in for the OTel diagnostic.
    const service = new TurnSnapshotService({
      executionRootsDirectory: fixture.executionRootsDirectory,
      database,
      now: () => RETENTION_NOW,
    });
    insertRunExecutionContext(database, {
      runId: UNSAFE_RUN_ID,
      executionMode: "bound-root",
      executionRoot: fixture.repository.root,
      gitCommonDir: canonicalGitDirectory(),
      releasedAt: RELEASED_LONG_AGO,
    });

    await service.sweepPrunableRuns();

    // The PASS-scoped kinds render their own identity line: the shared one would
    // print `run=undefined epoch=undefined turn=undefined`, since a sweep spans
    // runs and no turn at all.
    expect(warnings).toHaveBeenCalledTimes(1);
    expect(warnings).toHaveBeenCalledWith(
      "turn-snapshot retention-prune-skipped: skipped=1 of examined=1",
      expect.objectContaining({ kind: "retention-prune-skipped", examinedRunCount: 1 }),
    );
  });

  it("renders a sweep failure through the default console.warn sink", async () => {
    const database: DatabaseType = openRetentionDatabase();
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {
      /* see above */
    });
    const service = new TurnSnapshotService({
      executionRootsDirectory: fixture.executionRootsDirectory,
      database,
      now: () => "not an instant",
    });

    await service.sweepPrunableRuns();

    expect(warnings).toHaveBeenCalledTimes(1);
    expect(warnings).toHaveBeenCalledWith(
      "turn-snapshot retention-sweep-failed: " +
        "turn-snapshot retention cutoff is not a representable instant",
      expect.objectContaining({ kind: "retention-sweep-failed" }),
    );
  });

  it("refuses a retention window that would delete what the leg exists to keep", () => {
    // The window is the one input to this leg whose bad values fail OPEN: zero
    // or negative puts the cutoff at or AFTER now, so every terminal run matches
    // and the first sweep silently deletes snapshots the policy meant to keep.
    // `NaN` / `Infinity` fail closed but opaquely, throwing "Invalid time value"
    // from inside the sweep every tick while retention never runs. Refused at
    // construction, where the typo is, rather than an hour later.
    for (const retentionWindowMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => buildService({ retentionWindowMs })).toThrow(RangeError);
      expect(() => buildService({ retentionWindowMs })).toThrow(/retentionWindowMs must be/);
    }
    // A positive window still constructs, so the guard is a statement about the
    // bad values and not about the parameter.
    expect(() => buildService({ retentionWindowMs: 1 })).not.toThrow();
  });

  it("refuses a retention window too large to subtract from a clock", () => {
    // The third failure direction, and it does not look like a typo at all:
    // `Number.MAX_SAFE_INTEGER` is how somebody spells "keep everything". It is
    // finite and positive, so the guard above passes it, and every cutoff is then
    // unrepresentable — `toISOString()` throws `RangeError: Invalid time value`
    // from inside the sweep's own `try`, on every tick, forever. Retention is
    // disabled and the daemon reports a sweep that ran.
    expect(() => buildService({ retentionWindowMs: Number.MAX_SAFE_INTEGER })).toThrow(RangeError);
    expect(() => buildService({ retentionWindowMs: Number.MAX_SAFE_INTEGER })).toThrow(
      /no greater than 8640000000000000/,
    );

    // The BOUNDARY, both sides, so the constant is pinned rather than approximated:
    // ECMAScript's Date range is ±8.64e15 ms, and a window of exactly that is
    // still subtractable from an epoch-adjacent clock.
    expect(() => buildService({ retentionWindowMs: 8_640_000_000_000_000 })).not.toThrow();
    expect(() => buildService({ retentionWindowMs: 8_640_000_000_000_001 })).toThrow(RangeError);
  });

  it("reports an unrepresentable cutoff as a skip rather than throwing from the sweep", async () => {
    const repository: FixtureRepository = fixture.repository;
    const database: DatabaseType = openRetentionDatabase();
    applyTurnEffects();
    await captureTurn(buildRetentionService(database));
    const refsBefore: string = await repository.refListing("refs/sidekicks/");
    insertRunExecutionContext(database, {
      runId: RUN_ID,
      executionMode: "provisioned-worktree",
      executionRoot: repository.root,
      gitCommonDir: canonicalGitDirectory(),
      releasedAt: RELEASED_LONG_AGO,
    });

    // The residual the constructor bound CANNOT close, which is why the cutoff
    // carries the other half of the defense: BOTH inputs here are individually
    // accepted — the window is exactly the permitted maximum and the clock is a
    // perfectly well-formed ISO instant — and only their DIFFERENCE is outside
    // Date's range. A bound on one term cannot see that.
    const sweep: TurnSnapshotRetentionSweepResult = await buildRetentionService(database, {
      retentionWindowMs: 8_640_000_000_000_000,
      now: (): string => "1900-01-01T00:00:00.000Z",
    }).sweepPrunableRuns();

    // Routed into the EXISTING invalid-clock channel rather than a second
    // mechanism: a reported failure and a fail-closed sweep, not a `RangeError`
    // escaping into the timer.
    expect(sweep.examinedRunIds).toEqual([]);
    expect(await repository.refListing("refs/sidekicks/")).toBe(refsBefore);
    expect(fixture.diagnostics).toEqual([
      {
        kind: "retention-sweep-failed",
        detail: "turn-snapshot retention cutoff is not a representable instant",
      },
    ]);
  });

  it("reports an unreadable execution-context row as its OWN reason, and diagnoses it", async () => {
    const database: DatabaseType = openRetentionDatabase();
    const service: TurnSnapshotService = buildRetentionService(database);
    // A prepared statement outliving the handle it was prepared on — a shutdown
    // racing an operator-triggered prune.
    database.close();

    const pruned: TurnSnapshotRetentionPruneResult = await service.pruneSnapshotsForRun(RUN_ID);

    // NOT `run-context-absent`. A consumer switching on the reason would
    // otherwise conclude the run has no execution context and there was nothing
    // to prune, when the refs are still there and the prune must be retried.
    expect(pruned.skipped).toMatchObject({ runId: RUN_ID, reason: "run-context-unreadable" });
    expect(pruned.skipped?.detail).toContain("database connection is not open");
    expect(pruned.deletedRefs).toEqual([]);
    // And diagnosed, exactly as the sweep's equivalent candidate-read failure is:
    // the two are the same fault reached from the two entry points. The `runId`
    // is what keeps the SHARED kind attributable from this side — the sweep's
    // emitter is pass-scoped and omits it, which the whole-object `toEqual`
    // above ("diagnoses a clock that did not return an ISO-8601 instant") pins as
    // this assertion's negative control.
    expect(fixture.diagnostics).toHaveLength(1);
    expect(fixture.diagnostics[0]).toMatchObject({
      kind: "retention-sweep-failed",
      runId: RUN_ID,
    });
  });

  it("attributes a PRESENT-but-unusable git dir to the fault arm, and raises the warn", async () => {
    const database: DatabaseType = openRetentionDatabase();
    // The git dir is really there — this is the `EACCES` / corrupt-store /
    // missing-binary class, which git answers with the same rejection a removed
    // repository draws. Only the probe tells them apart, and misreading this one
    // as an absence is how a genuine fault goes quiet.
    const refusingRunner: TurnSnapshotGitRunner = async (argv, options) => {
      if (argv.includes("for-each-ref")) {
        throw new Error("fatal: cannot access '.': Permission denied");
      }
      return runTurnSnapshotGitWithExecFile(argv, options);
    };
    const service: TurnSnapshotService = buildRetentionService(database, { git: refusingRunner });
    insertRunExecutionContext(database, {
      runId: RUN_ID,
      executionMode: "provisioned-worktree",
      executionRoot: fixture.repository.root,
      gitCommonDir: canonicalGitDirectory(),
      releasedAt: RELEASED_LONG_AGO,
    });
    expect(existsSync(canonicalGitDirectory())).toBe(true);

    const sweep: TurnSnapshotRetentionSweepResult = await service.sweepPrunableRuns();

    expect(sweep.skipped).toHaveLength(1);
    expect(sweep.skipped[0]).toMatchObject({ runId: RUN_ID, reason: "git-dir-unusable" });
    expect(fixture.diagnostics).toEqual([
      {
        kind: "retention-prune-skipped",
        examinedRunCount: 1,
        skipped: sweep.skipped,
      },
    ]);
  });

  it("fails TOWARD the fault arm when the probe itself cannot answer", async () => {
    const database: DatabaseType = openRetentionDatabase();
    const service: TurnSnapshotService = buildRetentionService(database);
    // A path component past the OS limit: `stat` rejects with `ENAMETOOLONG`,
    // not `ENOENT`. The distinction is the point — a probe that treated every
    // error as absence would call this a removal and go silent, which is
    // exactly how a live `EACCES` on a real store would be lost. Only a PROVABLE
    // absence is an absence.
    const unprobeableGitDirectory: string = join(fixture.fixtureRoot, "x".repeat(300), ".git");
    insertRunExecutionContext(database, {
      runId: RUN_ID,
      executionMode: "provisioned-worktree",
      executionRoot: join(fixture.fixtureRoot, "x".repeat(300)),
      gitCommonDir: unprobeableGitDirectory,
      releasedAt: RELEASED_LONG_AGO,
    });

    const sweep: TurnSnapshotRetentionSweepResult = await service.sweepPrunableRuns();

    expect(sweep.skipped).toHaveLength(1);
    expect(sweep.skipped[0]).toMatchObject({ runId: RUN_ID, reason: "git-dir-unusable" });
    expect(fixture.diagnostics).toHaveLength(1);
  });

  it("drops a listing entry whose OID is not an object id, before it reaches an argv", async () => {
    const database: DatabaseType = openRetentionDatabase();
    const invocations: string[][] = [];
    const capturing: TurnSnapshotService = buildRetentionService(database);
    applyTurnEffects();
    const captured = await captureTurn(capturing);

    // The other half of the listing guard. This line's REF is under the correct
    // prefix, so the prefix check passes it — what disqualifies it is the field
    // git would have filled with an object id, here carrying a git OPTION. The
    // deletion argv is `update-ref -d <ref> <oid>`, so an unchecked value there
    // is a flag in a command that deletes refs.
    const forgedOidRunner: TurnSnapshotGitRunner = async (argv, options) => {
      invocations.push([...argv]);
      if (argv.includes("for-each-ref")) {
        return {
          stdout: Buffer.from(`--upload-pack=x ${captured.ref}\n`, "utf8"),
          stderr: "",
        };
      }
      return runTurnSnapshotGitWithExecFile(argv, options);
    };
    insertRunExecutionContext(database, {
      runId: RUN_ID,
      executionMode: "provisioned-worktree",
      executionRoot: fixture.repository.root,
      gitCommonDir: canonicalGitDirectory(),
      releasedAt: RELEASED_LONG_AGO,
    });

    const pruned: TurnSnapshotRetentionPruneResult = await buildRetentionService(database, {
      git: forgedOidRunner,
    }).pruneSnapshotsForRun(RUN_ID);

    expect(pruned).toEqual({ runId: RUN_ID, deletedRefs: [], skipped: null });
    expect(invocations.filter((argv) => argv.includes("update-ref"))).toEqual([]);
    // The ref the forged line named is untouched, which is what "dropped" means
    // here rather than "refused".
    expect(await fixture.repository.refListing("refs/sidekicks/")).toBe(
      `${captured.snapshotCommit} ${captured.ref}`,
    );
  });

  it("keeps sweeping past a run whose deletion was refused mid-way", async () => {
    const repository: FixtureRepository = fixture.repository;
    const database: DatabaseType = openRetentionDatabase();
    applyTurnEffects();
    const capturing: TurnSnapshotService = buildRetentionService(database);
    const first = await captureTurn(capturing, { turnOrdinal: 1 });
    const second = await captureTurn(capturing, { turnOrdinal: 2 });
    const behind = expectCaptured(
      await capturing.captureTurnSnapshot({
        ...CAPTURE_DEFAULTS,
        runId: SIBLING_RUN_ID,
        executionRoot: repository.root,
      }),
    );
    const staleObjectId: string = await repository.git(["rev-parse", "HEAD"]);

    // The FIRST candidate's second ref reports a stale oid, so its
    // compare-and-swap deletion is refused halfway through that run. The
    // candidate BEHIND it must still be pruned — a per-run refusal is a returned
    // value, not a throw, and starving the queue behind one bad ref is the
    // failure mode the never-fatal rule is written against.
    const staleListingRunner: TurnSnapshotGitRunner = async (argv, options) => {
      if (
        argv.includes("for-each-ref") &&
        argv.some((entry) => entry.includes(RUN_ID) && !entry.includes(SIBLING_RUN_ID))
      ) {
        return {
          stdout: Buffer.from(
            `${first.snapshotCommit} ${first.ref}\n${staleObjectId} ${second.ref}\n`,
            "utf8",
          ),
          stderr: "",
        };
      }
      return runTurnSnapshotGitWithExecFile(argv, options);
    };
    insertRunExecutionContext(database, {
      runId: RUN_ID,
      executionMode: "provisioned-worktree",
      executionRoot: repository.root,
      gitCommonDir: canonicalGitDirectory(),
      releasedAt: RELEASED_LONG_AGO,
    });
    insertRunExecutionContext(database, {
      runId: SIBLING_RUN_ID,
      executionMode: "provisioned-worktree",
      executionRoot: repository.root,
      gitCommonDir: canonicalGitDirectory(),
      releasedAt: "2026-05-02T00:00:00.000Z",
    });

    const sweep: TurnSnapshotRetentionSweepResult = await buildRetentionService(database, {
      git: staleListingRunner,
    }).sweepPrunableRuns();

    expect(sweep.examinedRunIds).toEqual([RUN_ID, SIBLING_RUN_ID]);
    expect(sweep.prunedRunIds).toEqual([SIBLING_RUN_ID]);
    // The partial deletion is reported alongside the run that finished behind it.
    expect(sweep.deletedRefs).toEqual([first.ref, behind.ref]);
    expect(sweep.skipped).toHaveLength(1);
    expect(sweep.skipped[0]).toMatchObject({ runId: RUN_ID, reason: "ref-delete-failed" });
    // The compare-and-swap held: the ref whose oid disagreed still exists, and it
    // is the only thing left.
    expect(await repository.refListing("refs/sidekicks/")).toBe(
      `${second.snapshotCommit} ${second.ref}`,
    );
  });
});
