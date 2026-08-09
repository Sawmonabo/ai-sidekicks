// Plan-010 Phase 5 — T5.1, the turn-snapshot CAPTURE leg; T5.2, the two-phase
// RESTORE leg (`resolveRestoreTarget` + `restoreToTurn`); and T5.3, the
// window-based RETENTION prune (`sweepPrunableRuns` + `pruneSnapshotsForRun`)
// with its sanctioned `../../bootstrap/index.ts` wiring seam.
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
//   * the hook-neutralization, allowlist and validation cases have to read the
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
//   * `Spec-010 §Turn-Boundary Snapshots` — the capture temp-index recipe: the
//     single base OID reused for tree base and recorded parent; `git add -A`
//     tree equivalence including the untracked-embedded-repo `160000` gitlink;
//     the embedded repository skipped and enumerated when its `HEAD` yields no
//     OID the superproject index can hold — commitless, and the MIXED OBJECT
//     FORMAT case in both directions, which is a healthy repository whose OID is
//     simply the wrong width; ignore
//     semantics (project-declared rules only, tracking wins over ignoring); the
//     `core.autocrlf` / `core.attributesFile` / `i18n.commitEncoding` pins and
//     the `core.excludesFile` non-consultation that make the OID host-
//     independent, plus the `core.safecrlf` pin that makes capture's SUCCESS
//     host-independent — against the project's own `text` attribute a host
//     `true` is otherwise fatal, and an uncaptured turn is an unrollbackable
//     one; the `core.eol` NON-pin on this leg, driven as its own case rather
//     than left as an assumption — two captures either side of a host
//     `core.eol=crlf` produce the identical tree OID, which is the evidence
//     behind the service's disposition table calling that knob checkout-only;
//     the create-only `update-ref` and its per-epoch idempotence;
//     the writable-modes-only applicability rule, exercised across ALL THREE
//     writable modes and the one non-applicable mode; and the out-of-worktree
//     scratch index, asserted against the execution root's OWN index rather than
//     only against stray worktree content.
//   * `Spec-004 §Required Behavior` — the execution epoch is the CALLER's value
//     (`0` before any rollback, advanced with each accepted `run.rolled_back`),
//     placed in the ref verbatim and never derived here (CP-010-12).
//   * `Spec-010 §Turn-Boundary Snapshots` — the RETENTION prune, driven over a
//     REAL migrated SQLite database rather than a stubbed row source, because
//     the claim is about a predicate over `run_execution_contexts` and a fake
//     table would assert it against the fake: terminal-but-inside-the-window
//     refs survive (the case that makes "prunes at terminal" fail), an elapsed
//     window prunes while a still-open run — `released_at IS NULL` — survives
//     beside it, and the window boundary is driven to the exact millisecond in
//     both directions. The `git_common_dir` leg is exercised against a REAL
//     linked worktree that is then really removed, which is the only fixture in
//     which "the refs outlive the execution root" is a fact rather than a
//     stipulation; the ephemeral-clone disposal boundary against a real clone,
//     asserted non-vacuously (the canonical repository is shown NEVER to have
//     held those refs, so "the sweep found nothing" is a statement about the
//     clone's store and not about an empty fixture); and the skip enumeration
//     against a pass whose FIRST candidate is unusable, so "never fatal" is
//     asserted as the later candidates still being pruned.
//
// Verifies invariant:
//
//   * I-010-21 — snapshot refs live only under `refs/sidekicks/runs/…`, never
//     `refs/heads/`, and are invisible to branch history. Asserted as ground
//     truth (`for-each-ref refs/heads/` byte-identical across the capture,
//     `branch --contains <snapshot>` empty, `HEAD` unmoved), at the namespace
//     boundary (a `runId` that would escape is refused before any git call) and
//     on the environment channel the ref-path guard cannot reach (a capture run
//     under an ambient `GIT_DIR` + `GIT_OBJECT_DIRECTORY` still lands in the
//     EXECUTION ROOT's own store, with the decoy repository empty).
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
//   * I-010-22 — create-only, PER-EPOCH refs. The discriminating case mutates
//     the worktree between two captures of the same `(runId, epoch, turnOrdinal)`
//     and asserts the ref did not move, which is what "never repoints an existing
//     ref at later file state" means; the epoch case then asserts the superseded
//     epoch's ref SURVIVES beside the fresh one.
//   * I-010-23 — fail-closed, two-phase restore. The resolver's non-mutation is
//     asserted as a byte census of the whole worktree plus the raw index file, on
//     a REFUSED and an ACCEPTED resolve alike (the index fingerprint carrying its
//     own negative control, so "unchanged" is a claim about the resolver rather
//     than about the helper); the precondition is refused at ALL FOUR of its
//     checks, each with the property that distinguishes it — a `HEAD` advanced
//     before the resolve; the entry re-verify, asserted to have spawned exactly
//     one invocation, so the refusal costs no derivation; a `HEAD` moving DURING
//     the derivation, asserted byte-identical, since the later check would refuse
//     too but only after rewriting the tree; and a `HEAD` moving after the
//     checkout, which is a `partial_restore` at `close-index` with the index
//     proven to still hold the SNAPSHOT tree rather than closed against the moved
//     `HEAD`. That last guard is driven by BOTH of its causes, since they share an
//     arm and a `failedStep` but not a recovery property — the moved `HEAD` and an
//     unreadable one, separated only by the diagnostic detail, each asserted to
//     carry its own wording and not the other's. Both fail-closed `null` arms are
//     driven (an unreadable recorded parent, an unreadable `HEAD` on the
//     destructive leg). The lineage walk is driven across a two-epoch fixture
//     including the inheritance boundary at the rewind base, with the gap case
//     asserting the superseded epoch's
//     same-ordinal ref STILL EXISTS and was still not resolved; the
//     partial-restore enumerations are asserted against on-disk ground truth on
//     an injected mid-sequence failure, on a real in-command `read-tree` failure,
//     and on a pre-mutation failure whose fixture deliberately HAS both a
//     collision and a divergent gitlink — so the empty pair is a statement about
//     what was applied rather than about what the fixture happened to contain;
//     the COLLISION enumeration is driven through all three shapes the checkout
//     destroys through — the shared path, a snapshot file replacing a directory
//     of ignored content, and an ignored file squatting a directory the snapshot
//     needs — each against on-disk ground truth, and each beside a control that
//     shares CHARACTERS without sharing a segment boundary (`collidex/…` under a
//     tracked `collide`, an ignored `sibling` under a tracked
//     `sibling-prefix.txt`) or shares a directory without obstructing it;
//     the collision fingerprint is driven as a TYPE-AWARE observation, through the
//     two shapes a bytes-only one could not see and which are therefore each
//     asserted with an in-case control that reproduces the blindness: an ignored
//     DANGLING SYMLINK destroyed by the checkout (unreadable before as `ENOENT`
//     and after as `EISDIR`, so the old form scored `null` on both sides and
//     dropped the loss out of the report), and an ignored LIVE SYMLINK replaced by
//     a byte-identical regular file (the bytes through the link are asserted equal
//     to the restored bytes, so only the entry TYPE distinguishes them — the
//     `lstat`-not-`stat` corner). Both drive an induced mid-sequence failure,
//     because the `restored` arm reports the prospective set verbatim and never
//     consults the comparison;
//     and a target the service never minted is refused with nothing mutated —
//     twice over, by a cast object literal and by a `Reflect.construct` that
//     really does reach the erased-at-emit private constructor, which is the
//     forgery a brand FIELD would have admitted — against the negative control of
//     a genuine one that is accepted.
//
// Several behaviours are pinned as GIT FACTS this suite established rather than
// reasoned about, measured on git 2.50.1 unless the item says otherwise: the
// delete pass's two non-fixpoint exits (the no-progress detection naming its
// stuck path, and the pass ceiling driven to its exact count by a seam whose
// removals keep minting new content); `ls-files -o` declining to descend into a
// path the index holds as a `160000` gitlink — so post-boundary content inside a
// snapshot-gitlink path survives the restore, asserted beside the control that
// identical content outside it does not; a `run-A/` enumeration pattern not
// matching a sibling `run-AB`; and both halves of the `--no-deref` measurement —
// unflagged, `update-ref -d` on an in-namespace symref deletes its REFERENT (a
// branch) at exit 0, and an unflagged create-only CAS through a DANGLING one
// mints the branch it points at, the latter measured on git 2.50.1 and on git
// 2.54.0 alike (which is why that case's `refs/heads/` assertions sit outside its
// version branch). The FLAGGED forms act on the validated name and leave
// `refs/heads/` alone on every git measured, and that is the half each case
// asserts; what the flagged CREATE then REPORTS is version-dependent, and the
// case accepts either answer — see the I-010-21 entry above for the split, rather
// than a second copy of it here.
//
// The RESTORE checkout's obstruction handling is measured the same way, because
// the collision enumeration is a claim about what `read-tree --reset -u` destroys
// rather than about what it reports: it exits 0 while replacing a directory of
// ignored content with a snapshot FILE, and while unlinking an ignored file to
// make room for a directory the snapshot needs. `ls-files -o -i` reports an
// ignored EMBEDDED REPOSITORY as a trailing-slash directory entry — the one
// non-file spelling in that listing, and only while the current index holds
// nothing beneath it — and both of that entry's dispositions are pinned: taken
// whole, `.git` included, by a snapshot file at its path, and merely populated,
// `.git` intact, when the snapshot holds a path BENEATH it. A snapshot `160000`
// entry needs a DIRECTORY at its path even though it writes no bytes there, so
// the three gitlink dispositions are pinned separately and must stay apart: an
// ignored FILE at a gitlink's own path, and one at an ancestor directory of a
// deeper gitlink, are unlinked by the materializing checkout and are asserted to
// be ENUMERATED (the gitlink seeds the required-directory set, so the ignored
// path is reported as destroyed, beside the `divergentGitlinks` entry for the
// gitlink itself, which reports a different fact about a different path); an
// ignored DIRECTORY at a gitlink's own path survives untouched and is asserted
// NOT enumerated; and ignored content BENEATH a gitlink path is likewise neither
// enumerated nor deleted, which is what a derivation putting `160000` entries in
// the TRACKED set would get wrong in the opposite direction.
//
// Each host-config pin carries a NEGATIVE CONTROL in the same case: the fixture
// re-runs the equivalent leg WITHOUT the pin and the assertion is that the
// result differs. A stability assertion whose pin was already inert would
// otherwise pass for the wrong reason. `core.safecrlf`'s control differs in KIND
// rather than in degree — unpinned, the equivalent staging leg does not produce
// a different tree, it exits fatal. `core.eol`'s case carries TWO controls,
// because that pin's authority is conditional: unpinned the checkout follows the
// host and lands CRLF, and under a host `core.autocrlf=true` the pin is ignored
// and CRLF lands anyway — so the two conversion pins are shown to be
// individually load-bearing rather than one restating the other's default.
// `core.fileMode` is NOT a pin, and its two capture cases are built the opposite
// way round: they carry a PORCELAIN control rather than an unpinned one. The
// service honors that knob as probe-written capability config, so the claim to
// hold is `git add -A` equivalence under whatever the host says — which means
// the reference each case compares against is porcelain under the SAME config,
// not the same leg minus a pin. The pair is the point: one case takes a
// turn-CREATED executable (bit lost, and porcelain loses it identically — the
// recorded residual), the other a file executable IN THE BASE COMMIT (recorded
// `100755` kept, and porcelain keeps it identically). A `-c core.fileMode=true`
// pin passes the first and FAILS the second, destroying a recorded exec bit the
// turn never touched, and that second cell is why the pin was removed.
//
// The service's disposition table records `core.sparseCheckout` as an open
// RESIDUAL rather than a pin, and this suite characterizes it rather than
// blessing it: a sparse execution root's out-of-cone content is measured being
// dropped from the snapshot tree at CAPTURE — the root cause, since the scratch
// index carries no skip-worktree bits — and then lost from the worktree across a
// restore that still reports `restored` with both enumerations empty. The
// negative control in that case is the pin deliberately NOT added: a checkout leg
// carrying `-c core.sparseCheckout=false` reproduces the identical loss, so the
// case also documents why adding it would buy only a quieter failure.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Database as DatabaseType } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ExecutionMode } from "@ai-sidekicks/contracts";

import { wireTurnSnapshotRetentionSweep } from "../../bootstrap/index.js";
import { openDatabase } from "../../session/migration-runner.js";
import {
  DEFAULT_TURN_SNAPSHOT_RETENTION_WINDOW_MS,
  DEFAULT_TURN_SNAPSHOT_SWEEP_CADENCE_MS,
  SNAPSHOT_NEUTRALIZED_GIT_ENV_KEYS,
  // A VALUE import, not a type-only one: the forgery case needs the class object
  // itself to prove that `Reflect.construct` reaches the erased-at-emit private
  // constructor and is still refused.
  TurnSnapshotRestoreTarget,
  TurnSnapshotService,
  registerTurnSnapshotRetentionSweep,
  runTurnSnapshotGitWithExecFile,
  type ResolveRestoreTargetInput,
  type TurnSnapshotCaptureResult,
  type TurnSnapshotCaptureStep,
  type TurnSnapshotCaptured,
  type TurnSnapshotDiagnostic,
  type TurnSnapshotFilesystem,
  type TurnSnapshotGitRunner,
  type TurnSnapshotPartialRestore,
  type TurnSnapshotResolution,
  type TurnSnapshotRestoreResult,
  type TurnSnapshotRestoreStep,
  type TurnSnapshotRestored,
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
 * The per-case budget for the two MULTI-SEQUENCE cases in this file.
 *
 * Every other case here spawns one capture and/or one restore and lands around a
 * second; two do not, and their cost is set by a count rather than by a fixed
 * handful of spawns — the delete-pass ceiling drives 64 sequential passes, and
 * the host-independence case runs four whole capture pipelines plus a porcelain
 * negative control per pin. Measured across four full runs of this file they
 * peaked at over five seconds and at 3.2s respectively, against Vitest's 5s
 * default (this package sets no `testTimeout`), and the first of them really did
 * time out once on a loaded machine. That is a machine-speed flake, not a
 * regression, and the honest fix is a budget sized to the work rather than a
 * suite that fails when something else is compiling.
 *
 * Deliberately LARGER than {@link FIXTURE_GIT_TIMEOUT_MS}, not equal to it, and
 * that buys exactly one thing: a hung FIXTURE spawn — `spawnFixtureGit`, and the
 * `waitUntilSettled` deadline — hits its own 30s limit first, so the case fails
 * naming the leg rather than reporting a bare "Test timed out". It does NOT
 * cover the SERVICE's spawns, which are most of the work in both governed cases:
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
 * surfaces here as a census failure rather than as silently widened behaviour
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
): Promise<FixtureGitResult> {
  return new Promise<FixtureGitResult>((resolve, reject) => {
    execFile(
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
    return spawnFixtureGit(argv, environment, options.cwd ?? this.root);
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

  /** Loose + packed object census, for the read-only no-op's zero-objects claim. */
  objectCensus(): Promise<string> {
    return this.git(["count-objects", "-v"]);
  }

  /**
   * The tree porcelain `git add -A` would stage from the current worktree — the
   * REFERENCE the capture pipeline is measured against.
   *
   * Staged against a COPY of the real index rather than the real one, so the
   * fixture's own state is untouched and the answer is the true porcelain answer
   * (an empty scratch index would make every tracked deletion invisible, since
   * there would be nothing in the index to delete).
   */
  async porcelainAddAllTree(scratchIndexPath: string): Promise<string> {
    copyFileSync(join(this.root, ".git", "index"), scratchIndexPath);
    const overrides = { GIT_INDEX_FILE: scratchIndexPath };
    // Exit status only. `git add -A` writes an embedded-repository WARNING to
    // stderr on the gitlink fixtures and still exits 0.
    await this.git(["add", "-A"], { environmentOverrides: overrides });
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
  // Ambient environment stubs are per-case (the strip-list behavioural case is
  // the only one that sets any); unstubbed here as well as in that case's own
  // `finally`, so a future case cannot leak one into its neighbours.
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
  /** T5.3 only. The capture and restore cases construct WITHOUT one (CP-010-12). */
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
    removeDirectoryIfEmpty(): Promise<void> {
      // Unreachable on the capture path these cases drive; present because the
      // seam is the service's whole mutation surface, not a capture-only one.
      return Promise.resolve();
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

const CAPTURE_DEFAULTS = { runId: RUN_ID, epoch: 0, turnOrdinal: 1, mode: "worktree" } as const;

// ----------------------------------------------------------------------------
// Restore harness (T5.2)
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

/**
 * Resolver inputs against the fixture repository. The default lineage is a run
 * that has never been rolled back — `Spec-004 §Required Behavior`'s epoch `0`,
 * whose rewind base is the position it rewound from, which is nothing.
 */
function buildResolveInput(
  overrides: Partial<ResolveRestoreTargetInput> = {},
): ResolveRestoreTargetInput {
  return {
    executionRoot: fixture.repository.root,
    runId: RUN_ID,
    targetPosition: 1,
    epochLineage: [{ epoch: 0, rewindBase: 0 }],
    ...overrides,
  };
}

/** Narrow to the accepted resolution, failing the case with the actual arm if not. */
function expectResolved(resolution: TurnSnapshotResolution): TurnSnapshotRestoreTarget {
  expect(resolution.outcome).toBe("resolved");
  if (resolution.outcome !== "resolved") {
    throw new Error("unreachable — asserted above");
  }
  return resolution;
}

/** Narrow to the completed restore. */
function expectRestored(result: TurnSnapshotRestoreResult): TurnSnapshotRestored {
  expect(result.outcome).toBe("restored");
  if (result.outcome !== "restored") {
    throw new Error("unreachable — asserted above");
  }
  return result;
}

/** Narrow to the partial restore. */
function expectPartialRestore(result: TurnSnapshotRestoreResult): TurnSnapshotPartialRestore {
  expect(result.outcome).toBe("partial_restore");
  if (result.outcome !== "partial_restore") {
    throw new Error("unreachable — asserted above");
  }
  return result;
}

/**
 * A byte census of the whole worktree: every directory, every file with a
 * content hash, depth-first and name-sorted.
 *
 * This is what "byte-identical" is asserted with, rather than a handful of named
 * files: a restore that left one post-snapshot file behind, pruned one directory
 * too many, or smudged one path differently shows up here without the case
 * having predicted which path it would be.
 *
 * `.git` is censused as a PRESENCE only. Its contents churn for reasons that are
 * not worktree bytes (index stat data, reflogs, loose objects the fixture's own
 * reads mint), and a nested one — an embedded repository's — would drag the same
 * churn in at depth.
 */
function collectWorktreeCensus(root: string): string {
  const lines: string[] = [];
  const walk = (relative: string): void => {
    const absolute: string = relative === "" ? root : join(root, relative);
    const entries = readdirSync(absolute, { withFileTypes: true });
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      const childRelative: string = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.name === ".git") {
        lines.push(`git-dir ${childRelative}`);
        continue;
      }
      if (entry.isDirectory()) {
        lines.push(`dir ${childRelative}`);
        walk(childRelative);
        continue;
      }
      const digest: string = createHash("sha256")
        .update(readFileSync(join(root, childRelative)))
        .digest("hex");
      lines.push(`file ${childRelative} ${digest}`);
    }
  };
  walk("");
  return lines.join("\n");
}

/**
 * A hash of the execution root's REAL index file.
 *
 * The resolver's non-mutation claim covers the index as well as the worktree,
 * and the index is where a stray `read-tree`, `add` or `checkout` would land
 * without changing a single worktree byte. Raw file bytes rather than
 * `ls-files --stage`, so even a rewritten-but-equivalent index fails.
 */
function readIndexFingerprint(root: string): string {
  return createHash("sha256")
    .update(readFileSync(join(root, ".git", "index")))
    .digest("hex");
}

/**
 * Move `HEAD` to a new commit whose TREE is the current `HEAD`'s, leaving the
 * index and the worktree untouched.
 *
 * This is what a user terminal committing in the execution root looks like to
 * the restore's `HEAD` checks, without the side effects that would confound the
 * assertions those cases make: `git commit` mid-sequence would commit whatever
 * the index happens to hold — which, between `read-tree` and `close-index`, is
 * the SNAPSHOT tree — and a worktree write would move the census the case is
 * measuring. Plumbing keeps the move to exactly one fact.
 *
 * Returns the new commit, which is the `observedHead` the refusal must report.
 */
async function advanceHeadWithoutTouchingWorktree(message: string): Promise<string> {
  const repository: FixtureRepository = fixture.repository;
  const tree: string = await repository.git(["rev-parse", "HEAD^{tree}"]);
  const parent: string = await repository.git(["rev-parse", "HEAD"]);
  const commit: string = await repository.git(["commit-tree", tree, "-p", parent, "-m", message]);
  await repository.git(["update-ref", "HEAD", commit]);
  return commit;
}

/**
 * The errno a plain byte read of `path` fails with, or `null` when it succeeds.
 *
 * The collision cases' negative control for the TYPE-AWARE fingerprint: it
 * reproduces what a bytes-only fingerprint could observe, so a case can assert
 * that the old form was blind here rather than asserting it in prose. It is
 * never the thing under test — the assertion under test is always the
 * `overwrittenIgnoredPaths` the service produced.
 */
function readFileErrorCode(path: string): string | null {
  try {
    readFileSync(path);
    return null;
  } catch (reason: unknown) {
    return (reason as NodeJS.ErrnoException).code ?? "UNKNOWN";
  }
}

/**
 * A git seam that fails the DELETE PASS's untracked listing and passes
 * everything else through to the production runner.
 *
 * The `-i`-free listing is the delete pass's; the derivation's carries `-i` and
 * must still run, or the collision enumeration under test would be vacuous. This
 * is the only way to reach `#failRestore` with the checkout already applied,
 * which is where the fingerprint comparison lives — the `restored` arm reports
 * the prospective set verbatim and never consults it.
 */
function buildUntrackedListingFailure(): TurnSnapshotGitRunner {
  return async (argv, options) => {
    if (argv.includes("ls-files") && argv.includes("-o") && !argv.includes("-i")) {
      throw new Error("induced untracked-listing failure");
    }
    return runTurnSnapshotGitWithExecFile(argv, options);
  };
}

/** The turn's post-snapshot effects: an edit, a deletion, new files, a new tree. */
function applyPostSnapshotEffects(): void {
  const repository: FixtureRepository = fixture.repository;
  repository.write("tracked.txt", "tracked v3 — written after the snapshot boundary\n");
  rmSync(join(repository.root, "created.txt"));
  repository.write("post-snapshot.txt", "arrived after the boundary\n");
  repository.write("post-dir/deeper/arrived.txt", "arrived deeper\n");
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

    // The ref path is spelled LITERALLY — `Spec-010 §Turn-Boundary Snapshots`'s
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

  it("keeps snapshot refs out of branch history entirely (I-010-21)", async () => {
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
    // preparation and diff attribution see nothing (Spec-011 no-impact).
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

  it("keeps the snapshot message's bytes when nothing was skipped, and records the skips when something was", async () => {
    const repository: FixtureRepository = fixture.repository;
    applyTurnEffects();
    const service: TurnSnapshotService = buildService();

    // The 99% capture: no skip, so the message must still be exactly the fixed
    // subject `Spec-010 §Turn-Boundary Snapshots` specifies. This is the
    // determinism guarantee the trailer had to be designed around — a trailer on
    // every capture would have changed every snapshot OID in the repository.
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
    // untracked-delete pass able to honour the same rules.
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
    // The project's own declaration — checked in, deliberately honoured, and the
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

  it("returns the recorded OID and leaves the ref unmoved on a duplicate capture (I-010-22)", async () => {
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

  it("mints a fresh ref for the same turn ordinal under a new epoch (I-010-22)", async () => {
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

  it("places the caller-supplied epoch in the ref verbatim (Spec-004 §Required Behavior)", async () => {
    const repository: FixtureRepository = fixture.repository;
    applyTurnEffects();

    // The fixture has no rollback history of ANY kind — no prior epoch ref, no
    // durable record this service could read even if it wanted to. `7` can only
    // have come from the caller, which is CP-010-12's pure-callee property and
    // `Spec-004 §Required Behavior`'s "supplied, never derived".
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

  it("runs the pipeline for every writable mode, not only `worktree`", async () => {
    const repository: FixtureRepository = fixture.repository;
    applyTurnEffects();
    // Applicability is "writable modes", PLURAL: a guard narrowed to
    // `mode === "worktree"` would silently disable capture for `branch` and
    // `ephemeral clone` while every other case in this file still passed. The
    // literal `"ephemeral clone"` — a SPACE, not a hyphen — is exercised here
    // for the same reason.
    const writableModes: readonly ExecutionMode[] = ["worktree", "branch", "ephemeral clone"];
    const service: TurnSnapshotService = buildService();
    const snapshotCommits: string[] = [];

    for (const [index, mode] of writableModes.entries()) {
      // A distinct ordinal per mode: the same one would take the create-only
      // idempotence arm on the second pass and prove nothing about the guard.
      const turnOrdinal: number = index + 1;
      const result = expectCaptured(
        await service.captureTurnSnapshot({
          ...CAPTURE_DEFAULTS,
          mode,
          turnOrdinal,
          // The execution root's PROVENANCE is the caller's business under
          // CP-010-12 — a clone and a shared checkout are both just a path
          // here — so the mode value is the only variable in this loop.
          executionRoot: repository.root,
        }),
      );
      expect(result.ref).toBe(`refs/sidekicks/runs/${RUN_ID}/epoch-0/turn-${String(turnOrdinal)}`);
      expect(await repository.git(["rev-parse", result.ref])).toBe(result.snapshotCommit);
      snapshotCommits.push(result.snapshotCommit);
    }

    // Identical worktree, identical base, identical clock — so identical OIDs.
    // The mode selects WHETHER the recipe runs, never how it runs.
    expect(new Set(snapshotCommits).size).toBe(1);
    expect(fixture.diagnostics).toEqual([]);
  });

  it("returns the typed no-op for read-only mode, creating no object, ref or directory", async () => {
    const repository: FixtureRepository = fixture.repository;
    applyTurnEffects();
    const censusBefore: string = await repository.objectCensus();
    const refsBefore: string = await repository.refListing();

    const result = await buildService().captureTurnSnapshot({
      ...CAPTURE_DEFAULTS,
      mode: "read-only",
      executionRoot: repository.root,
    });

    expect(result).toEqual({
      outcome: "not-applicable",
      reason: "read-only-mode",
      mode: "read-only",
    });
    expect(await repository.objectCensus()).toBe(censusBefore);
    expect(await repository.refListing()).toBe(refsBefore);
    // The guard runs before ANY filesystem work, so the service's own
    // directories were never created either — the strongest available statement
    // that no leg ran at all.
    expect(existsSync(fixture.executionRootsDirectory)).toBe(false);
    expect(fixture.diagnostics).toEqual([]);
  });

  it("is inert for a mode nobody admitted — an allowlist, not a denylist", async () => {
    const repository: FixtureRepository = fixture.repository;
    applyTurnEffects();
    const refsBefore: string = await repository.refListing();

    const invocations: string[][] = [];
    const recordingRunner: TurnSnapshotGitRunner = buildRecordingRunner(invocations);

    // A mode from the FUTURE — the double assertion is the point, since no such
    // `ExecutionMode` member exists today. The case is about what happens when
    // one is added: a denylist (`mode === "read-only"`) would capture it by
    // default, in a root this recipe was never written against, and the first
    // report would be objects in a stranger's store.
    const result = await buildService({ git: recordingRunner }).captureTurnSnapshot({
      ...CAPTURE_DEFAULTS,
      mode: "remote-node" as unknown as ExecutionMode,
      executionRoot: repository.root,
    });

    expect(result).toEqual({
      outcome: "not-applicable",
      reason: "mode-not-snapshot-capable",
      mode: "remote-node",
    });
    expect(invocations).toEqual([]);
    expect(await repository.refListing()).toBe(refsBefore);
    expect(existsSync(fixture.executionRootsDirectory)).toBe(false);
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
    // Self-consistent: the recorded parent is the base whose tree was read, NOT
    // the branch tip the capture finished against. A later restore therefore
    // draws T5.2's typed `head_moved` refusal instead of anti-diffing the landed
    // commit's files into the worktree.
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
    // `already-captured` here would hand T5.2 a snapshot OID for a snapshot that
    // does not exist. (This case pins the rethrow and the `write-ref` cursor; the
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
      removeDirectoryIfEmpty(): Promise<void> {
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

  it("refuses every unusable ref component before any git call (I-010-21)", async () => {
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
    // interim `console.warn` standing in for the OTel diagnostic `Spec-010
    // §Turn-Boundary Snapshots` names; when the daemon grows a telemetry
    // substrate, this case moves to it.
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
    // The behavioural case below asserts on TWO variables — `GIT_DIR` and
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

  it("never touches refs/heads when a DANGLING symref squats the capture path (I-010-21)", async () => {
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

    // I-010-21 FIRST and UNBRANCHED, because it is the one claim that does not
    // depend on which git is running — and because it is the assertion that kills
    // a dropped `--no-deref` on every version. Unflagged, this same create writes
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

  it("prepends the hook-neutralization flags to every invocation (D-010-10)", async () => {
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

  // Mode bits need POSIX; same posture as the restore describe's symlink cases.
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
      // the same `100644`. `Spec-010 §Turn-Boundary Snapshots` asks for add -A
      // tree equivalence, so honoring the knob keeps the contract while pinning
      // it `true` would have broken it — see this describe's tracked-file case
      // for the half that pin got wrong.
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

describe("TurnSnapshotService.resolveRestoreTarget", () => {
  it("leaves the execution root byte-identical across a refused AND an accepted resolve", async () => {
    const repository: FixtureRepository = fixture.repository;
    applyTurnEffects();
    const service: TurnSnapshotService = buildService();
    const captured: TurnSnapshotCaptured = await captureTurn(service);
    applyPostSnapshotEffects();

    const censusBefore: string = collectWorktreeCensus(repository.root);
    const indexBefore: string = readIndexFingerprint(repository.root);
    const refsBefore: string = await repository.refListing();
    const headBefore: string = await repository.git(["rev-parse", "HEAD"]);

    // The ACCEPTED arm is the interesting half: a resolver that "checked" the
    // precondition by applying something would pass a refusal-only assertion.
    const accepted: TurnSnapshotRestoreTarget = expectResolved(
      await service.resolveRestoreTarget(buildResolveInput()),
    );
    expect(accepted).toEqual({
      outcome: "resolved",
      executionRoot: repository.root,
      runId: RUN_ID,
      targetPosition: 1,
      owningEpoch: 0,
      ref: captured.ref,
      snapshotCommit: captured.snapshotCommit,
      // The fail-closed precondition's subject: the snapshot's RECORDED first
      // parent, which is the base the capture leg resolved at entry.
      expectedHead: captured.baseCommit,
    });
    expect(collectWorktreeCensus(repository.root)).toBe(censusBefore);
    expect(readIndexFingerprint(repository.root)).toBe(indexBefore);
    expect(await repository.refListing()).toBe(refsBefore);
    expect(await repository.git(["rev-parse", "HEAD"])).toBe(headBefore);

    // …and the refused arm, which must not have "cleaned up" either.
    const refused = await service.resolveRestoreTarget(buildResolveInput({ targetPosition: 9 }));
    expect(refused).toEqual({
      outcome: "no_snapshot",
      ref: `refs/sidekicks/runs/${RUN_ID}/epoch-0/turn-9`,
      owningEpoch: 0,
      reason: "ref-absent",
    });
    expect(collectWorktreeCensus(repository.root)).toBe(censusBefore);
    expect(readIndexFingerprint(repository.root)).toBe(indexBefore);
    expect(await repository.refListing()).toBe(refsBefore);
    // A REFUSAL is not a fault: neither arm reports to the diagnostic sink. This
    // assertion is also the non-vacuity control for the `probe-failed` case
    // below — `ref-absent` reaching here silently would mean the repository
    // probe answered, which is exactly what distinguishes the two reasons.
    expect(fixture.diagnostics).toEqual([]);

    // The index fingerprint's own NEGATIVE CONTROL: it has to be capable of
    // moving, or "unchanged" above is a statement about the helper rather than
    // about the resolver.
    await repository.git(["add", "-A"]);
    expect(readIndexFingerprint(repository.root)).not.toBe(indexBefore);
  });

  it("refuses a HEAD advanced past the snapshot, with no mutation (I-010-23)", async () => {
    const repository: FixtureRepository = fixture.repository;
    applyTurnEffects();
    const service: TurnSnapshotService = buildService();
    const captured: TurnSnapshotCaptured = await captureTurn(service);

    // A reviewed Spec-011 commit lands in the execution root after the turn.
    // Reading the older snapshot tree against this newer `HEAD` would leave the
    // commit in branch history while anti-diffing its files into the worktree.
    await repository.git(["commit", "-q", "--allow-empty", "-m", "landed after the snapshot"]);
    const movedHead: string = await repository.git(["rev-parse", "HEAD"]);
    const censusBefore: string = collectWorktreeCensus(repository.root);
    const indexBefore: string = readIndexFingerprint(repository.root);

    const resolution = await service.resolveRestoreTarget(buildResolveInput());

    expect(resolution).toEqual({
      outcome: "head_moved",
      ref: captured.ref,
      owningEpoch: 0,
      expectedHead: captured.baseCommit,
      observedHead: movedHead,
    });
    expect(movedHead).not.toBe(captured.baseCommit);
    expect(collectWorktreeCensus(repository.root)).toBe(censusBefore);
    expect(readIndexFingerprint(repository.root)).toBe(indexBefore);
    // Refusal, not fault: nothing reaches the diagnostic sink.
    expect(fixture.diagnostics).toEqual([]);
  });

  it("walks the lineage to the OWNING epoch and inherits at the rewind base", async () => {
    const repository: FixtureRepository = fixture.repository;
    const service: TurnSnapshotService = buildService();

    // Epoch 0 ran positions 4, 5 and 6; a rollback to position 5 then opened
    // epoch 1, which re-executed position 6 with different content.
    repository.write("marker.txt", "epoch 0, position 4\n");
    const epochZeroFour: TurnSnapshotCaptured = await captureTurn(service, { turnOrdinal: 4 });
    repository.write("marker.txt", "epoch 0, position 5\n");
    const epochZeroFive: TurnSnapshotCaptured = await captureTurn(service, { turnOrdinal: 5 });
    repository.write("marker.txt", "epoch 0, position 6\n");
    const epochZeroSix: TurnSnapshotCaptured = await captureTurn(service, { turnOrdinal: 6 });
    repository.write("marker.txt", "epoch 1, position 6\n");
    const epochOneSix: TurnSnapshotCaptured = await captureTurn(service, {
      epoch: 1,
      turnOrdinal: 6,
    });

    const epochLineage = [
      { epoch: 0, rewindBase: 0 },
      { epoch: 1, rewindBase: 5 },
    ];

    // Strictly ABOVE the rewind base: epoch 1's own territory.
    const above: TurnSnapshotRestoreTarget = expectResolved(
      await service.resolveRestoreTarget(buildResolveInput({ targetPosition: 6, epochLineage })),
    );
    expect(above.owningEpoch).toBe(1);
    expect(above.ref).toBe(epochOneSix.ref);
    expect(above.snapshotCommit).toBe(epochOneSix.snapshotCommit);
    expect(above.snapshotCommit).not.toBe(epochZeroSix.snapshotCommit);

    // AT the rewind base, and below it: the prefix epoch 1 inherited from its
    // parent. A walk that read `rewindBase <= targetPosition` would take epoch 1
    // here and resolve a ref that does not exist.
    const atBase: TurnSnapshotRestoreTarget = expectResolved(
      await service.resolveRestoreTarget(buildResolveInput({ targetPosition: 5, epochLineage })),
    );
    expect(atBase.owningEpoch).toBe(0);
    expect(atBase.ref).toBe(epochZeroFive.ref);
    const belowBase: TurnSnapshotRestoreTarget = expectResolved(
      await service.resolveRestoreTarget(buildResolveInput({ targetPosition: 4, epochLineage })),
    );
    expect(belowBase.owningEpoch).toBe(0);
    expect(belowBase.ref).toBe(epochZeroFour.ref);

    // The owner is the MAXIMUM candidate epoch, not the last matching list
    // entry: an unsorted lineage resolves the same owner rather than a
    // plausible wrong one.
    const reversed: TurnSnapshotRestoreTarget = expectResolved(
      await service.resolveRestoreTarget(
        buildResolveInput({ targetPosition: 6, epochLineage: [...epochLineage].reverse() }),
      ),
    );
    expect(reversed.ref).toBe(epochOneSix.ref);
  });

  it("refuses a gap in the owning epoch rather than falling through to its parent (I-010-23)", async () => {
    const repository: FixtureRepository = fixture.repository;
    const service: TurnSnapshotService = buildService();

    // Epoch 0 captured position 6. Epoch 1 re-executed it and its capture FAILED
    // — the spec's failure-tolerant capture, which never blocks a turn — so the
    // owning epoch has a gap exactly where the rollback is aiming.
    repository.write("marker.txt", "epoch 0, position 6\n");
    const epochZeroSix: TurnSnapshotCaptured = await captureTurn(service, { turnOrdinal: 6 });

    const resolution = await service.resolveRestoreTarget(
      buildResolveInput({
        targetPosition: 6,
        epochLineage: [
          { epoch: 0, rewindBase: 0 },
          { epoch: 1, rewindBase: 5 },
        ],
      }),
    );

    expect(resolution).toEqual({
      outcome: "no_snapshot",
      ref: `refs/sidekicks/runs/${RUN_ID}/epoch-1/turn-6`,
      owningEpoch: 1,
      reason: "ref-absent",
    });
    // The DISCRIMINATING half: the superseded epoch's same-ordinal ref is right
    // there, resolvable, naming a tree from the execution the user rolled back.
    // A fallthrough would have restored it and been indistinguishable from
    // success.
    expect(await repository.git(["rev-parse", epochZeroSix.ref])).toBe(epochZeroSix.snapshotCommit);
    // A gap is a refusal, not a fault — and the repository plainly answers, so
    // this is `ref-absent` rather than `probe-failed`.
    expect(fixture.diagnostics).toEqual([]);
  });

  it("refuses inputs that could not name a ref, before any git call", async () => {
    const repository: FixtureRepository = fixture.repository;
    applyTurnEffects();

    const invocations: string[][] = [];
    const recordingRunner: TurnSnapshotGitRunner = buildRecordingRunner(invocations);
    const service: TurnSnapshotService = buildService({ git: recordingRunner });

    const rows: readonly {
      readonly label: string;
      readonly overrides: Partial<ResolveRestoreTargetInput>;
    }[] = [
      { label: "runId escaping the namespace", overrides: { runId: "../../heads/main" } },
      { label: "empty runId", overrides: { runId: "" } },
      { label: "negative target position", overrides: { targetPosition: -1 } },
      { label: "fractional target position", overrides: { targetPosition: 1.5 } },
      {
        label: "lineage entry with a fractional epoch",
        overrides: { epochLineage: [{ epoch: 0.5, rewindBase: 0 }] },
      },
      {
        label: "lineage entry with a negative rewind base",
        overrides: { epochLineage: [{ epoch: 0, rewindBase: -1 }] },
      },
    ];

    for (const row of rows) {
      expect(
        await service.resolveRestoreTarget(buildResolveInput(row.overrides)),
        row.label,
      ).toEqual({
        outcome: "no_snapshot",
        ref: null,
        owningEpoch: null,
        reason: "unusable-inputs",
      });
    }

    // A WELL-FORMED lineage that simply owns no such position is a different
    // fact, and says so: nothing is wrong with the caller's inputs.
    expect(await service.resolveRestoreTarget(buildResolveInput({ epochLineage: [] }))).toEqual({
      outcome: "no_snapshot",
      ref: null,
      owningEpoch: null,
      reason: "no-owning-epoch",
    });
    expect(await service.resolveRestoreTarget(buildResolveInput({ targetPosition: 0 }))).toEqual({
      outcome: "no_snapshot",
      ref: null,
      owningEpoch: null,
      reason: "no-owning-epoch",
    });

    expect(invocations).toEqual([]);
    expect(existsSync(join(repository.root, ".git", "index"))).toBe(true);
    // Every arm above is a refusal, and refusals are not diagnosed — including
    // the two that never reached git at all.
    expect(fixture.diagnostics).toEqual([]);
  });

  it("reports probe-failed, and DIAGNOSES it, when the repository cannot be asked", async () => {
    const repository: FixtureRepository = fixture.repository;
    applyTurnEffects();
    const service: TurnSnapshotService = buildService();
    const captured: TurnSnapshotCaptured = await captureTurn(service);

    // The root goes away under the daemon — a retired worktree, a disposed
    // ephemeral clone, an unreadable mount. Both the ref probe and the
    // repository probe fail, which is precisely the pair that distinguishes
    // "there is no snapshot" from "nobody could be asked".
    rmSync(repository.root, { recursive: true, force: true });

    expect(await service.resolveRestoreTarget(buildResolveInput())).toEqual({
      outcome: "no_snapshot",
      ref: captured.ref,
      owningEpoch: 0,
      reason: "probe-failed",
    });
    // A FAULT, so unlike every other refusal in this describe it reaches the
    // sink — the only signal this condition produces, since the caller refuses
    // the whole rollback on any non-resolved arm either way.
    expect(fixture.diagnostics).toEqual([
      {
        kind: "restore-probe-failed",
        runId: RUN_ID,
        epoch: 0,
        turnOrdinal: 1,
        ref: captured.ref,
        detail: "the execution root did not answer `rev-parse --git-dir`",
      },
    ]);
  });

  it("reports head_moved with a null expectedHead when the recorded parent cannot be read", async () => {
    const repository: FixtureRepository = fixture.repository;
    applyTurnEffects();
    const service: TurnSnapshotService = buildService();
    const captured: TurnSnapshotCaptured = await captureTurn(service);
    const censusBefore: string = collectWorktreeCensus(repository.root);
    const indexBefore: string = readIndexFingerprint(repository.root);

    // ONLY the recorded-parent read fails. The ref resolves and `HEAD` resolves,
    // so the precondition is not contradicted — it is merely unanswerable, and
    // fail-closed means unanswerable refuses.
    const parentRevision = `${captured.snapshotCommit}^`;
    const failingRunner: TurnSnapshotGitRunner = async (argv, options) => {
      if (argv.includes(parentRevision)) {
        throw new Error("induced: the recorded parent could not be read");
      }
      return runTurnSnapshotGitWithExecFile(argv, options);
    };

    const resolution = await buildService({ git: failingRunner }).resolveRestoreTarget(
      buildResolveInput(),
    );

    expect(resolution).toEqual({
      outcome: "head_moved",
      ref: captured.ref,
      owningEpoch: 0,
      expectedHead: null,
      observedHead: await repository.git(["rev-parse", "HEAD"]),
    });
    expect(collectWorktreeCensus(repository.root)).toBe(censusBefore);
    expect(readIndexFingerprint(repository.root)).toBe(indexBefore);
    expect(fixture.diagnostics).toEqual([]);
  });
});

describe("TurnSnapshotService.restoreToTurn", () => {
  it("restores the captured worktree byte-for-byte and stages nothing", async () => {
    const repository: FixtureRepository = fixture.repository;
    applyTurnEffects();
    const service: TurnSnapshotService = buildService();
    const captured: TurnSnapshotCaptured = await captureTurn(service);

    // The census is taken AT the boundary — this is the state the restore has to
    // reproduce, directory structure included.
    const censusAtCapture: string = collectWorktreeCensus(repository.root);
    const refsAtCapture: string = await repository.refListing();
    const branchesAtCapture: string = await repository.refListing("refs/heads/");
    const headAtCapture: string = await repository.git(["rev-parse", "HEAD"]);
    applyPostSnapshotEffects();
    expect(collectWorktreeCensus(repository.root)).not.toBe(censusAtCapture);

    const target: TurnSnapshotRestoreTarget = expectResolved(
      await service.resolveRestoreTarget(buildResolveInput()),
    );
    const restored: TurnSnapshotRestored = expectRestored(await service.restoreToTurn(target));

    expect(restored).toEqual({
      outcome: "restored",
      ref: captured.ref,
      snapshotCommit: captured.snapshotCommit,
      overwrittenIgnoredPaths: [],
      divergentGitlinks: [],
    });
    // Byte-identical, whole-worktree: the edit is reverted, the deleted file is
    // back, the post-snapshot files AND the directory they created are gone.
    // (No in-tree conversion attributes in this fixture — the carve-out for
    // those has its own case below.)
    expect(collectWorktreeCensus(repository.root)).toBe(censusAtCapture);
    expect(existsSync(join(repository.root, "post-dir"))).toBe(false);

    // The closing index reset: captured-untracked files are untracked again and
    // tracked edits are ordinary unstaged modifications — no fabricated staged
    // intent survives a restore.
    expect(await repository.git(["diff", "--cached", "--name-only"])).toBe("");
    // Raw stdout rather than the trimming helper: the leading column is the
    // assertion. Every entry is worktree-side (` M`, ` D`, `??`) — nothing in
    // the left-hand STAGED column at all.
    const status: string = (await repository.gitCapturing(["status", "--porcelain"])).stdout;
    expect(status).toBe(" D doomed.txt\n M tracked.txt\n?? created.txt\n?? nested/\n");

    // I-010-21 on the restore leg: it writes no refs at all — the whole listing
    // is unchanged, `refs/heads/` included, and `HEAD` did not move. Restoring a
    // turn is a WORKTREE operation; branch history, PR preparation and diff
    // attribution see nothing (Spec-011 no-impact).
    expect(await repository.refListing()).toBe(refsAtCapture);
    expect(await repository.refListing("refs/heads/")).toBe(branchesAtCapture);
    expect(await repository.git(["rev-parse", "HEAD"])).toBe(headAtCapture);
    expect(fixture.diagnostics).toEqual([]);
  });

  it("re-verifies the precondition at execution time and refuses a HEAD that moved after the resolve", async () => {
    const repository: FixtureRepository = fixture.repository;
    applyTurnEffects();
    const service: TurnSnapshotService = buildService();
    const captured: TurnSnapshotCaptured = await captureTurn(service);
    applyPostSnapshotEffects();

    // The resolution is ACCEPTED — the precondition held when it was taken.
    const target: TurnSnapshotRestoreTarget = expectResolved(
      await service.resolveRestoreTarget(buildResolveInput()),
    );

    // …and then `HEAD` moves in the window before the dispatch. This is the
    // whole reason the check runs twice; a resolver-only check would apply the
    // snapshot against the newer history.
    await repository.git([
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "landed between resolve and restore",
    ]);
    const movedHead: string = await repository.git(["rev-parse", "HEAD"]);
    const censusBefore: string = collectWorktreeCensus(repository.root);
    const indexBefore: string = readIndexFingerprint(repository.root);

    const invocations: string[][] = [];
    const recordingRunner: TurnSnapshotGitRunner = buildRecordingRunner(invocations);
    const result = await buildService({ git: recordingRunner }).restoreToTurn(target);

    expect(result).toEqual({
      outcome: "head_moved",
      ref: captured.ref,
      expectedHead: captured.baseCommit,
      observedHead: movedHead,
    });
    // NO mutation: not the worktree, not the index.
    expect(collectWorktreeCensus(repository.root)).toBe(censusBefore);
    expect(readIndexFingerprint(repository.root)).toBe(indexBefore);
    expect(fixture.diagnostics).toEqual([]);

    // This is the ENTRY check specifically, and the distinguishing property is
    // that it asks nothing else: exactly one invocation, the `HEAD` read itself.
    // The restore reads `HEAD` at three points and any of the first two would
    // produce the same refusal for this fixture — but the later one would first
    // spend the derivation's `ls-tree` and `ls-files` against a repository that
    // is already known to be un-restorable, under the caller's exclusive hold.
    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.slice(-5)).toEqual([
      "-C",
      repository.root,
      "rev-parse",
      "--verify",
      "HEAD",
    ]);
  });

  it("deletes post-snapshot untracked content to a FIXPOINT while declared-ignored paths survive", async () => {
    const repository: FixtureRepository = fixture.repository;
    applyTurnEffects();
    // The snapshot's own `.gitignore` declares `node_modules/` disposable, and
    // its contents are therefore never captured — the restore must not delete
    // them either, on any pass.
    repository.write(
      ".gitignore",
      "ignored-dir/\nignored-file.txt\ntracked-but-ignored.txt\nnode_modules/\n",
    );
    repository.write("node_modules/dependency/index.js", "derived, project-declared disposable\n");
    const service: TurnSnapshotService = buildService();
    await captureTurn(service);
    const dependencyBytes: Buffer = readFileSync(
      join(repository.root, "node_modules", "dependency", "index.js"),
    );

    // The fixpoint fixture: a turn-created untracked `.gitignore` that shields a
    // turn-created directory. Pass one lists only the `.gitignore` (the shielded
    // directory is ignored BY it); pass two lists what deleting it un-hid.
    repository.write("turn-dir/.gitignore", "shielded/\n");
    repository.write("turn-dir/shielded/artifact.txt", "shielded by the turn's own ignore file\n");
    repository.write("loose.txt", "plain post-snapshot file\n");

    let untrackedListings = 0;
    const countingRunner: TurnSnapshotGitRunner = async (argv, options) => {
      // The delete pass's listing, not the derivation's — that one carries `-i`.
      if (argv.includes("ls-files") && argv.includes("-o") && !argv.includes("-i")) {
        untrackedListings += 1;
      }
      return runTurnSnapshotGitWithExecFile(argv, options);
    };
    const target: TurnSnapshotRestoreTarget = expectResolved(
      await service.resolveRestoreTarget(buildResolveInput()),
    );
    expectRestored(await buildService({ git: countingRunner }).restoreToTurn(target));

    // Two deleting passes plus the one that found nothing — the fixpoint. A
    // single-pass implementation returns 1 here and leaves the shielded file.
    expect(untrackedListings).toBe(3);
    expect(existsSync(join(repository.root, "turn-dir"))).toBe(false);
    expect(existsSync(join(repository.root, "loose.txt"))).toBe(false);
    // …and the pass never reached what the project declared disposable.
    expect(readFileSync(join(repository.root, "node_modules", "dependency", "index.js"))).toEqual(
      dependencyBytes,
    );
    expect(existsSync(join(repository.root, "ignored-file.txt"))).toBe(true);
    expect(existsSync(join(repository.root, "ignored-dir", "artifact.bin"))).toBe(true);
  });

  it("overwrites an ignored path colliding with snapshot-tracked content and ENUMERATES it", async () => {
    const repository: FixtureRepository = fixture.repository;
    applyTurnEffects();
    const service: TurnSnapshotService = buildService();
    const captured: TurnSnapshotCaptured = await captureTurn(service);
    const snapshotBytes: Buffer = readFileSync(join(repository.root, "tracked-but-ignored.txt"));
    const untouchedIgnoredBytes: Buffer = readFileSync(join(repository.root, "ignored-file.txt"));

    // The spec's collision: the turn dropped a tracked path from the index and
    // wrote ignored content at it, so the path is now ignored-untracked on disk
    // while the snapshot still tracks it. `HEAD` never moved.
    await repository.git(["rm", "-q", "--cached", "tracked-but-ignored.txt"]);
    repository.write("tracked-but-ignored.txt", "ignored content written after the boundary\n");

    const target: TurnSnapshotRestoreTarget = expectResolved(
      await service.resolveRestoreTarget(buildResolveInput()),
    );
    const restored: TurnSnapshotRestored = expectRestored(await service.restoreToTurn(target));

    expect(restored).toEqual({
      outcome: "restored",
      ref: captured.ref,
      snapshotCommit: captured.snapshotCommit,
      overwrittenIgnoredPaths: ["tracked-but-ignored.txt"],
      divergentGitlinks: [],
    });
    // Restore wins by design — and the loss is reported rather than silent.
    expect(readFileSync(join(repository.root, "tracked-but-ignored.txt"))).toEqual(snapshotBytes);
    // The non-colliding ignored path is untouched AND unenumerated: the
    // enumeration is of collisions, not of every ignored file in the tree.
    expect(readFileSync(join(repository.root, "ignored-file.txt"))).toEqual(untouchedIgnoredBytes);
  });

  it("ENUMERATES ignored content a snapshot FILE obstructs as a directory prefix", async () => {
    const repository: FixtureRepository = fixture.repository;
    applyTurnEffects();
    // A DIRECTORY-only rule, so the turn's plain file `collide` is capturable
    // while anything a later turn puts INSIDE a directory of that name is
    // project-declared disposable. That asymmetry is what makes this shape
    // reachable at all. `collidex/` is the segment-boundary control below.
    repository.write(".gitignore", `${FIXTURE_IGNORE_RULES}collide/\ncollidex/\n`);
    repository.write("collide", "snapshot bytes at the colliding path\n");
    const service: TurnSnapshotService = buildService();
    const captured: TurnSnapshotCaptured = await captureTurn(service);
    const snapshotBytes: Buffer = readFileSync(join(repository.root, "collide"));
    const untouchedIgnoredBytes: Buffer = readFileSync(join(repository.root, "ignored-file.txt"));

    // Post-boundary the file becomes a DIRECTORY holding ignored content. The
    // derivation's listing reports `collide/artifact.bin`, which never EQUALS the
    // snapshot's `collide` — the escape an exact-path intersection leaves open.
    rmSync(join(repository.root, "collide"));
    repository.write("collide/artifact.bin", "ignored content the checkout destroys\n");
    // The control, in the same listing: a string prefix that is not a SEGMENT
    // prefix. `collidex/artifact.bin` starts with `collide` and obstructs
    // nothing.
    repository.write("collidex/artifact.bin", "ignored content nothing obstructs\n");
    const unobstructedBytes: Buffer = readFileSync(
      join(repository.root, "collidex", "artifact.bin"),
    );

    const target: TurnSnapshotRestoreTarget = expectResolved(
      await service.resolveRestoreTarget(buildResolveInput()),
    );
    const restored: TurnSnapshotRestored = expectRestored(await service.restoreToTurn(target));

    expect(restored).toEqual({
      outcome: "restored",
      ref: captured.ref,
      snapshotCommit: captured.snapshotCommit,
      overwrittenIgnoredPaths: ["collide/artifact.bin"],
      divergentGitlinks: [],
    });
    // Ground truth for the enumeration, measured on git 2.50.1: the checkout
    // exits 0, removes the obstructing directory WHOLE and writes the snapshot
    // file where it stood.
    expect(readFileSync(join(repository.root, "collide"))).toEqual(snapshotBytes);
    expect(existsSync(join(repository.root, "collide", "artifact.bin"))).toBe(false);
    // …and the paths that obstruct nothing are neither enumerated nor touched.
    expect(readFileSync(join(repository.root, "collidex", "artifact.bin"))).toEqual(
      unobstructedBytes,
    );
    expect(readFileSync(join(repository.root, "ignored-file.txt"))).toEqual(untouchedIgnoredBytes);
  });

  it("ENUMERATES an ignored FILE obstructing a directory the snapshot needs", async () => {
    const repository: FixtureRepository = fixture.repository;
    applyTurnEffects();
    repository.write("collide/a.txt", "snapshot child content\n");
    const service: TurnSnapshotService = buildService();
    const captured: TurnSnapshotCaptured = await captureTurn(service);
    const snapshotChildBytes: Buffer = readFileSync(join(repository.root, "collide", "a.txt"));

    // Post-boundary the directory becomes an ignored FILE, declared disposable by
    // a rule the turn itself added. The derivation's listing reports `collide`,
    // which the snapshot tree does not contain — it contains a path BENEATH it,
    // and the checkout cannot have both.
    rmSync(join(repository.root, "collide"), { recursive: true });
    repository.write("collide", "ignored file squatting the snapshot's directory\n");
    repository.write(".gitignore", `${FIXTURE_IGNORE_RULES}collide\n`);

    const target: TurnSnapshotRestoreTarget = expectResolved(
      await service.resolveRestoreTarget(buildResolveInput()),
    );
    const restored: TurnSnapshotRestored = expectRestored(await service.restoreToTurn(target));

    expect(restored).toEqual({
      outcome: "restored",
      ref: captured.ref,
      snapshotCommit: captured.snapshotCommit,
      overwrittenIgnoredPaths: ["collide"],
      divergentGitlinks: [],
    });
    // Measured: the checkout exits 0, unlinks the obstructing file and
    // materializes the directory with the snapshot's child inside it.
    expect(readFileSync(join(repository.root, "collide", "a.txt"))).toEqual(snapshotChildBytes);
  });

  it("leaves ignored paths that merely SHARE a prefix unenumerated and byte-identical", async () => {
    const repository: FixtureRepository = fixture.repository;
    applyTurnEffects();
    // Two non-collisions the widened predicate must still refuse: a SIBLING
    // inside a directory the snapshot also populates, and an ignored file that is
    // a string prefix of a snapshot-tracked path without being an ancestor of it.
    repository.write(".gitignore", `${FIXTURE_IGNORE_RULES}keep-dir/ignored.txt\nsibling\n`);
    repository.write("keep-dir/child.txt", "captured child\n");
    repository.write("keep-dir/ignored.txt", "ignored sibling, obstructing nothing\n");
    repository.write("sibling-prefix.txt", "captured, and no descendant of `sibling`\n");
    repository.write("sibling", "ignored, and a string PREFIX of a snapshot path\n");
    const service: TurnSnapshotService = buildService();
    await captureTurn(service);
    const siblingBytes: Buffer = readFileSync(join(repository.root, "keep-dir", "ignored.txt"));
    const prefixBytes: Buffer = readFileSync(join(repository.root, "sibling"));

    // Post-boundary work at the shared directory, so the checkout really does
    // write into it rather than finding it already correct.
    repository.write("keep-dir/child.txt", "edited after the boundary\n");

    const target: TurnSnapshotRestoreTarget = expectResolved(
      await service.resolveRestoreTarget(buildResolveInput()),
    );
    const restored: TurnSnapshotRestored = expectRestored(await service.restoreToTurn(target));

    // Ancestry is tested segment-wise: `keep-dir/ignored.txt` shares a DIRECTORY
    // with `keep-dir/child.txt`, and `sibling` shares only characters with
    // `sibling-prefix.txt`. A raw string-prefix predicate reports both.
    expect(restored.overwrittenIgnoredPaths).toEqual([]);
    expect(readFileSync(join(repository.root, "keep-dir", "ignored.txt"))).toEqual(siblingBytes);
    expect(readFileSync(join(repository.root, "sibling"))).toEqual(prefixBytes);
    // …and the snapshot content around them really was restored.
    expect(readFileSync(join(repository.root, "keep-dir", "child.txt"), "utf8")).toBe(
      "captured child\n",
    );
  });

  it("ENUMERATES an ignored embedded repository the snapshot's file replaces", async () => {
    const repository: FixtureRepository = fixture.repository;
    applyTurnEffects();
    repository.write(".gitignore", `${FIXTURE_IGNORE_RULES}collide/\n`);
    repository.write("collide", "snapshot bytes at the colliding path\n");
    const service: TurnSnapshotService = buildService();
    await captureTurn(service);
    const snapshotBytes: Buffer = readFileSync(join(repository.root, "collide"));

    // An ignored directory git will not descend into is reported by the
    // derivation's listing as the single entry `collide/`, trailing slash and
    // all — the one shape in that listing that is not a file path.
    rmSync(join(repository.root, "collide"));
    await createEmbeddedRepository("collide");

    const target: TurnSnapshotRestoreTarget = expectResolved(
      await service.resolveRestoreTarget(buildResolveInput()),
    );
    const restored: TurnSnapshotRestored = expectRestored(await service.restoreToTurn(target));

    // Enumerated under its slash-stripped name, which is the spelling every other
    // path in this field carries.
    expect(restored.overwrittenIgnoredPaths).toEqual(["collide"]);
    // The snapshot holds no `160000` entry — it was captured while `collide` was
    // a plain file — so this is a collision and not a gitlink divergence.
    expect(restored.divergentGitlinks).toEqual([]);
    // Measured: the checkout exits 0 and takes the whole repository, `.git`
    // included. Enumerating it is the difference between a reported loss and a
    // silent one.
    expect(readFileSync(join(repository.root, "collide"))).toEqual(snapshotBytes);
    expect(existsSync(join(repository.root, "collide", ".git"))).toBe(false);
  });

  it("leaves an ignored embedded repository the checkout MERGES into unenumerated", async () => {
    const repository: FixtureRepository = fixture.repository;
    applyTurnEffects();
    repository.write("collide/a.txt", "snapshot child content\n");
    const service: TurnSnapshotService = buildService();
    await captureTurn(service);

    // The same trailing-slash listing entry as the case above, and the opposite
    // disposition: here the snapshot holds a path BENEATH `collide`, so the
    // checkout needs the directory that is already standing there.
    rmSync(join(repository.root, "collide"), { recursive: true });
    await createEmbeddedRepository("collide");
    repository.write(".gitignore", `${FIXTURE_IGNORE_RULES}collide/\n`);

    const target: TurnSnapshotRestoreTarget = expectResolved(
      await service.resolveRestoreTarget(buildResolveInput()),
    );
    const restored: TurnSnapshotRestored = expectRestored(await service.restoreToTurn(target));

    // Not a collision. A directory is only destroyed by a file at or above its
    // own path, so the ignored-path-is-an-ancestor shape is FILE-only; treating a
    // directory entry as one reports `collide` here, wrongly.
    expect(restored.overwrittenIgnoredPaths).toEqual([]);
    // Measured ground truth for that: the checkout exits 0, writes the snapshot's
    // child INTO the existing directory and leaves the embedded `.git` standing.
    expect(readFileSync(join(repository.root, "collide", "a.txt"), "utf8")).toBe(
      "snapshot child content\n",
    );
    expect(existsSync(join(repository.root, "collide", ".git"))).toBe(true);
    // The embedded repository's own file is then taken by the UNTRACKED-DELETE
    // pass, under a different contract: the restored `.gitignore` no longer
    // carries the rule the turn added, so `collide/inner.txt` is ordinary
    // post-snapshot untracked content. Asserted so the case states the whole
    // outcome rather than the half that flatters the enumeration.
    expect(existsSync(join(repository.root, "collide", "inner.txt"))).toBe(false);
  });

  it("enumerates an ignored file a materialized gitlink DISPLACES, beside its divergence", async () => {
    const repository: FixtureRepository = fixture.repository;
    applyTurnEffects();
    // Captured while an embedded repository stood at `sub`, so the snapshot tree
    // holds a `160000` entry there and not a blob.
    await createEmbeddedRepository("sub");
    const service: TurnSnapshotService = buildService();
    const captured: TurnSnapshotCaptured = await captureTurn(service);

    // The turn replaced the whole repository with an ignored file at its path.
    rmSync(join(repository.root, "sub"), { recursive: true });
    repository.write("sub", "ignored file squatting the gitlink's own path\n");
    repository.write(".gitignore", `${FIXTURE_IGNORE_RULES}sub\n`);

    const target: TurnSnapshotRestoreTarget = expectResolved(
      await service.resolveRestoreTarget(buildResolveInput()),
    );
    const restored: TurnSnapshotRestored = expectRestored(await service.restoreToTurn(target));

    // The checkout destroys the file because it has to put a directory where the
    // file stood, so the file is reported as destroyed — a `160000` entry is held
    // out of the derivation's TRACKED set (it writes no bytes) but seeds the
    // REQUIRED-DIRECTORY set, which is the shape that catches this. Both
    // enumerations fire here and they are not redundant: they name different
    // paths in the general case, and state different facts even when the paths
    // coincide — `sub`'s ignored bytes were destroyed, and the gitlink `sub` does
    // not match the snapshot's recorded commit.
    expect(restored).toEqual({
      outcome: "restored",
      ref: captured.ref,
      snapshotCommit: captured.snapshotCommit,
      overwrittenIgnoredPaths: ["sub"],
      divergentGitlinks: ["sub"],
    });
    // Measured ground truth: the checkout exits 0, the ignored bytes are gone and
    // an EMPTY directory stands in their place — `submodule.recurse=false`
    // materializes the gitlink and never populates it. `readdirSync` is the
    // assertion of both facts at once; it would throw `ENOTDIR` on a file.
    expect(readdirSync(join(repository.root, "sub"))).toEqual([]);
  });

  it("enumerates an ignored file a gitlink's ANCESTOR directory displaces, the same way", async () => {
    const repository: FixtureRepository = fixture.repository;
    applyTurnEffects();
    // The gitlink one segment deeper, so what the checkout has to create at the
    // ignored path is an ordinary parent directory rather than the gitlink.
    await createEmbeddedRepository("sub/mod");
    const service: TurnSnapshotService = buildService();
    const captured: TurnSnapshotCaptured = await captureTurn(service);

    rmSync(join(repository.root, "sub"), { recursive: true });
    repository.write("sub", "ignored file squatting the gitlink's parent\n");
    repository.write(".gitignore", `${FIXTURE_IGNORE_RULES}sub\n`);

    const target: TurnSnapshotRestoreTarget = expectResolved(
      await service.resolveRestoreTarget(buildResolveInput()),
    );
    const restored: TurnSnapshotRestored = expectRestored(await service.restoreToTurn(target));

    // Same mechanism one segment out, and the case that proves the gitlink seeds
    // its ANCESTORS and not just its own path: what the checkout must create at
    // `sub` is an ordinary parent directory, so the ignored file there is
    // unlinked and enumerated. The two enumerations name DIFFERENT paths here,
    // which is why neither can stand in for the other.
    expect(restored).toEqual({
      outcome: "restored",
      ref: captured.ref,
      snapshotCommit: captured.snapshotCommit,
      overwrittenIgnoredPaths: ["sub"],
      divergentGitlinks: ["sub/mod"],
    });
    expect(readdirSync(join(repository.root, "sub"))).toEqual(["mod"]);
    expect(readdirSync(join(repository.root, "sub", "mod"))).toEqual([]);
  });

  it("leaves an ignored DIRECTORY at a gitlink's own path unenumerated and intact", async () => {
    const repository: FixtureRepository = fixture.repository;
    applyTurnEffects();
    const capturedHead: string = await createEmbeddedRepository("sub");
    const service: TurnSnapshotService = buildService();
    const captured: TurnSnapshotCaptured = await captureTurn(service);

    // The bound on the two cases above. Same snapshot `160000` entry at `sub`,
    // and the turn put a DIRECTORY at that path rather than a file — a different
    // embedded repository, so the listing spells it with a trailing slash and the
    // gitlink is genuinely divergent.
    rmSync(join(repository.root, "sub"), { recursive: true });
    await createEmbeddedRepository("sub");
    const embeddedRoot: string = join(repository.root, "sub");
    repository.write("sub/derived.bin", "written by the turn, inside the replacement\n");
    await repository.git(["add", "-A"], { cwd: embeddedRoot });
    await repository.git(["commit", "-q", "-m", "derived"], { cwd: embeddedRoot });
    const replacementHead: string = await repository.git(["rev-parse", "HEAD"], {
      cwd: embeddedRoot,
    });
    expect(replacementHead).not.toBe(capturedHead);
    repository.write(".gitignore", `${FIXTURE_IGNORE_RULES}sub/\n`);

    const target: TurnSnapshotRestoreTarget = expectResolved(
      await service.resolveRestoreTarget(buildResolveInput()),
    );
    const restored: TurnSnapshotRestored = expectRestored(await service.restoreToTurn(target));

    // NOT a collision, and the reason the required-directory shape stays
    // FILE-only after gitlinks start seeding it: the checkout wants a directory
    // at `sub` and one is already standing there, so nothing is destroyed. The
    // path's whole disposition is the divergence enumeration's here — which is
    // what the two cases above would say wrongly if `!isDirectoryEntry` were
    // dropped from that clause.
    expect(restored).toEqual({
      outcome: "restored",
      ref: captured.ref,
      snapshotCommit: captured.snapshotCommit,
      overwrittenIgnoredPaths: [],
      divergentGitlinks: ["sub"],
    });
    // Measured ground truth for the non-report: the checkout exits 0 leaving the
    // directory, its payload and its `.git` untouched, and the delete pass then
    // declines to descend into a path the index holds as a gitlink.
    expect(existsSync(join(repository.root, "sub", ".git"))).toBe(true);
    expect(readFileSync(join(repository.root, "sub", "derived.bin"), "utf8")).toBe(
      "written by the turn, inside the replacement\n",
    );
    expect(readFileSync(join(repository.root, "sub", "inner.txt"), "utf8")).toBe("inner\n");
  });

  it("neither enumerates nor deletes ignored content BENEATH a snapshot-gitlink path", async () => {
    const repository: FixtureRepository = fixture.repository;
    applyTurnEffects();
    await createEmbeddedRepository("sub");
    const service: TurnSnapshotService = buildService();
    const captured: TurnSnapshotCaptured = await captureTurn(service);

    // The boundary's other side. The turn destroyed the embedded repository's
    // `.git` — leaving an ORDINARY directory, which the derivation's listing
    // descends into and reports file by file — and left ignored content inside.
    rmSync(join(repository.root, "sub", ".git"), { recursive: true });
    repository.write("sub/artifact.bin", "derived, and beneath a gitlink path\n");
    repository.write(".gitignore", `${FIXTURE_IGNORE_RULES}sub/\n`);
    const beneathBytes: Buffer = readFileSync(join(repository.root, "sub", "artifact.bin"));

    const target: TurnSnapshotRestoreTarget = expectResolved(
      await service.resolveRestoreTarget(buildResolveInput()),
    );
    const restored: TurnSnapshotRestored = expectRestored(await service.restoreToTurn(target));

    // Unenumerated, and the case that bounds the two preceding ones: a gitlink
    // seeds the required-directory set with its own path and its ancestors, NOT
    // with anything beneath it, so content inside a materialized gitlink is
    // obstructed by nothing. A derivation that instead put `160000` entries in
    // its TRACKED set would report both of these, `sub` being an ancestor of
    // each — and would be reporting content the checkout never touches.
    expect(restored).toEqual({
      outcome: "restored",
      ref: captured.ref,
      snapshotCommit: captured.snapshotCommit,
      overwrittenIgnoredPaths: [],
      divergentGitlinks: ["sub"],
    });
    // …and the non-report is honest rather than a silent loss, because the
    // content SURVIVES: the delete pass runs while the index holds the gitlink,
    // and `ls-files -o` declines to descend into one even when the working copy
    // there is an ordinary directory.
    expect(readFileSync(join(repository.root, "sub", "artifact.bin"))).toEqual(beneathBytes);
    expect(readFileSync(join(repository.root, "sub", "inner.txt"), "utf8")).toBe("inner\n");
  });

  it("restores git-canonical bytes under a host attributes file (checkout-conversion pins)", async () => {
    const repository: FixtureRepository = fixture.repository;
    const service: TurnSnapshotService = buildService();
    // No in-tree `.gitattributes` in this fixture: the only attribute source is
    // the HOST's, which the pins take out of the conversion decision.
    repository.write("plain.txt", "line one\nline two\n");
    await repository.git(["add", "plain.txt"]);
    await repository.git(["commit", "-q", "-m", "plain"]);
    const capturedBytes: Buffer = readFileSync(join(repository.root, "plain.txt"));
    const captured: TurnSnapshotCaptured = await captureTurn(service);

    const hostAttributes: string = join(fixture.fixtureRoot, "host-attributes");
    writeFileSync(hostAttributes, "*.txt eol=crlf\n");
    await repository.git(["config", "core.attributesFile", hostAttributes]);
    rmSync(join(repository.root, "plain.txt"));

    const target: TurnSnapshotRestoreTarget = expectResolved(
      await service.resolveRestoreTarget(buildResolveInput()),
    );
    expectRestored(await service.restoreToTurn(target));

    // The smudge path never saw the host's attribute file: the bytes on disk are
    // the bytes that were captured.
    expect(readFileSync(join(repository.root, "plain.txt"))).toEqual(capturedBytes);
    expect(readFileSync(join(repository.root, "plain.txt")).includes(0x0d)).toBe(false);

    // NEGATIVE CONTROL: the same checkout WITHOUT the pins honours the host file
    // and lands CRLF, so the assertion above is about the pins rather than about
    // an attribute that was inert.
    rmSync(join(repository.root, "plain.txt"));
    await repository.git(["read-tree", "--reset", "-u", captured.ref]);
    expect(readFileSync(join(repository.root, "plain.txt")).includes(0x0d)).toBe(true);
  });

  it("restores LF bytes under a host core.eol=crlf (checkout-conversion pins)", async () => {
    const repository: FixtureRepository = fixture.repository;
    const service: TurnSnapshotService = buildService();
    // The in-tree declaration is what makes `core.eol` reachable at all: the
    // knob governs the smudge path only for a path the attributes call `text`.
    // So this fixture is the project declaring normalization — deliberately
    // honoured — while the HOST tries to decide what that normalization spells.
    repository.write(".gitattributes", "*.txt text\n");
    repository.write("eol.txt", "alpha\nbeta\n");
    await repository.git(["add", ".gitattributes", "eol.txt"]);
    await repository.git(["commit", "-q", "-m", "text attribute"]);
    const captured: TurnSnapshotCaptured = await captureTurn(service);

    // Set AFTER the capture, so the check-in side of this case is untouched and
    // the assertion is purely about the checkout leg.
    await repository.git(["config", "core.eol", "crlf"]);
    rmSync(join(repository.root, "eol.txt"));

    const target: TurnSnapshotRestoreTarget = expectResolved(
      await service.resolveRestoreTarget(buildResolveInput()),
    );
    expectRestored(await service.restoreToTurn(target));

    // Git-canonical LF, exactly the blob's own bytes — the host's `crlf` never
    // reached the smudge path.
    expect(readFileSync(join(repository.root, "eol.txt"), "utf8")).toBe("alpha\nbeta\n");
    expect(readFileSync(join(repository.root, "eol.txt")).includes(0x0d)).toBe(false);

    // NEGATIVE CONTROL: the same checkout WITHOUT the `core.eol` pin honours the
    // host value and lands CRLF. Without this the case would pass on a host whose
    // `core.eol` was inert, which is every host that has not set it.
    rmSync(join(repository.root, "eol.txt"));
    await repository.git([
      "-c",
      "core.autocrlf=false",
      "-c",
      "submodule.recurse=false",
      "-c",
      "core.attributesFile=/dev/null",
      "read-tree",
      "--reset",
      "-u",
      captured.ref,
    ]);
    expect(readFileSync(join(repository.root, "eol.txt")).includes(0x0d)).toBe(true);

    // SECOND CONTROL, for the ORDER the service pins the two knobs in: the
    // `core.autocrlf=false` pin is what hands the decision to `core.eol`. Under a
    // host `core.autocrlf=true` the eol pin is ignored and CRLF lands anyway — so
    // neither pin is redundant, and the first is not merely a default restated.
    rmSync(join(repository.root, "eol.txt"));
    await repository.git([
      "-c",
      "core.autocrlf=true",
      "-c",
      "core.eol=lf",
      "-c",
      "submodule.recurse=false",
      "-c",
      "core.attributesFile=/dev/null",
      "read-tree",
      "--reset",
      "-u",
      captured.ref,
    ]);
    expect(readFileSync(join(repository.root, "eol.txt")).includes(0x0d)).toBe(true);
  });

  it("captures the same tree OID under a host core.eol=crlf (check-in leg is unaffected)", async () => {
    const repository: FixtureRepository = fixture.repository;
    // The disposition table's claim that `core.eol` is pinned on the CHECKOUT leg
    // ONLY needs its own evidence, or the omission on the check-in leg is an
    // assumption rather than a measurement. Same worktree, same declaration, two
    // captures either side of the host setting: identical snapshot trees.
    repository.write(".gitattributes", "*.txt text\n");
    repository.write("eol.txt", "alpha\nbeta\n");
    await repository.git(["add", ".gitattributes", "eol.txt"]);
    await repository.git(["commit", "-q", "-m", "text attribute"]);

    const before: TurnSnapshotCaptured = await captureTurn(buildService());
    await repository.git(["config", "core.eol", "crlf"]);
    const after: TurnSnapshotCaptured = await captureTurn(buildService(), {
      turnOrdinal: CAPTURE_DEFAULTS.turnOrdinal + 1,
    });

    expect(await repository.git(["rev-parse", `${after.ref}^{tree}`])).toBe(
      await repository.git(["rev-parse", `${before.ref}^{tree}`]),
    );
  });

  it("honours an IN-TREE conversion attribute, restoring to git-canonical form", async () => {
    const repository: FixtureRepository = fixture.repository;
    const service: TurnSnapshotService = buildService();
    // A project's own declaration, checked in and identical on every host —
    // deliberately still honoured, which is why worktree byte-identity is
    // asserted only for paths free of in-tree conversion.
    repository.write(".gitattributes", "*.txt text\n");
    await repository.git(["add", ".gitattributes"]);
    await repository.git(["commit", "-q", "-m", "in-tree attributes"]);
    writeFileSync(join(repository.root, "converted.txt"), Buffer.from([0x61, 0x0d, 0x0a]));

    const captured: TurnSnapshotCaptured = await captureTurn(service);
    // Captured LF-normalized, per the attribute.
    expect(await repository.git(["cat-file", "-p", `${captured.ref}^{tree}:converted.txt`])).toBe(
      "a",
    );
    rmSync(join(repository.root, "converted.txt"));

    const target: TurnSnapshotRestoreTarget = expectResolved(
      await service.resolveRestoreTarget(buildResolveInput()),
    );
    expectRestored(await service.restoreToTurn(target));

    // `61 0a`, not the `61 0d 0a` that went in: git-canonical worktree form,
    // identical to any porcelain checkout of this project.
    expect(readFileSync(join(repository.root, "converted.txt"))).toEqual(Buffer.from([0x61, 0x0a]));
  });

  it("preserves a captured embedded repository and reports no divergence when its gitlink matches", async () => {
    const repository: FixtureRepository = fixture.repository;
    applyTurnEffects();
    const embeddedHead: string = await createEmbeddedRepository("embedded");
    const service: TurnSnapshotService = buildService();
    await captureTurn(service);
    repository.write("post-snapshot.txt", "arrived after the boundary\n");

    const target: TurnSnapshotRestoreTarget = expectResolved(
      await service.resolveRestoreTarget(buildResolveInput()),
    );
    const restored: TurnSnapshotRestored = expectRestored(await service.restoreToTurn(target));

    // The deletion-loss path is closed BY CONSTRUCTION: T5.1 records the
    // embedded repository as a `160000` gitlink, so the restored index tracks it
    // and the untracked-delete pass never lists it. A restore that deleted it
    // would take the repository's whole object store with it.
    expect(existsSync(join(repository.root, "embedded", ".git"))).toBe(true);
    expect(readFileSync(join(repository.root, "embedded", "inner.txt"), "utf8")).toBe("inner\n");
    expect(
      await repository.git(["rev-parse", "HEAD"], { cwd: join(repository.root, "embedded") }),
    ).toBe(embeddedHead);
    // A gitlink that MATCHES is not divergence — the enumeration would be
    // meaningless if every submodule appeared in it.
    expect(restored.divergentGitlinks).toEqual([]);
    expect(existsSync(join(repository.root, "post-snapshot.txt"))).toBe(false);
  });

  it("leaves interior submodule state untouched and enumerates the divergent gitlink", async () => {
    const repository: FixtureRepository = fixture.repository;
    const embeddedRoot: string = join(fixture.repository.root, "embedded");
    applyTurnEffects();
    const embeddedHeadAtCapture: string = await createEmbeddedRepository("embedded");
    const service: TurnSnapshotService = buildService();
    await captureTurn(service);

    // After the boundary the submodule's own HEAD moves, and it acquires dirty
    // and untracked interior state — none of which is in the superproject's
    // index, and none of which the restore may touch.
    writeFileSync(join(embeddedRoot, "inner.txt"), "inner v2\n");
    await repository.git(["add", "-A"], { cwd: embeddedRoot });
    await repository.git(["commit", "-q", "-m", "inner v2"], { cwd: embeddedRoot });
    const movedEmbeddedHead: string = await repository.git(["rev-parse", "HEAD"], {
      cwd: embeddedRoot,
    });
    writeFileSync(join(embeddedRoot, "inner.txt"), "dirty interior edit\n");
    writeFileSync(join(embeddedRoot, "interior-untracked.txt"), "interior untracked\n");

    const target: TurnSnapshotRestoreTarget = expectResolved(
      await service.resolveRestoreTarget(buildResolveInput()),
    );
    const restored: TurnSnapshotRestored = expectRestored(await service.restoreToTurn(target));

    expect(movedEmbeddedHead).not.toBe(embeddedHeadAtCapture);
    // Reported, never silently half-restored: the superproject's gitlink
    // diverges from the snapshot's and the result says so.
    expect(restored.divergentGitlinks).toEqual(["embedded"]);
    // …and the boundary held in the other direction: interior modified and
    // untracked state survives untouched (`submodule.recurse=false`), and the
    // submodule's HEAD was never rewound.
    expect(readFileSync(join(embeddedRoot, "inner.txt"), "utf8")).toBe("dirty interior edit\n");
    expect(readFileSync(join(embeddedRoot, "interior-untracked.txt"), "utf8")).toBe(
      "interior untracked\n",
    );
    expect(await repository.git(["rev-parse", "HEAD"], { cwd: embeddedRoot })).toBe(
      movedEmbeddedHead,
    );
  });

  it("materializes an absent gitlink as an enumerated empty directory and deletes a post-boundary embedded repo", async () => {
    const repository: FixtureRepository = fixture.repository;
    applyTurnEffects();
    await createEmbeddedRepository("embedded");
    const service: TurnSnapshotService = buildService();
    await captureTurn(service);

    // The turn removed the embedded repository outright — its object store is
    // unrecoverable and out of contract — and created a different one.
    rmSync(join(repository.root, "embedded"), { recursive: true, force: true });
    await createEmbeddedRepository("created-after-the-boundary");

    const target: TurnSnapshotRestoreTarget = expectResolved(
      await service.resolveRestoreTarget(buildResolveInput()),
    );
    const restored: TurnSnapshotRestored = expectRestored(await service.restoreToTurn(target));

    expect(restored.divergentGitlinks).toEqual(["embedded"]);
    // An EMPTY directory, and it survives the whole sequence — the delete pass
    // ran while the index still held the gitlink, and the closing index reset
    // leaves an empty directory `ls-files -o` never reports.
    expect(existsSync(join(repository.root, "embedded"))).toBe(true);
    expect(readdirSync(join(repository.root, "embedded"))).toEqual([]);
    // The embedded repository that did NOT exist at the captured turn is
    // removed like any other post-snapshot untracked content.
    expect(existsSync(join(repository.root, "created-after-the-boundary"))).toBe(false);
  });

  it("closes the index back to HEAD, discarding staged work the turn left behind", async () => {
    const repository: FixtureRepository = fixture.repository;
    applyTurnEffects();
    const service: TurnSnapshotService = buildService();
    await captureTurn(service);

    // The user's staging area at restore time. The `-u` leg leaves the REAL
    // index at the snapshot tree, so without the close every captured-untracked
    // file would surface as a staged addition against `HEAD`.
    await repository.git(["add", "tracked.txt", "created.txt"]);
    expect(await repository.git(["diff", "--cached", "--name-only"])).toBe(
      "created.txt\ntracked.txt",
    );

    const target: TurnSnapshotRestoreTarget = expectResolved(
      await service.resolveRestoreTarget(buildResolveInput()),
    );
    expectRestored(await service.restoreToTurn(target));

    expect(await repository.git(["diff", "--cached", "--name-only"])).toBe("");
    const status: string = await repository.git(["status", "--porcelain"]);
    expect(status).toContain("?? created.txt");
    expect(status).toContain(" M tracked.txt");
    expect(status).not.toContain("A  created.txt");
    // Ground truth rather than a porcelain reading: the index's tree IS HEAD's.
    // Which is also the equivalence claim behind spelling that reset with the
    // verified OID instead of the name — while `HEAD` has not moved, the two are
    // the same command, and this case is what would notice if they were not.
    expect(await repository.git(["write-tree"])).toBe(
      await repository.git(["rev-parse", "HEAD^{tree}"]),
    );
  });

  it("reports a failure after the read-tree leg as partial_restore, enumerating what it already applied", async () => {
    const repository: FixtureRepository = fixture.repository;
    applyTurnEffects();
    const service: TurnSnapshotService = buildService();
    const captured: TurnSnapshotCaptured = await captureTurn(service);
    const snapshotBytes: Buffer = readFileSync(join(repository.root, "tracked-but-ignored.txt"));

    await repository.git(["rm", "-q", "--cached", "tracked-but-ignored.txt"]);
    repository.write("tracked-but-ignored.txt", "ignored content written after the boundary\n");
    const target: TurnSnapshotRestoreTarget = expectResolved(
      await service.resolveRestoreTarget(buildResolveInput()),
    );

    // The delete pass's listing fails; the derivation's (which carries `-i`)
    // must still run, or the enumeration below would be vacuous.
    const failingRunner: TurnSnapshotGitRunner = async (argv, options) => {
      if (argv.includes("ls-files") && argv.includes("-o") && !argv.includes("-i")) {
        throw new Error("induced untracked-listing failure");
      }
      return runTurnSnapshotGitWithExecFile(argv, options);
    };

    const result = await buildService({ git: failingRunner }).restoreToTurn(target);

    expect(result).toEqual({
      outcome: "partial_restore",
      ref: captured.ref,
      failedStep: "delete-untracked" satisfies TurnSnapshotRestoreStep,
      overwrittenIgnoredPaths: ["tracked-but-ignored.txt"],
      divergentGitlinks: [],
    });
    // NEVER EMPTY-WASHED: the overwrite the failed sequence applied really is on
    // disk, which is what makes the enumeration a report rather than a guess.
    expect(readFileSync(join(repository.root, "tracked-but-ignored.txt"))).toEqual(snapshotBytes);
    expect(fixture.diagnostics).toEqual([
      {
        kind: "restore-failed",
        runId: RUN_ID,
        epoch: 0,
        turnOrdinal: 1,
        ref: captured.ref,
        failedStep: "delete-untracked",
        detail: "induced untracked-listing failure",
        overwrittenIgnoredPaths: ["tracked-but-ignored.txt"],
        divergentGitlinks: [],
      },
    ]);
  });

  // Both symlink cases below need a real symlink, which needs POSIX. CI is
  // ubuntu-only, so these skips are latent there and fire only for a maintainer
  // running the suite on native Windows — the same posture
  // `../../workspace/__tests__/repo-root-resolver.test.ts` takes for its own
  // symlink cases.
  const itOnPosix = it.skipIf(process.platform === "win32");

  itOnPosix(
    "restores a 100755 file's exec bit under a repo-level core.fileMode=false (no pin, either leg)",
    async () => {
      const repository: FixtureRepository = fixture.repository;
      applyTurnEffects();
      repository.write("build.sh", "#!/bin/sh\necho build\n");
      chmodSync(join(repository.root, "build.sh"), 0o755);
      const service: TurnSnapshotService = buildService();
      const captured: TurnSnapshotCaptured = await captureTurn(service);
      expect(await repository.git(["ls-tree", `${captured.ref}^{tree}`, "build.sh"])).toContain(
        "100755 blob",
      );

      // The turn then dropped the bit, and the host declares modes untrustworthy.
      chmodSync(join(repository.root, "build.sh"), 0o644);
      await repository.git(["config", "core.fileMode", "false"]);
      // The control that makes the assertion below mean something: the bit is
      // genuinely GONE before the restore, so restoring it is an effect and not
      // a state that was never lost.
      expect(lstatSync(join(repository.root, "build.sh")).mode & 0o111).toBe(0);

      const target: TurnSnapshotRestoreTarget = expectResolved(
        await service.resolveRestoreTarget(buildResolveInput()),
      );
      expectRestored(await service.restoreToTurn(target));

      // What does the work here is the RECORDED TREE MODE, and nothing else:
      // `read-tree --reset -u` writes the tree's mode irrespective of
      // `core.fileMode` (measured in five shapes; see the service header), so
      // the knob does not reach this leg and no pin exists on either one. The
      // restore direction is therefore safe under a host `false` even though the
      // capture direction has a recorded residual under it — the two legs are
      // exposed differently, which is why they are adjudicated separately.
      expect(lstatSync(join(repository.root, "build.sh")).mode & 0o111).not.toBe(0);
    },
  );

  itOnPosix(
    "enumerates a destroyed DANGLING SYMLINK, which a bytes-only fingerprint missed",
    async () => {
      const repository: FixtureRepository = fixture.repository;
      applyTurnEffects();
      // Collision shape 3 — an ignored entry squatting a directory the snapshot
      // needs — with the entry a symlink whose target does not exist. Measured on
      // git 2.50.1: `ls-files -o -i` reports `collide` as an ordinary (non-slash)
      // entry, and the checkout exits 0 while unlinking it to make the directory.
      repository.write("collide/a.txt", "snapshot child content\n");
      const service: TurnSnapshotService = buildService();
      const captured: TurnSnapshotCaptured = await captureTurn(service);

      rmSync(join(repository.root, "collide"), { recursive: true });
      symlinkSync("no-such-target", join(repository.root, "collide"));
      repository.write(".gitignore", `${FIXTURE_IGNORE_RULES}collide\n`);

      // IN-CASE NEGATIVE CONTROL, and the whole reason this case exists: on BOTH
      // sides of the restore a bytes-only fingerprint reads nothing — `ENOENT`
      // through the dangling link before, `EISDIR` on the directory that replaces
      // it after. The old `string | null` form therefore scored `null` twice,
      // compared them equal, and dropped this path out of the report below.
      expect(readFileErrorCode(join(repository.root, "collide"))).toBe("ENOENT");

      const target: TurnSnapshotRestoreTarget = expectResolved(
        await service.resolveRestoreTarget(buildResolveInput()),
      );
      const result: TurnSnapshotPartialRestore = expectPartialRestore(
        await buildService({ git: buildUntrackedListingFailure() }).restoreToTurn(target),
      );

      expect(result.failedStep).toBe("delete-untracked" satisfies TurnSnapshotRestoreStep);
      expect(result.overwrittenIgnoredPaths).toEqual(["collide"]);
      expect(result.divergentGitlinks).toEqual([]);
      expect(fixture.diagnostics[0]).toMatchObject({
        kind: "restore-failed",
        ref: captured.ref,
        overwrittenIgnoredPaths: ["collide"],
      });

      // Ground truth for the enumeration: the link really is gone and the
      // snapshot's directory really is there — and the after-state is unreadable
      // as bytes, which closes the control.
      expect(readFileErrorCode(join(repository.root, "collide"))).toBe("EISDIR");
      expect(readFileSync(join(repository.root, "collide", "a.txt"), "utf8")).toBe(
        "snapshot child content\n",
      );
    },
  );

  itOnPosix(
    "enumerates a symlink replaced by a BYTE-IDENTICAL file (lstat, not stat)",
    async () => {
      const repository: FixtureRepository = fixture.repository;
      applyTurnEffects();
      // Collision shape 1 — the ignored path IS the snapshot-tracked path — with
      // the ignored entry a LIVE symlink whose target holds exactly the bytes the
      // snapshot will write. Following the link (`stat` + `readFile`) makes the
      // two sides identical; observing the entry (`lstat`) does not.
      repository.write("link-target.txt", "shared payload\n");
      repository.write("collide.txt", "shared payload\n");
      await repository.git(["add", "link-target.txt"]);
      await repository.git(["add", "-f", "collide.txt"]);
      await repository.git(["commit", "-q", "-m", "symlink collision fixture"]);
      const service: TurnSnapshotService = buildService();
      const captured: TurnSnapshotCaptured = await captureTurn(service);

      // `git rm --cached` is not decoration: "untracked" in `ls-files -o` is an
      // INDEX fact, so a path that is merely ignored-by-rule while still in the
      // index never enters the listing and the case would be vacuous.
      await repository.git(["rm", "-q", "--cached", "collide.txt"]);
      rmSync(join(repository.root, "collide.txt"));
      symlinkSync("link-target.txt", join(repository.root, "collide.txt"));
      repository.write(".gitignore", `${FIXTURE_IGNORE_RULES}collide.txt\n`);

      // IN-CASE NEGATIVE CONTROL: the bytes reachable THROUGH the link before the
      // restore are byte-identical to the bytes the snapshot writes at that path,
      // so a bytes-only fingerprint compares the two sides equal and reports
      // nothing. Asserted rather than asserted-by-narrative.
      const bytesThroughLink: Buffer = readFileSync(join(repository.root, "collide.txt"));
      expect(bytesThroughLink).toEqual(readFileSync(join(repository.root, "link-target.txt")));

      const target: TurnSnapshotRestoreTarget = expectResolved(
        await service.resolveRestoreTarget(buildResolveInput()),
      );
      const result: TurnSnapshotPartialRestore = expectPartialRestore(
        await buildService({ git: buildUntrackedListingFailure() }).restoreToTurn(target),
      );

      expect(result.failedStep).toBe("delete-untracked" satisfies TurnSnapshotRestoreStep);
      expect(result.overwrittenIgnoredPaths).toEqual(["collide.txt"]);
      expect(fixture.diagnostics[0]).toMatchObject({
        kind: "restore-failed",
        ref: captured.ref,
        overwrittenIgnoredPaths: ["collide.txt"],
      });

      // Ground truth: the entry is no longer a link, and its bytes are the ones
      // the control proved indistinguishable. The ONLY observable that changed is
      // the entry TYPE, which is exactly what the enumeration now reads.
      expect(lstatSync(join(repository.root, "collide.txt")).isSymbolicLink()).toBe(false);
      expect(readFileSync(join(repository.root, "collide.txt"))).toEqual(bytesThroughLink);
    },
  );

  it("CHARACTERIZES the recorded sparse-checkout residual — out-of-cone content is LOST", async () => {
    const repository: FixtureRepository = fixture.repository;
    // NOT a blessing of this outcome. The service's header records
    // `core.sparseCheckout` as an open residual with a named exposure, and a
    // residual asserted only in prose is one that silently changes. This case
    // pins the CURRENT measured behaviour so the eventual fix — refusing capture
    // in a sparse root, or teaching the staging listing about the patterns — has
    // to come here and say so.
    repository.write("cone-in/kept.txt", "in-cone content\n");
    repository.write("cone-out/excluded.txt", "out-of-cone content\n");
    await repository.git(["add", "-A"]);
    await repository.git(["commit", "-q", "-m", "sparse fixture"]);
    // Cone mode always keeps root-level files, so this prunes `cone-out/` alone.
    await repository.git(["sparse-checkout", "set", "cone-in"]);
    expect(existsSync(join(repository.root, "cone-out"))).toBe(false);

    // ROOT CAUSE, asserted directly: the capture's scratch index is seeded by a
    // bare `read-tree` and carries NO skip-worktree bits, so the out-of-cone path
    // is listed as an ordinary cached entry and `--remove` drops it for being
    // absent from the worktree. The snapshot tree simply does not contain it.
    //
    // Nothing refreshes the real index between the sparse set and this capture,
    // deliberately: `git status` CLEARS skip-worktree for an out-of-cone path
    // present on disk, which would confound the fixture in the other direction.
    const service: TurnSnapshotService = buildService();
    const captured: TurnSnapshotCaptured = await captureTurn(service);
    const snapshotPaths: string = await repository.git([
      "ls-tree",
      "-r",
      "--name-only",
      `${captured.ref}^{tree}`,
    ]);
    expect(snapshotPaths).toContain("cone-in/kept.txt");
    expect(snapshotPaths).not.toContain("cone-out/excluded.txt");

    // The turn then writes at the out-of-cone path — the content codex's repro
    // loses. It is post-snapshot content by construction, since the snapshot
    // above does not hold that path at all.
    repository.write("cone-out/excluded.txt", "written by the turn, out of cone\n");

    const target: TurnSnapshotRestoreTarget = expectResolved(
      await service.resolveRestoreTarget(buildResolveInput()),
    );
    const restored: TurnSnapshotRestored = expectRestored(await service.restoreToTurn(target));

    // The silent-success arm: `restored`, with BOTH enumerations empty. The loss
    // is not a collision (the path is not ignored) and not a gitlink, so no
    // existing enumeration can carry it — which is the residual, stated as an
    // assertion.
    expect(restored.overwrittenIgnoredPaths).toEqual([]);
    expect(restored.divergentGitlinks).toEqual([]);
    expect(existsSync(join(repository.root, "cone-out", "excluded.txt"))).toBe(false);

    // …and the sparse checkout itself is left incoherent: the closing reset
    // returns the index to `HEAD`, which DOES track the path, so `git status`
    // reports the whole out-of-cone set as deleted where it previously reported
    // a clean tree.
    expect(await repository.git(["status", "--porcelain"])).toContain("cone-out/excluded.txt");

    // NEGATIVE CONTROL for the pin that is deliberately NOT added: measured on
    // git 2.50.1, a checkout leg carrying `-c core.sparseCheckout=false` produces
    // the identical loss. The pin suppresses git's `not uptodate` advisory and
    // changes nothing else, so adding it would buy a quieter failure and no fix.
    repository.write("cone-out/excluded.txt", "written again, out of cone\n");
    await repository.git([
      "-c",
      "core.sparseCheckout=false",
      "read-tree",
      "--reset",
      "-u",
      captured.snapshotCommit,
    ]);
    expect(existsSync(join(repository.root, "cone-out", "excluded.txt"))).toBe(false);
  });

  it("enumerates an overwrite applied by a read-tree that then failed IN-COMMAND", async () => {
    const repository: FixtureRepository = fixture.repository;
    // `a-…` before `z-…`: the checkout applies in index order, so the collision
    // is overwritten BEFORE the filtered path fails. This is the case the spec
    // records as empirically confirmed — `read-tree -u` is not transactional.
    repository.write(".gitattributes", "z-filtered.txt filter=boom\n");
    repository.write("z-filtered.txt", "filtered payload\n");
    repository.write(
      ".gitignore",
      "ignored-dir/\nignored-file.txt\ntracked-but-ignored.txt\na-collide.txt\n",
    );
    repository.write("a-collide.txt", "snapshot content at the colliding path\n");
    await repository.git(["add", "-A"]);
    await repository.git(["add", "-f", "a-collide.txt"]);
    await repository.git(["commit", "-q", "-m", "filter fixture"]);
    const service: TurnSnapshotService = buildService();
    const captured: TurnSnapshotCaptured = await captureTurn(service);
    const snapshotBytes: Buffer = readFileSync(join(repository.root, "a-collide.txt"));

    // The turn: the collision, plus an edit to the filtered path so the checkout
    // genuinely has to rewrite it.
    await repository.git(["rm", "-q", "--cached", "a-collide.txt"]);
    repository.write("a-collide.txt", "ignored content written after the boundary\n");
    repository.write("z-filtered.txt", "modified after the boundary\n");
    // A REQUIRED smudge filter that fails. No seam injection anywhere in this
    // case: the production runner spawns a real git that really exits 128.
    await repository.git(["config", "filter.boom.clean", "cat"]);
    await repository.git(["config", "filter.boom.smudge", "false"]);
    await repository.git(["config", "filter.boom.required", "true"]);

    const target: TurnSnapshotRestoreTarget = expectResolved(
      await service.resolveRestoreTarget(buildResolveInput()),
    );
    const result: TurnSnapshotPartialRestore = expectPartialRestore(
      await service.restoreToTurn(target),
    );

    expect(result.ref).toBe(captured.ref);
    expect(result.failedStep).toBe("read-tree" satisfies TurnSnapshotRestoreStep);
    expect(result.overwrittenIgnoredPaths).toEqual(["a-collide.txt"]);
    expect(result.divergentGitlinks).toEqual([]);
    // The failing command's OWN partial writes: the earlier path is on disk with
    // the snapshot's bytes even though the command exited non-zero.
    expect(readFileSync(join(repository.root, "a-collide.txt"))).toEqual(snapshotBytes);
    expect(fixture.diagnostics[0]).toMatchObject({
      kind: "restore-failed",
      failedStep: "read-tree",
      overwrittenIgnoredPaths: ["a-collide.txt"],
    });
  });

  it("carries both enumerations empty when the failure lands before any mutation", async () => {
    const repository: FixtureRepository = fixture.repository;
    applyTurnEffects();
    await createEmbeddedRepository("embedded");
    const service: TurnSnapshotService = buildService();
    const captured: TurnSnapshotCaptured = await captureTurn(service);

    // The fixture deliberately HAS both candidates at restore time — a colliding
    // ignored path and a gitlink whose working copy is gone — so the empty pair
    // below is a statement about what was applied, not about an empty fixture.
    await repository.git(["rm", "-q", "--cached", "tracked-but-ignored.txt"]);
    repository.write("tracked-but-ignored.txt", "ignored content written after the boundary\n");
    rmSync(join(repository.root, "embedded"), { recursive: true, force: true });
    const ignoredBytes: Buffer = readFileSync(join(repository.root, "tracked-but-ignored.txt"));

    const target: TurnSnapshotRestoreTarget = expectResolved(
      await service.resolveRestoreTarget(buildResolveInput()),
    );
    const censusBefore: string = collectWorktreeCensus(repository.root);

    const failingRunner: TurnSnapshotGitRunner = async (argv, options) => {
      if (argv.includes("read-tree")) {
        throw new Error("induced read-tree failure");
      }
      return runTurnSnapshotGitWithExecFile(argv, options);
    };
    const result = await buildService({ git: failingRunner }).restoreToTurn(target);

    expect(result).toEqual({
      outcome: "partial_restore",
      ref: captured.ref,
      failedStep: "read-tree" satisfies TurnSnapshotRestoreStep,
      overwrittenIgnoredPaths: [],
      divergentGitlinks: [],
    });
    // …and the emptiness is the truth: nothing on disk moved.
    expect(collectWorktreeCensus(repository.root)).toBe(censusBefore);
    expect(readFileSync(join(repository.root, "tracked-but-ignored.txt"))).toEqual(ignoredBytes);
    expect(existsSync(join(repository.root, "embedded"))).toBe(false);

    // CONVERGENCE, and the non-vacuity control in one: a fresh restore of the
    // SAME target — the spec's recovery path — completes and enumerates both
    // candidates the derivation could see all along.
    const recovered: TurnSnapshotRestored = expectRestored(await service.restoreToTurn(target));
    expect(recovered.overwrittenIgnoredPaths).toEqual(["tracked-but-ignored.txt"]);
    expect(recovered.divergentGitlinks).toEqual(["embedded"]);
  });

  it("fails the delete pass on the FIRST unproductive pass, naming the stuck path", async () => {
    const repository: FixtureRepository = fixture.repository;
    applyTurnEffects();
    const service: TurnSnapshotService = buildService();
    await captureTurn(service);
    repository.write("post-snapshot.txt", "arrived after the boundary\n");
    const target: TurnSnapshotRestoreTarget = expectResolved(
      await service.resolveRestoreTarget(buildResolveInput()),
    );

    // A seam that REPORTS a deletion it did not perform is the one input the
    // spec's termination argument does not cover — every pass lists the same
    // file forever. The real-world shape is a path name that is not valid UTF-8:
    // it reaches the seam mangled, `rm --force` finds nothing and swallows it.
    // Grinding out the remaining passes would be dozens of full worktree walks
    // under the caller's exclusive hold, so the identical listing is the signal.
    const lyingFilesystem: TurnSnapshotFilesystem = {
      createDirectory(path: string): Promise<void> {
        mkdirSync(path, { recursive: true });
        return Promise.resolve();
      },
      removePath(): Promise<void> {
        return Promise.resolve();
      },
      removeDirectoryIfEmpty(): Promise<void> {
        return Promise.resolve();
      },
    };
    const listingInvocations: string[][] = [];
    const countingRunner: TurnSnapshotGitRunner = async (argv, options) => {
      if (argv.includes("ls-files") && argv.includes("-o") && !argv.includes("-i")) {
        listingInvocations.push([...argv]);
      }
      return runTurnSnapshotGitWithExecFile(argv, options);
    };

    const result: TurnSnapshotPartialRestore = expectPartialRestore(
      await buildService({
        filesystem: lyingFilesystem,
        git: countingRunner,
      }).restoreToTurn(target),
    );

    expect(result.failedStep).toBe("delete-untracked" satisfies TurnSnapshotRestoreStep);
    // Both enumerations are REQUIRED on `partial_restore`, empty-when-none — a
    // failure arm that omits one is exactly the shape T3.13's identity mapping
    // cannot carry. This fixture has no ignored collision and no gitlink, so
    // empty here is the truth rather than an empty-wash.
    expect(result.overwrittenIgnoredPaths).toEqual([]);
    expect(result.divergentGitlinks).toEqual([]);
    // The detail is the whole discriminating power of this case: `failedStep`
    // alone reads the same whether the pass gave up on the second listing or
    // ground through the ceiling.
    expect(fixture.diagnostics[0]).toMatchObject({
      kind: "restore-failed",
      failedStep: "delete-untracked",
      detail: "turn-snapshot untracked-delete made no progress at post-snapshot.txt",
    });
    // TWO listings, not sixty-four: the pass that saw the identical listing is
    // the one that failed.
    expect(listingInvocations).toHaveLength(2);
    expect(existsSync(join(repository.root, "post-snapshot.txt"))).toBe(true);
  });

  it(
    "stops at the pass ceiling when every pass changes the listing but none converges",
    { timeout: MULTI_SEQUENCE_CASE_TIMEOUT_MS },
    async () => {
      const repository: FixtureRepository = fixture.repository;
      applyTurnEffects();
      const service: TurnSnapshotService = buildService();
      await captureTurn(service);
      repository.write("post-snapshot.txt", "arrived after the boundary\n");
      const target: TurnSnapshotRestoreTarget = expectResolved(
        await service.resolveRestoreTarget(buildResolveInput()),
      );

      // The shape the no-progress check does NOT cover, and the reason the ceiling
      // stays: a seam whose removals genuinely remove but keep minting new
      // untracked content, so every listing differs and the sequence never
      // converges. This is the only path that reaches the final pass, which is why
      // it is driven explicitly rather than assumed unreachable.
      let churnCounter = 0;
      const churningFilesystem: TurnSnapshotFilesystem = {
        createDirectory(path: string): Promise<void> {
          mkdirSync(path, { recursive: true });
          return Promise.resolve();
        },
        removePath(path: string): Promise<void> {
          rmSync(path, { recursive: true, force: true });
          writeFileSync(join(repository.root, `churn-${String(churnCounter)}.txt`), "churn\n");
          churnCounter += 1;
          return Promise.resolve();
        },
        removeDirectoryIfEmpty(): Promise<void> {
          return Promise.resolve();
        },
      };

      const result: TurnSnapshotPartialRestore = expectPartialRestore(
        await buildService({ filesystem: churningFilesystem }).restoreToTurn(target),
      );

      expect(result.failedStep).toBe("delete-untracked" satisfies TurnSnapshotRestoreStep);
      expect(fixture.diagnostics[0]).toMatchObject({
        kind: "restore-failed",
        failedStep: "delete-untracked",
        detail: "turn-snapshot untracked-delete pass did not reach a fixpoint",
      });
      // The ceiling is EXACTLY the constant: sixty-four passes ran, each deleting
      // one path and minting the next. An off-by-one in the loop bound shows up
      // here as a count rather than as a message that reads the same either way.
      expect(churnCounter).toBe(64);
      expect(existsSync(join(repository.root, "churn-63.txt"))).toBe(true);
    },
  );

  it("runs every restore invocation hook-neutralized, with the pinned recipe argv (D-010-10)", async () => {
    const repository: FixtureRepository = fixture.repository;
    applyTurnEffects();
    const service: TurnSnapshotService = buildService();
    const captured: TurnSnapshotCaptured = await captureTurn(service);
    applyPostSnapshotEffects();
    const target: TurnSnapshotRestoreTarget = expectResolved(
      await service.resolveRestoreTarget(buildResolveInput()),
    );

    const invocations: {
      readonly argv: readonly string[];
      readonly environmentOverrides?: Readonly<Record<string, string>>;
    }[] = [];
    const recordingRunner: TurnSnapshotGitRunner = async (argv, options) => {
      invocations.push({
        argv: [...argv],
        ...(options.environmentOverrides === undefined
          ? {}
          : { environmentOverrides: options.environmentOverrides }),
      });
      return runTurnSnapshotGitWithExecFile(argv, options);
    };

    expectRestored(await buildService({ git: recordingRunner }).restoreToTurn(target));

    const neutralizationFlags: readonly string[] = [
      "-c",
      `core.hooksPath=${join(fixture.executionRootsDirectory, ".hook-neutralization")}`,
      "-c",
      "core.fsmonitor=false",
    ];
    expect(invocations.length).toBeGreaterThan(1);
    for (const invocation of invocations) {
      expect(invocation.argv.slice(0, 4)).toEqual(neutralizationFlags);
    }

    // The checkout leg, spelled verbatim: the four conversion pins plus
    // `GIT_ATTR_NOSYSTEM=1`. TWO mechanisms, covering two different files —
    // `core.attributesFile=/dev/null` takes the USER attributes file out of the
    // smudge decision and the environment variable takes the SYSTEM one; neither
    // covers the other's, and in-tree `.gitattributes` stays deliberately
    // honoured by both.
    //
    // `core.eol=lf` sits between `core.autocrlf=false` and `submodule.recurse=false`
    // because the pin before it is what gives it authority: measured, a host
    // `core.autocrlf=true` overrides `core.eol` entirely. This exact-argv
    // assertion is the structural half of that pin's coverage — the behavioural
    // half, with its own negative control, is the host-`core.eol` case in the
    // conversion-pin group.
    //
    // The final token is the OID the resolve verified, NOT `captured.ref` — the
    // tree-ish the destructive leg writes is fixed at resolve time rather than
    // re-resolved from a mutable name here. `captured.ref` is asserted alongside
    // as the negative control, so a regression that put the name back cannot pass
    // by the two spellings happening to agree.
    // `core.useReplaceRefs=false` is last of the five and is a different KIND of
    // pin from the four before it: those decide how bytes are converted, this one
    // decides whether the OID names the object it says it does. Freezing the id
    // is not sufficient without it — see the hostile-replace-ref cases below for
    // the behavioural half.
    const checkoutLeg = invocations.find((invocation) => invocation.argv.includes("-u"));
    expect(checkoutLeg?.argv).toEqual([
      ...neutralizationFlags,
      "-C",
      repository.root,
      "-c",
      "core.autocrlf=false",
      "-c",
      "core.eol=lf",
      "-c",
      "submodule.recurse=false",
      "-c",
      "core.attributesFile=/dev/null",
      "-c",
      "core.useReplaceRefs=false",
      "read-tree",
      "--reset",
      "-u",
      captured.snapshotCommit,
    ]);
    expect(checkoutLeg?.argv).not.toContain(captured.ref);
    expect(checkoutLeg?.environmentOverrides).toEqual({ GIT_ATTR_NOSYSTEM: "1" });

    // …and the CLOSING leg is last and index-only: no `-u`, so worktree bytes
    // are untouched by it. Ordering is the load-bearing half — a close that ran
    // before the delete pass would return the index to the branch tip and make
    // every captured-untracked file a deletion candidate.
    //
    // The reset target is the verified OID, NOT the name `HEAD`: the check that
    // precedes this spawn is a check-then-act on a mutable name, and letting git
    // re-resolve the name inside the gap is what would close the index against a
    // commit nobody verified. Pinned against the capture's own base commit rather
    // than against `target.expectedHead`, so the assertion is independent of the
    // value the service threaded through.
    expect(target.expectedHead).toBe(captured.baseCommit);
    expect(invocations.at(-1)?.argv).toEqual([
      ...neutralizationFlags,
      "-C",
      repository.root,
      "read-tree",
      "--reset",
      captured.baseCommit,
    ]);
  });

  it("refuses with NO mutation when HEAD moves during the enumeration derivation", async () => {
    const repository: FixtureRepository = fixture.repository;
    applyTurnEffects();
    const service: TurnSnapshotService = buildService();
    await captureTurn(service);
    applyPostSnapshotEffects();
    const target: TurnSnapshotRestoreTarget = expectResolved(
      await service.resolveRestoreTarget(buildResolveInput()),
    );
    const censusBefore: string = collectWorktreeCensus(repository.root);
    const indexBefore: string = readIndexFingerprint(repository.root);

    // The derivation's two listings are themselves a window: the caller's
    // exclusive tenancy excludes other RUNS, not the user's own terminal. This
    // side of `read-tree` the window is still closable for free, and the answer
    // is the same refusal the entry check gives.
    let movedHead: string | null = null;
    const committingRunner: TurnSnapshotGitRunner = async (argv, options) => {
      if (argv.includes("ls-tree") && movedHead === null) {
        movedHead = await advanceHeadWithoutTouchingWorktree("landed during the derivation");
      }
      return runTurnSnapshotGitWithExecFile(argv, options);
    };

    const result: TurnSnapshotRestoreResult = await buildService({
      git: committingRunner,
    }).restoreToTurn(target);

    expect(result).toEqual({
      outcome: "head_moved",
      ref: target.ref,
      expectedHead: target.expectedHead,
      observedHead: movedHead,
    });
    // The DISCRIMINATING half. Without the post-derivation read this same
    // fixture still refuses — one leg later, at `close-index`, as a
    // `partial_restore` — so the outcome alone does not distinguish the two. The
    // untouched census does: it is the difference between refusing and
    // rewriting the whole worktree first.
    expect(collectWorktreeCensus(repository.root)).toBe(censusBefore);
    expect(readIndexFingerprint(repository.root)).toBe(indexBefore);
    expect(fixture.diagnostics).toEqual([]);
  });

  it("reports partial_restore at close-index when HEAD moves after the checkout", async () => {
    const repository: FixtureRepository = fixture.repository;
    applyTurnEffects();
    const service: TurnSnapshotService = buildService();
    const captured: TurnSnapshotCaptured = await captureTurn(service);
    const snapshotBytes: Buffer = readFileSync(join(repository.root, "tracked-but-ignored.txt"));

    // A collision in the fixture, so the arm's enumerations are non-empty and
    // this case pins that the close-index refusal routes through the same
    // observation the other partial arms do.
    await repository.git(["rm", "-q", "--cached", "tracked-but-ignored.txt"]);
    repository.write("tracked-but-ignored.txt", "ignored content written after the boundary\n");
    const target: TurnSnapshotRestoreTarget = expectResolved(
      await service.resolveRestoreTarget(buildResolveInput()),
    );

    // Past `read-tree` the worktree already holds snapshot content, so this
    // window has a different answer: closing the index against the MOVED `HEAD`
    // would anti-diff the newer commit's files into the worktree as ordinary
    // unstaged modifications and report `restored` — the fabricated edit intent
    // the closing reset exists to prevent (git 2.50.1).
    let movedHead: string | null = null;
    const committingRunner: TurnSnapshotGitRunner = async (argv, options) => {
      if (
        argv.includes("ls-files") &&
        argv.includes("-o") &&
        !argv.includes("-i") &&
        movedHead === null
      ) {
        movedHead = await advanceHeadWithoutTouchingWorktree("landed after the checkout");
      }
      return runTurnSnapshotGitWithExecFile(argv, options);
    };

    const result: TurnSnapshotPartialRestore = expectPartialRestore(
      await buildService({ git: committingRunner }).restoreToTurn(target),
    );

    expect(result).toEqual({
      outcome: "partial_restore",
      ref: captured.ref,
      failedStep: "close-index" satisfies TurnSnapshotRestoreStep,
      overwrittenIgnoredPaths: ["tracked-but-ignored.txt"],
      divergentGitlinks: [],
    });
    expect(fixture.diagnostics[0]).toMatchObject({
      kind: "restore-failed",
      failedStep: "close-index",
      detail: "HEAD moved between the checkout and the closing index reset",
    });
    // The checkout DID apply — this is a partial restore, not a refusal.
    expect(readFileSync(join(repository.root, "tracked-but-ignored.txt"))).toEqual(snapshotBytes);
    // …and the index was left at the SNAPSHOT tree rather than closed against
    // the moved `HEAD`. That is the whole point: `git status` shows a loudly
    // staged, visibly half-applied rollback instead of a plausible lie about
    // somebody having edited these files by hand.
    expect(await repository.git(["write-tree"])).toBe(
      await repository.git(["rev-parse", `${captured.snapshotCommit}^{tree}`]),
    );
    expect(await repository.git(["rev-parse", "HEAD"])).toBe(movedHead);
  });

  it("reports partial_restore at close-index with a DISTINCT detail when HEAD cannot be read", async () => {
    const repository: FixtureRepository = fixture.repository;
    applyTurnEffects();
    const service: TurnSnapshotService = buildService();
    const captured: TurnSnapshotCaptured = await captureTurn(service);
    const snapshotBytes: Buffer = readFileSync(join(repository.root, "tracked-but-ignored.txt"));

    // The same collision the moved-`HEAD` case uses, so the two differ in exactly
    // one thing: which cause tripped the guard.
    await repository.git(["rm", "-q", "--cached", "tracked-but-ignored.txt"]);
    repository.write("tracked-but-ignored.txt", "ignored content written after the boundary\n");
    const target: TurnSnapshotRestoreTarget = expectResolved(
      await service.resolveRestoreTarget(buildResolveInput()),
    );

    // Same guard, OTHER cause — and the recovery properties are opposite: a moved
    // `HEAD` is terminal for this target (the resolve refuses from then on) while
    // an unreadable one is an environmental fault that may retry clean. Since
    // `failedStep` is `close-index` either way, the diagnostic detail is the only
    // place an operator can tell them apart.
    //
    // The THIRD `HEAD` read at the execution root is the pre-close one — entry,
    // post-derivation, pre-close — and a gitlink probe would carry a different
    // `-C`, so counting root reads isolates the one this case is about.
    let rootHeadReads: number = 0;
    const failingRunner: TurnSnapshotGitRunner = async (argv, options) => {
      const rootFlagIndex: number = argv.indexOf("-C");
      if (
        argv[rootFlagIndex + 1] === repository.root &&
        argv.includes("rev-parse") &&
        argv.at(-1) === "HEAD"
      ) {
        rootHeadReads += 1;
        if (rootHeadReads === 3) {
          throw new Error("induced: HEAD unreadable at the pre-close read only");
        }
      }
      return runTurnSnapshotGitWithExecFile(argv, options);
    };

    const result: TurnSnapshotPartialRestore = expectPartialRestore(
      await buildService({ git: failingRunner }).restoreToTurn(target),
    );

    // Pins the four-point check story as executable: three root `HEAD` reads
    // inside the restore, the third of them the one that was failed.
    expect(rootHeadReads).toBe(3);
    expect(result).toEqual({
      outcome: "partial_restore",
      ref: captured.ref,
      failedStep: "close-index" satisfies TurnSnapshotRestoreStep,
      overwrittenIgnoredPaths: ["tracked-but-ignored.txt"],
      divergentGitlinks: [],
    });
    expect(fixture.diagnostics[0]).toMatchObject({
      kind: "restore-failed",
      failedStep: "close-index",
      detail: "HEAD could not be read before the closing index reset",
    });
    // …and NOT the moved-`HEAD` wording. Collapsing the two would tell an
    // operator the target is finished when a retry would have worked.
    expect(fixture.diagnostics[0]).not.toMatchObject({
      detail: "HEAD moved between the checkout and the closing index reset",
    });

    // The checkout DID apply, and the index was left at the SNAPSHOT tree — the
    // same loudly-staged half-applied state the moved-`HEAD` refusal leaves.
    expect(readFileSync(join(repository.root, "tracked-but-ignored.txt"))).toEqual(snapshotBytes);
    expect(await repository.git(["write-tree"])).toBe(
      await repository.git(["rev-parse", `${captured.snapshotCommit}^{tree}`]),
    );
    // `HEAD` itself never moved here; the fault was in READING it.
    expect(await repository.git(["rev-parse", "HEAD"])).toBe(captured.baseCommit);
  });

  it("refuses a target this service did not mint, mutating nothing", async () => {
    const repository: FixtureRepository = fixture.repository;
    applyTurnEffects();
    const service: TurnSnapshotService = buildService();
    const captured: TurnSnapshotCaptured = await captureTurn(service);
    applyPostSnapshotEffects();
    const genuine: TurnSnapshotRestoreTarget = expectResolved(
      await service.resolveRestoreTarget(buildResolveInput()),
    );
    const censusBefore: string = collectWorktreeCensus(repository.root);
    const indexBefore: string = readIndexFingerprint(repository.root);

    // Structurally identical to the real thing, field for field — and pointed at
    // a BRANCH. `restoreToTurn` drives `read-tree --reset -u <ref>` at the root
    // on this object, so accepting it would be an arbitrary checkout wearing the
    // service's authority and its hook neutralization. The double cast is the
    // point: this literal does not typecheck as a target, and the runtime check
    // is what covers the JS caller who never had to.
    const forged = {
      outcome: "resolved",
      executionRoot: repository.root,
      runId: RUN_ID,
      targetPosition: 1,
      owningEpoch: 0,
      ref: "refs/heads/main",
      snapshotCommit: captured.snapshotCommit,
      expectedHead: captured.baseCommit,
    } as unknown as TurnSnapshotRestoreTarget;

    // A THROW rather than an outcome: all three result arms are wire-pinned
    // statements about a worktree, and this call touched none.
    await expect(service.restoreToTurn(forged)).rejects.toThrow(
      "turn-snapshot restore target was not minted by resolveRestoreTarget",
    );
    expect(collectWorktreeCensus(repository.root)).toBe(censusBefore);
    expect(readIndexFingerprint(repository.root)).toBe(indexBefore);
    expect(fixture.diagnostics).toEqual([]);

    // The SECOND forgery, and the one a brand FIELD could not have caught:
    // `private constructor` is a compile-time modifier that erases at emit, so
    // this genuinely runs the constructor body and installs `#mintedByResolver`.
    // What separates it from a real target is PROVENANCE — the module-private
    // registry only the mint writes. The cast is needed because the private
    // constructor makes the class unassignable to a constructor type; the JS
    // caller this stands in for needs no cast at all.
    const constructed: TurnSnapshotRestoreTarget = Reflect.construct(
      TurnSnapshotRestoreTarget as unknown as new (fields: unknown) => TurnSnapshotRestoreTarget,
      [
        {
          executionRoot: repository.root,
          runId: RUN_ID,
          targetPosition: 1,
          owningEpoch: 0,
          ref: "refs/heads/main",
          snapshotCommit: captured.snapshotCommit,
          expectedHead: captured.baseCommit,
        },
      ],
    );
    // The construction really happened — otherwise the refusal below would pass
    // for the wrong reason.
    expect(constructed.ref).toBe("refs/heads/main");
    await expect(service.restoreToTurn(constructed)).rejects.toThrow(
      "turn-snapshot restore target was not minted by resolveRestoreTarget",
    );
    expect(collectWorktreeCensus(repository.root)).toBe(censusBefore);
    expect(readIndexFingerprint(repository.root)).toBe(indexBefore);
    expect(fixture.diagnostics).toEqual([]);

    // The NEGATIVE CONTROL: the genuine target for the same repository is
    // accepted by the same call, so the refusal is about provenance rather than
    // about anything else in the fixture. The mint also froze it — `readonly`
    // erases at emit, so the freeze is what stops a holder of a GENUINE target
    // from reassigning `ref` after the resolve (the registry only refuses
    // forgeries; see the class docblock's third mechanism).
    expect(Object.isFrozen(genuine)).toBe(true);
    expectRestored(await service.restoreToTurn(genuine));
  });

  it("refuses head_moved with a null observedHead when HEAD cannot be read at dispatch", async () => {
    const repository: FixtureRepository = fixture.repository;
    applyTurnEffects();
    const service: TurnSnapshotService = buildService();
    await captureTurn(service);
    applyPostSnapshotEffects();
    const target: TurnSnapshotRestoreTarget = expectResolved(
      await service.resolveRestoreTarget(buildResolveInput()),
    );
    const censusBefore: string = collectWorktreeCensus(repository.root);
    const indexBefore: string = readIndexFingerprint(repository.root);

    // Fail-closed on the DESTRUCTIVE leg: the equality has to be established,
    // so a `HEAD` that cannot be read refuses exactly as a mismatch does. This
    // is the arm that decides whether an unreadable repository gets a checkout.
    const failingRunner: TurnSnapshotGitRunner = async (argv, options) => {
      if (argv.includes("rev-parse") && argv.includes("HEAD")) {
        throw new Error("induced: HEAD could not be read");
      }
      return runTurnSnapshotGitWithExecFile(argv, options);
    };

    const result: TurnSnapshotRestoreResult = await buildService({
      git: failingRunner,
    }).restoreToTurn(target);

    expect(result).toEqual({
      outcome: "head_moved",
      ref: target.ref,
      expectedHead: target.expectedHead,
      observedHead: null,
    });
    expect(collectWorktreeCensus(repository.root)).toBe(censusBefore);
    expect(readIndexFingerprint(repository.root)).toBe(indexBefore);
    expect(fixture.diagnostics).toEqual([]);
  });

  it("leaves post-boundary content inside a snapshot-gitlink path alone, enumerating the divergence", async () => {
    const repository: FixtureRepository = fixture.repository;
    applyTurnEffects();
    await createEmbeddedRepository("embedded");
    const service: TurnSnapshotService = buildService();
    const captured: TurnSnapshotCaptured = await captureTurn(service);

    // The turn removed the embedded repository's `.git` and left its files, so
    // the snapshot's `160000` entry now names a path that is an ORDINARY
    // directory — and then wrote more content inside it.
    rmSync(join(repository.root, "embedded", ".git"), { recursive: true, force: true });
    repository.write("embedded/after-the-boundary.txt", "arrived post-snapshot\n");
    // The same content OUTSIDE the gitlink path — the control for the blind spot.
    repository.write("post-snapshot.txt", "arrived post-snapshot\n");
    const innerBytes: Buffer = readFileSync(join(repository.root, "embedded", "inner.txt"));

    const target: TurnSnapshotRestoreTarget = expectResolved(
      await service.resolveRestoreTarget(buildResolveInput()),
    );
    const restored: TurnSnapshotRestored = expectRestored(await service.restoreToTurn(target));

    expect(restored).toEqual({
      outcome: "restored",
      ref: captured.ref,
      snapshotCommit: captured.snapshotCommit,
      overwrittenIgnoredPaths: [],
      // No `.git` to ask, so the gitlink cannot match: divergent, and reported.
      divergentGitlinks: ["embedded"],
    });
    // The BLIND SPOT, pinned as behaviour rather than left to inference: git's
    // `ls-files -o` does not descend into a path the index holds as a gitlink,
    // even when the working copy there is a plain directory — so the delete pass
    // never sees this file and post-boundary content inside a snapshot-gitlink
    // path SURVIVES the restore. Everywhere else in the tree it would be gone.
    expect(existsSync(join(repository.root, "embedded", "after-the-boundary.txt"))).toBe(true);
    expect(readFileSync(join(repository.root, "embedded", "inner.txt"))).toEqual(innerBytes);
    // The control that makes the previous assertion a statement about the
    // gitlink boundary rather than about the delete pass being inert: identical
    // post-boundary content OUTSIDE that path is deleted.
    expect(existsSync(join(repository.root, "post-snapshot.txt"))).toBe(false);
  });

  itOnPosix(
    "enumerates a SYMLINK destroyed where a divergent gitlink was materialized",
    async () => {
      const repository: FixtureRepository = fixture.repository;
      applyTurnEffects();
      await createEmbeddedRepository("embedded");
      const service: TurnSnapshotService = buildService();
      const captured: TurnSnapshotCaptured = await captureTurn(service);

      // The turn replaced the embedded repository with a SYMLINK pointing at a
      // directory. This is the case a `stat`-based presence boolean could not
      // see: `stat` follows, so the symlink scored "already a directory" and the
      // failure report skipped it — while the checkout really does unlink it and
      // materialize an empty gitlink directory in its place (measured).
      rmSync(join(repository.root, "embedded"), { recursive: true, force: true });
      const linkTarget: string = join(fixture.fixtureRoot, "symlink-target-directory");
      mkdirSync(linkTarget, { recursive: true });
      writeFileSync(join(linkTarget, "payload.txt"), "the symlink's target\n");
      symlinkSync(linkTarget, join(repository.root, "embedded"));
      expect(lstatSync(join(repository.root, "embedded")).isSymbolicLink()).toBe(true);
      // The fixture's hostility, stated as the assertion the OLD mechanism made:
      // a symlink-following stat cannot distinguish this from a real directory.
      expect(statSync(join(repository.root, "embedded")).isDirectory()).toBe(true);

      const target: TurnSnapshotRestoreTarget = expectResolved(
        await service.resolveRestoreTarget(buildResolveInput()),
      );
      const result: TurnSnapshotPartialRestore = expectPartialRestore(
        await buildService({ git: buildUntrackedListingFailure() }).restoreToTurn(target),
      );

      expect(result.ref).toBe(captured.ref);
      expect(result.failedStep).toBe("delete-untracked" satisfies TurnSnapshotRestoreStep);
      // The whole finding: a destroyed symlink at a gitlink path is DATA LOSS the
      // partial-restore report has to name, and the type-aware fingerprint is what
      // sees it — `symlink:<hash>` before, `directory` after.
      expect(result.divergentGitlinks).toEqual(["embedded"]);
      expect(lstatSync(join(repository.root, "embedded")).isSymbolicLink()).toBe(false);
      // …and the report is about the LINK, not its target, which is untouched.
      expect(readFileSync(join(linkTarget, "payload.txt"), "utf8")).toBe("the symlink's target\n");
    },
  );

  it("does NOT enumerate a divergent submodule the failed sequence never touched", async () => {
    const repository: FixtureRepository = fixture.repository;
    const embeddedRoot: string = join(repository.root, "embedded");
    applyTurnEffects();
    await createEmbeddedRepository("embedded");
    const service: TurnSnapshotService = buildService();
    await captureTurn(service);

    // Divergent — its HEAD moved past the snapshot's gitlink — but still a real
    // directory holding a real repository, so `submodule.recurse=false` means the
    // checkout applied NOTHING here.
    writeFileSync(join(embeddedRoot, "inner.txt"), "inner v2\n");
    await repository.git(["add", "-A"], { cwd: embeddedRoot });
    await repository.git(["commit", "-q", "-m", "inner v2"], { cwd: embeddedRoot });

    const target: TurnSnapshotRestoreTarget = expectResolved(
      await service.resolveRestoreTarget(buildResolveInput()),
    );
    const result: TurnSnapshotPartialRestore = expectPartialRestore(
      await buildService({ git: buildUntrackedListingFailure() }).restoreToTurn(target),
    );

    // The answer the fingerprint switch had to PRESERVE: `directory` on both
    // sides compares equal, so a path nothing happened at is not reported as an
    // applied effect. Without this the enumeration would name every divergent
    // submodule on every partial restore and mean nothing.
    expect(result.failedStep).toBe("delete-untracked" satisfies TurnSnapshotRestoreStep);
    expect(result.divergentGitlinks).toEqual([]);
    expect(existsSync(join(embeddedRoot, ".git"))).toBe(true);
  });

  it("restores the snapshot's own tree past a replace ref planted on the snapshot commit", async () => {
    const repository: FixtureRepository = fixture.repository;
    applyTurnEffects();
    const service: TurnSnapshotService = buildService();
    const captured: TurnSnapshotCaptured = await captureTurn(service);
    const snapshotBytes: Buffer = readFileSync(join(repository.root, "tracked.txt"));

    // The attacker's commit carries the SAME parent as the snapshot — which is
    // what makes this interesting. Every `HEAD` guard in the restore compares
    // `<snapshot>^` against `HEAD`, so a replacement sharing the parent sails
    // through all three of them, and only the object reads decide what lands.
    repository.write("attacker-payload.txt", "attacker payload\n");
    repository.write("tracked.txt", "attacker rewrote this\n");
    const attackerIndex: string = join(fixture.fixtureRoot, "restore-attacker.index");
    const attackerEnvironment = { GIT_INDEX_FILE: attackerIndex };
    await repository.git(["read-tree", captured.snapshotCommit], {
      environmentOverrides: attackerEnvironment,
    });
    await repository.git(["add", "-A", "attacker-payload.txt", "tracked.txt"], {
      environmentOverrides: attackerEnvironment,
    });
    const attackerTree: string = await repository.git(["write-tree"], {
      environmentOverrides: attackerEnvironment,
    });
    const attackerCommit: string = await repository.git([
      "commit-tree",
      attackerTree,
      "-p",
      captured.baseCommit,
      "-m",
      "attacker",
    ]);
    await repository.git(["update-ref", `refs/replace/${captured.snapshotCommit}`, attackerCommit]);

    // IN-CASE NEGATIVE CONTROL, run before the assertion it licenses: unpinned,
    // git really does hand back the attacker's tree for the frozen snapshot OID.
    // Without this the case could pass against a git that ignored replace refs.
    expect(
      await repository.git(["ls-tree", "-r", "--name-only", captured.snapshotCommit]),
    ).toContain("attacker-payload.txt");
    expect(
      await repository.git([
        "-c",
        "core.useReplaceRefs=false",
        "ls-tree",
        "-r",
        "--name-only",
        captured.snapshotCommit,
      ]),
    ).not.toContain("attacker-payload.txt");

    const target: TurnSnapshotRestoreTarget = expectResolved(
      await service.resolveRestoreTarget(buildResolveInput()),
    );
    const restored: TurnSnapshotRestored = expectRestored(await service.restoreToTurn(target));

    // Freezing the OID was never sufficient: without the pin this restore reports
    // SUCCESS having written a tree nobody verified. Pinned, the snapshot's own
    // bytes come back and the attacker's payload is treated as post-boundary
    // untracked content — deleted, not restored.
    expect(restored.ref).toBe(captured.ref);
    expect(readFileSync(join(repository.root, "tracked.txt"))).toEqual(snapshotBytes);
    expect(existsSync(join(repository.root, "attacker-payload.txt"))).toBe(false);
  });

  it("preserves a SKIPPED embedded repository through the restore while deleting a turn-created one", async () => {
    const repository: FixtureRepository = fixture.repository;
    applyTurnEffects();
    // The mixed-format skip class: both repositories healthy, object formats
    // simply differ, so the capture cannot record a gitlink for it.
    await createEmbeddedRepositoryWithObjectFormat(repository, "nested", "sha256");
    const service: TurnSnapshotService = buildService();
    const captured: TurnSnapshotCaptured = await captureTurn(service);
    expect(captured.skippedEmbeddedRepositories).toEqual(["nested"]);
    const innerBytes: Buffer = readFileSync(join(repository.root, "nested", "inner.txt"));
    const innerHead: string = await repository.git(["rev-parse", "HEAD"], {
      cwd: join(repository.root, "nested"),
    });

    // A SECOND embedded repository, created after the boundary — the control that
    // makes this a statement about the trailer rather than about the delete pass
    // having gone inert on nested repositories generally.
    await createEmbeddedRepository("created-after-the-boundary");
    repository.write("post-snapshot.txt", "arrived after the boundary\n");

    const target: TurnSnapshotRestoreTarget = expectResolved(
      await service.resolveRestoreTarget(buildResolveInput()),
    );
    const restored: TurnSnapshotRestored = expectRestored(await service.restoreToTurn(target));

    // SURVIVES, and survives WHOLE: the delete pass listed `nested/` exactly as it
    // lists any untracked directory, and the recursive removal would have taken
    // `.git` and the only copy of its history with it. The capture's trailer is
    // the only thing that distinguishes this path from the one below.
    expect(existsSync(join(repository.root, "nested", ".git"))).toBe(true);
    expect(readFileSync(join(repository.root, "nested", "inner.txt"))).toEqual(innerBytes);
    expect(
      await repository.git(["rev-parse", "HEAD"], { cwd: join(repository.root, "nested") }),
    ).toBe(innerHead);
    // …while a nested repository the TURN created is still deleted, as it must be.
    expect(existsSync(join(repository.root, "created-after-the-boundary"))).toBe(false);
    expect(existsSync(join(repository.root, "post-snapshot.txt"))).toBe(false);
    expect(restored.outcome).toBe("restored");

    // Reported, not silent: a daemon that declines to delete something owes an
    // operator the list, and this is the restore-side mirror of the capture's
    // skip enumeration.
    expect(fixture.diagnostics).toEqual([
      {
        kind: "embedded-repositories-skipped",
        runId: RUN_ID,
        epoch: 0,
        turnOrdinal: 1,
        ref: captured.ref,
        skippedPaths: ["nested"],
      },
      {
        kind: "embedded-repositories-preserved",
        runId: RUN_ID,
        epoch: 0,
        turnOrdinal: 1,
        ref: captured.ref,
        preservedPaths: ["nested"],
      },
    ]);
  });

  it("preserves a COMMITLESS skipped repository through the restore, payload included", async () => {
    const repository: FixtureRepository = fixture.repository;
    applyTurnEffects();
    // The other skip class, and the one `Spec-010 §Turn-Boundary Snapshots` names
    // by hand: an unborn `HEAD` has no commit id to record as a gitlink.
    await createCommitlessEmbeddedRepository("unborn");
    writeFileSync(join(repository.root, "unborn", "work-in-progress.txt"), "not yet committed\n");
    const service: TurnSnapshotService = buildService();
    const captured: TurnSnapshotCaptured = await captureTurn(service);
    expect(captured.skippedEmbeddedRepositories).toEqual(["unborn"]);

    const target: TurnSnapshotRestoreTarget = expectResolved(
      await service.resolveRestoreTarget(buildResolveInput()),
    );
    expectRestored(await service.restoreToTurn(target));

    // Same protection, same reason: the snapshot has no entry at this path, so
    // without the trailer the pass deletes an entire repository — here one whose
    // content was never committed anywhere and is therefore unrecoverable.
    expect(existsSync(join(repository.root, "unborn", ".git"))).toBe(true);
    expect(readFileSync(join(repository.root, "unborn", "work-in-progress.txt"), "utf8")).toBe(
      "not yet committed\n",
    );
  });

  it("reaches a fixpoint with protected paths present, deleting the rest", async () => {
    const repository: FixtureRepository = fixture.repository;
    applyTurnEffects();
    await createCommitlessEmbeddedRepository("unborn");
    const service: TurnSnapshotService = buildService();
    await captureTurn(service);
    repository.write("post-snapshot.txt", "arrived after the boundary\n");

    let untrackedListings = 0;
    const countingRunner: TurnSnapshotGitRunner = async (argv, options) => {
      if (argv.includes("ls-files") && argv.includes("-o") && !argv.includes("-i")) {
        untrackedListings += 1;
      }
      return runTurnSnapshotGitWithExecFile(argv, options);
    };
    const target: TurnSnapshotRestoreTarget = expectResolved(
      await service.resolveRestoreTarget(buildResolveInput()),
    );
    expectRestored(await buildService({ git: countingRunner }).restoreToTurn(target));

    // THE INTERLOCK. A protected path is listed on every pass forever, so both
    // termination checks had to move to the DELETABLE subset: against the raw
    // listing the empty check could never fire, and the byte-equality check would
    // report "made no progress" the instant the real work finished — failing a
    // correct restore purely for having protected something.
    //
    // One deleting pass plus the confirming pass that finds nothing deletable.
    expect(untrackedListings).toBe(2);
    expect(existsSync(join(repository.root, "post-snapshot.txt"))).toBe(false);
    expect(existsSync(join(repository.root, "unborn", ".git"))).toBe(true);
  });

  it("converges immediately when the only untracked content is protected", async () => {
    const repository: FixtureRepository = fixture.repository;
    applyTurnEffects();
    await createCommitlessEmbeddedRepository("unborn");
    const service: TurnSnapshotService = buildService();
    await captureTurn(service);

    let untrackedListings = 0;
    const countingRunner: TurnSnapshotGitRunner = async (argv, options) => {
      if (argv.includes("ls-files") && argv.includes("-o") && !argv.includes("-i")) {
        untrackedListings += 1;
      }
      return runTurnSnapshotGitWithExecFile(argv, options);
    };
    const target: TurnSnapshotRestoreTarget = expectResolved(
      await service.resolveRestoreTarget(buildResolveInput()),
    );
    expectRestored(await buildService({ git: countingRunner }).restoreToTurn(target));

    // The degenerate case the interlock has to get right: nothing deletable at
    // all. One listing, no deletions, no second pass — and emphatically not a
    // "made no progress" failure, which is what a raw-listing comparison would
    // have produced on the second pass.
    expect(untrackedListings).toBe(1);
    expect(existsSync(join(repository.root, "unborn", ".git"))).toBe(true);
  });

  it("refuses the restore, pre-mutation, when the skip trailer cannot be decoded", async () => {
    const repository: FixtureRepository = fixture.repository;
    applyTurnEffects();
    await createCommitlessEmbeddedRepository("unborn");
    const service: TurnSnapshotService = buildService();
    const captured: TurnSnapshotCaptured = await captureTurn(service);

    // A snapshot commit whose trailer is present and undecodable, planted over
    // the captured one. The service must not read this as "nothing was skipped".
    const snapshotTree: string = await repository.git([
      "rev-parse",
      `${captured.snapshotCommit}^{tree}`,
    ]);
    const corrupted: string = await repository.git([
      "commit-tree",
      snapshotTree,
      "-p",
      captured.baseCommit,
      "-m",
      "sidekicks: turn-boundary snapshot",
      "-m",
      "Skipped-Embedded-Repositories: [not json",
    ]);
    await repository.git(["update-ref", captured.ref, corrupted]);
    repository.write("post-snapshot.txt", "arrived after the boundary\n");
    const censusBefore: string = collectWorktreeCensus(repository.root);

    const target: TurnSnapshotRestoreTarget = expectResolved(
      await service.resolveRestoreTarget(buildResolveInput()),
    );
    const result: TurnSnapshotPartialRestore = expectPartialRestore(
      await service.restoreToTurn(target),
    );

    // FAIL-CLOSED. Returning an empty list for an undecodable trailer would be the
    // tolerant reading and is exactly backwards: this list is the delete pass's
    // do-not-delete set, so "empty" is not a neutral default but full authority to
    // destroy the repositories the trailer exists to protect.
    expect(result.failedStep).toBe("derive-enumerations" satisfies TurnSnapshotRestoreStep);
    expect(fixture.diagnostics.at(-1)).toMatchObject({
      kind: "restore-failed",
      failedStep: "derive-enumerations",
      detail: expect.stringContaining("could not decode") as unknown as string,
    });
    // Pre-mutation, so the refusal costs nothing: the worktree is untouched and the
    // protected repository is still there.
    expect(collectWorktreeCensus(repository.root)).toBe(censusBefore);
    expect(existsSync(join(repository.root, "unborn", ".git"))).toBe(true);
    expect(existsSync(join(repository.root, "post-snapshot.txt"))).toBe(true);
  });
});

// ----------------------------------------------------------------------------
// Retention harness (T5.3)
// ----------------------------------------------------------------------------
//
// A REAL migrated SQLite database, not a stubbed row source. The retention leg's
// whole content is a predicate over `run_execution_contexts` — `released_at`
// plus the window, and `git_common_dir` as the git dir — so a fake table would
// assert the predicate against the fake, including the mode-conditional CHECK
// that decides which companion rows a context legally has. Seeding through the
// real DDL is also what keeps the `worktree` / `ephemeral clone` cases honest:
// each one really does carry the root row its mode requires.

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
         id, session_id, node_id, local_path, canonical_root, state, attached_at, updated_at
       ) VALUES (@id, @session_id, 'node-1', @root, @root, 'attached', @now, @now)`,
    )
    .run({
      id: RETENTION_MOUNT_ID,
      session_id: RETENTION_SESSION_ID,
      root: fixture.repository.root,
      now: RETENTION_NOW,
    });
  database
    .prepare(
      `INSERT INTO workspaces (
         id, session_id, repo_mount_id, execution_mode, fs_root, state, created_at, updated_at
       ) VALUES (@id, @session_id, @repo_mount_id, 'worktree', @root, 'ready', @now, @now)`,
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
 * mode's CHECK requires (every writable mode carries a branch context; the
 * worktree and clone modes each carry their own root row).
 *
 * The companions are not decoration: the CHECK refuses a `worktree`-mode row
 * with a NULL `worktree_id`, so a fixture that skipped them could only have
 * seeded `read-only` rows — the one mode that never captures a snapshot at all,
 * and therefore the one mode in which every retention assertion would be vacuous.
 */
function insertRunExecutionContext(database: DatabaseType, seed: RunContextSeed): void {
  let worktreeId: string | null = null;
  let ephemeralCloneId: string | null = null;

  if (seed.executionMode === "worktree") {
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

  if (seed.executionMode === "ephemeral clone") {
    ephemeralCloneId = `clone-${seed.runId}`;
    database
      .prepare(
        `INSERT INTO ephemeral_clones (
           id, workspace_id, clone_root, branch_name, expires_at, created_at, updated_at
         ) VALUES (@id, @workspace_id, @root, @branch, @expires_at, @now, @now)`,
      )
      .run({
        id: ephemeralCloneId,
        workspace_id: RETENTION_WORKSPACE_ID,
        root: seed.executionRoot,
        branch: `feature/${seed.runId}`,
        expires_at: RETENTION_NOW,
        now: RETENTION_NOW,
      });
  }

  // `read-only` is the one mode whose CHECK requires all three companion ids
  // NULL — it carries no branch context at all, which is also why it can never
  // have captured a snapshot.
  let branchContextId: string | null = null;
  if (seed.executionMode !== "read-only") {
    branchContextId = `branch-context-${seed.runId}`;
    database
      .prepare(
        `INSERT INTO branch_contexts (
           id, workspace_id, worktree_id, ephemeral_clone_id,
           base_branch, head_branch, created_at, updated_at
         ) VALUES (@id, @workspace_id, @worktree_id, @clone_id, 'main', @head, @now, @now)`,
      )
      .run({
        id: branchContextId,
        workspace_id: RETENTION_WORKSPACE_ID,
        worktree_id: worktreeId,
        clone_id: ephemeralCloneId,
        head: `feature/${seed.runId}`,
        now: RETENTION_NOW,
      });
  }

  database
    .prepare(
      `INSERT INTO run_execution_contexts (
         run_id, session_id, workspace_id, execution_mode, execution_root, git_common_dir,
         worktree_id, ephemeral_clone_id, branch_context_id, created_at, released_at
       ) VALUES (
         @run_id, @session_id, @workspace_id, @execution_mode, @execution_root, @git_common_dir,
         @worktree_id, @clone_id, @branch_context_id, @now, @released_at
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
      clone_id: ephemeralCloneId,
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

/**
 * Poll `condition` until it holds, or fail the case naming what never happened.
 *
 * The sweeper's passes are ASYNC and non-blocking by contract — registration
 * returns before the startup reconcile has finished, and a tick returns before
 * its pass has — so a case that drives the seam can only observe the effect,
 * never await the promise. A fixed number of `setImmediate` turns would encode a
 * guess about how many awaits a pass takes; this encodes only that it finishes.
 *
 * `setTimeout` is REAL here: the seam cases fake `setInterval`/`clearInterval`
 * and nothing else, precisely so real work can still make progress.
 */
async function waitUntilSettled(
  condition: () => Promise<boolean>,
  description: string,
): Promise<void> {
  const deadline: number = Date.now() + FIXTURE_GIT_TIMEOUT_MS;
  for (;;) {
    if (await condition()) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`waitUntilSettled: timed out waiting for ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
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
      executionMode: "worktree",
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
      executionMode: "worktree",
      executionRoot: repository.root,
      gitCommonDir: canonicalGitDirectory(),
      releasedAt: RELEASED_LONG_AGO,
    });
    // `released_at IS NULL` — the run has not reached terminal at all. Age is
    // irrelevant to it, which is what the NULL arm of the predicate means.
    insertRunExecutionContext(database, {
      runId: SIBLING_RUN_ID,
      executionMode: "worktree",
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
      executionMode: "worktree",
      executionRoot: repository.root,
      gitCommonDir: canonicalGitDirectory(),
      // EXACTLY at the cutoff — the predicate is `<=`, so this one goes.
      releasedAt: new Date(cutoffMs).toISOString(),
    });
    insertRunExecutionContext(database, {
      runId: SIBLING_RUN_ID,
      executionMode: "worktree",
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

  it("deletes only the named run's namespace — heads and a sibling run survive (I-010-21)", async () => {
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
      executionMode: "worktree",
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

  it("deletes a SYMBOLIC ref planted in the run namespace, never its target branch (I-010-21)", async () => {
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
      executionMode: "worktree",
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

  it("refuses a namespace-escaping run id from the SWEEP before any git call (I-010-21)", async () => {
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
      executionMode: "worktree",
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
        disposedCloneCount: 0,
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
      executionMode: "branch",
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
        executionMode: "branch",
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

  it("drops a listing entry outside the run prefix instead of deleting it (I-010-21)", async () => {
    const repository: FixtureRepository = fixture.repository;
    const database: DatabaseType = openRetentionDatabase();
    const headCommit: string = await repository.git(["rev-parse", "HEAD"]);
    const deletions: string[][] = [];

    // An I-010-21 channel a validated `runId` cannot cover: git's own pattern
    // matching. The enumeration is FABRICATED to name a branch, which is what a
    // `for-each-ref` that matched more than it was asked for would look like from
    // this module's side. This case pins the PARSER — the entry never reaches an
    // argv — so it is not evidence about what `update-ref -d` does with an entry
    // that passes; the symref cases carry that.
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
      executionMode: "worktree",
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
      executionMode: "worktree",
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

    // What the T3.2 gate records at context creation, read the way it reads it —
    // not hardcoded, so the fixture cannot agree with the service by accident.
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
      executionMode: "worktree",
      executionRoot: worktreeRoot,
      gitCommonDir: recordedCommonDirectory,
      releasedAt: RELEASED_LONG_AGO,
    });

    // T2.2's physical retirement: the execution root is GONE while the window is
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
      executionMode: "worktree",
      executionRoot: removedRepositoryRoot,
      gitCommonDir: join(removedRepositoryRoot, ".git"),
      releasedAt: RELEASED_LONG_AGO,
    });
    insertRunExecutionContext(database, {
      runId: SIBLING_RUN_ID,
      executionMode: "worktree",
      executionRoot: repository.root,
      gitCommonDir: canonicalGitDirectory(),
      releasedAt: "2026-05-02T00:00:00.000Z",
    });

    const sweep: TurnSnapshotRetentionSweepResult = await service.sweepPrunableRuns();

    expect(sweep.examinedRunIds).toEqual([RUN_ID, SIBLING_RUN_ID]);
    expect(sweep.prunedRunIds).toEqual([SIBLING_RUN_ID]);
    expect(sweep.deletedRefs).toEqual([survivor.ref]);
    expect(sweep.skipped).toHaveLength(1);
    // ABSENT, not merely unusable: the mode is `worktree`, so nothing was
    // supposed to remove this store — which is the plan row's "the repo was
    // removed" case, and the one it requires enumerated in the diagnostic.
    expect(sweep.skipped[0]).toMatchObject({ runId: RUN_ID, reason: "git-dir-absent" });
    expect(sweep.skipped[0]?.detail).toContain("not a git repository");
    // Enumerated, never fatal — and enumerated ONCE for the whole pass.
    expect(fixture.diagnostics).toEqual([
      {
        kind: "retention-prune-skipped",
        examinedRunCount: 2,
        disposedCloneCount: 0,
        skipped: sweep.skipped,
      },
    ]);
    expect(await repository.refListing("refs/sidekicks/")).toBe("");
  });

  it("finds nothing to delete once an ephemeral clone has been disposed", async () => {
    const repository: FixtureRepository = fixture.repository;
    const database: DatabaseType = openRetentionDatabase();
    const service: TurnSnapshotService = buildRetentionService(database);
    const cloneRoot: string = join(fixture.fixtureRoot, "ephemeral-clone");
    await repository.git(["clone", "-q", repository.root, cloneRoot], {
      cwd: fixture.fixtureRoot,
    });
    const cloneGitDirectory: string = join(cloneRoot, ".git");
    writeFileSync(join(cloneRoot, "created-in-clone.txt"), "clone-side work\n");

    const captured = expectCaptured(
      await service.captureTurnSnapshot({
        ...CAPTURE_DEFAULTS,
        mode: "ephemeral clone",
        executionRoot: cloneRoot,
      }),
    );
    // NON-VACUITY, both directions: the refs really exist, and they exist in the
    // CLONE's own store — the canonical repository never held them, which is
    // what makes "the sweep found nothing" a statement about the disposal rather
    // than about an empty fixture.
    expect(
      await repository.git([
        "--git-dir",
        cloneGitDirectory,
        "for-each-ref",
        "--format=%(objectname) %(refname)",
        "refs/sidekicks/",
      ]),
    ).toBe(`${captured.snapshotCommit} ${captured.ref}`);
    expect(await repository.refListing("refs/sidekicks/")).toBe("");

    insertRunExecutionContext(database, {
      runId: RUN_ID,
      executionMode: "ephemeral clone",
      executionRoot: cloneRoot,
      gitCommonDir: cloneGitDirectory,
      releasedAt: RELEASED_LONG_AGO,
    });

    // `on_run_complete` disposal (T2.3) removes the clone root, and the snapshot
    // refs go with it: they lived in the clone's object store. Campaign B2's
    // ruling — the refs do not relocate, and a later rollback of this run is
    // conversation-only.
    rmSync(cloneRoot, { recursive: true, force: true });

    const sweep: TurnSnapshotRetentionSweepResult = await service.sweepPrunableRuns();

    expect(sweep.deletedRefs).toEqual([]);
    expect(sweep.prunedRunIds).toEqual([]);
    expect(sweep.skipped).toHaveLength(1);
    // Attributed to the DISPOSAL, by the mode plus the probe — not folded into
    // the fault arm a removed repository lands in.
    expect(sweep.skipped[0]).toMatchObject({ runId: RUN_ID, reason: "clone-disposed" });
    // And SILENT. This is the case that recurs by construction — every
    // clone-mode run the daemon ever executed reaches it, hourly, with nothing
    // memoizing it — so a pass whose only skips are disposals emits nothing at
    // all. The full skip is still on the result above.
    expect(fixture.diagnostics).toEqual([]);
    // Not a retention violation and not a fault in the canonical repository: it
    // is untouched, and it never had anything of this run's to lose.
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
      executionMode: "worktree",
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
      executionMode: "worktree",
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
    // The capture/restore wiring CP-010-12 describes: no database at all.
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
      executionMode: "branch",
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
      "turn-snapshot retention-prune-skipped: skipped=1 of examined=1 disposed-clones=0",
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
      executionMode: "worktree",
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

  it("never examines a read-only run — it cannot have captured a ref", async () => {
    const database: DatabaseType = openRetentionDatabase();
    const invocations: string[][] = [];
    const service: TurnSnapshotService = buildRetentionService(database, {
      git: buildRecordingRunner(invocations),
    });
    // Terminal, ancient, and in the one mode `SNAPSHOT_APPLICABLE_MODES`
    // excludes. Without the predicate's mode exclusion this is a `for-each-ref`
    // spawn per hour, forever, to enumerate nothing — and an inflated
    // `examinedRunCount`, the denominator an operator reads the skip list
    // against.
    insertRunExecutionContext(database, {
      runId: RUN_ID,
      executionMode: "read-only",
      executionRoot: fixture.repository.root,
      gitCommonDir: canonicalGitDirectory(),
      releasedAt: RELEASED_LONG_AGO,
    });

    const sweep: TurnSnapshotRetentionSweepResult = await service.sweepPrunableRuns();

    expect(sweep.examinedRunIds).toEqual([]);
    expect(invocations).toEqual([]);
    expect(fixture.diagnostics).toEqual([]);

    // The primitive is UNFILTERED by mode, deliberately — it is the unconditional
    // per-run op, and a read-only run reached that way enumerates nothing, which
    // is the honest answer rather than a refusal.
    const pruned: TurnSnapshotRetentionPruneResult = await service.pruneSnapshotsForRun(RUN_ID);
    expect(pruned).toEqual({ runId: RUN_ID, deletedRefs: [], skipped: null });
    expect(invocations).toHaveLength(1);
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
      // `ephemeral clone` MODE with a git dir that still exists: the mode alone
      // must not be enough to call this a disposal.
      executionMode: "ephemeral clone",
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
        disposedCloneCount: 0,
        skipped: sweep.skipped,
      },
    ]);
  });

  it("fails TOWARD the fault arm when the probe itself cannot answer", async () => {
    const database: DatabaseType = openRetentionDatabase();
    const service: TurnSnapshotService = buildRetentionService(database);
    // A path component past the OS limit: `stat` rejects with `ENAMETOOLONG`,
    // not `ENOENT`. The distinction is the point — a probe that treated every
    // error as absence would call this a disposal and go silent, which is
    // exactly how a live `EACCES` on a real store would be lost. Only a PROVABLE
    // absence is an absence.
    const unprobeableGitDirectory: string = join(fixture.fixtureRoot, "x".repeat(300), ".git");
    insertRunExecutionContext(database, {
      runId: RUN_ID,
      // The mode that would otherwise earn the silent `clone-disposed` arm.
      executionMode: "ephemeral clone",
      executionRoot: join(fixture.fixtureRoot, "x".repeat(300)),
      gitCommonDir: unprobeableGitDirectory,
      releasedAt: RELEASED_LONG_AGO,
    });

    const sweep: TurnSnapshotRetentionSweepResult = await service.sweepPrunableRuns();

    expect(sweep.skipped).toHaveLength(1);
    expect(sweep.skipped[0]).toMatchObject({ runId: RUN_ID, reason: "git-dir-unusable" });
    expect(fixture.diagnostics).toHaveLength(1);
  });

  it("counts disposed clones beside the actionable skips rather than enumerating them", async () => {
    const database: DatabaseType = openRetentionDatabase();
    const service: TurnSnapshotService = buildRetentionService(database);
    const disposedCloneRoot: string = join(fixture.fixtureRoot, "already-disposed-clone");
    // A disposed clone AND a removed repository in the same pass. The pass has
    // something to say, so it speaks — and what it enumerates is the removal,
    // with the disposal reduced to the count it is.
    insertRunExecutionContext(database, {
      runId: RUN_ID,
      executionMode: "ephemeral clone",
      executionRoot: disposedCloneRoot,
      gitCommonDir: join(disposedCloneRoot, ".git"),
      releasedAt: RELEASED_LONG_AGO,
    });
    insertRunExecutionContext(database, {
      runId: SIBLING_RUN_ID,
      executionMode: "worktree",
      executionRoot: join(fixture.fixtureRoot, "removed-repo"),
      gitCommonDir: join(fixture.fixtureRoot, "removed-repo", ".git"),
      releasedAt: "2026-05-02T00:00:00.000Z",
    });

    const sweep: TurnSnapshotRetentionSweepResult = await service.sweepPrunableRuns();

    // The RESULT keeps full fidelity — both skips, both reasons.
    expect(sweep.skipped.map((skip) => skip.reason)).toEqual(["clone-disposed", "git-dir-absent"]);
    expect(fixture.diagnostics).toEqual([
      {
        kind: "retention-prune-skipped",
        examinedRunCount: 2,
        disposedCloneCount: 1,
        skipped: [sweep.skipped[1]],
      },
    ]);
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
      executionMode: "worktree",
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
      executionMode: "worktree",
      executionRoot: repository.root,
      gitCommonDir: canonicalGitDirectory(),
      releasedAt: RELEASED_LONG_AGO,
    });
    insertRunExecutionContext(database, {
      runId: SIBLING_RUN_ID,
      executionMode: "worktree",
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

  it("applies a snapshot whose ref the prune deleted inside the resolve→restore window", async () => {
    const repository: FixtureRepository = fixture.repository;
    const database: DatabaseType = openRetentionDatabase();
    const service: TurnSnapshotService = buildRetentionService(database);
    applyTurnEffects();
    const captured: TurnSnapshotCaptured = await captureTurn(service);

    // The state the restore has to reproduce, taken AT the boundary.
    const censusAtCapture: string = collectWorktreeCensus(repository.root);
    const branchesAtCapture: string = await repository.refListing("refs/heads/");
    const headAtCapture: string = await repository.git(["rev-parse", "HEAD"]);
    applyPostSnapshotEffects();
    expect(collectWorktreeCensus(repository.root)).not.toBe(censusAtCapture);

    // Phase one of I-010-23, taken while the ref is still there.
    const target: TurnSnapshotRestoreTarget = expectResolved(
      await service.resolveRestoreTarget(buildResolveInput()),
    );

    // …and the retention leg then deletes that very ref inside the two-phase
    // window. This is the T5.2/T5.3 interleave neither task owns: the sweep
    // takes no lock against a rollback already in flight (the service header's
    // retention residuals record that), so the ordering is reachable and the
    // only open question is what it produces.
    insertRunExecutionContext(database, {
      runId: RUN_ID,
      executionMode: "worktree",
      executionRoot: repository.root,
      gitCommonDir: canonicalGitDirectory(),
      releasedAt: RELEASED_LONG_AGO,
    });
    const pruned: TurnSnapshotRetentionPruneResult = await service.pruneSnapshotsForRun(RUN_ID);
    expect(pruned.skipped).toBeNull();
    expect(pruned.deletedRefs).toEqual([captured.ref]);

    // The two halves the case turns on, asserted rather than assumed. The NAME
    // is really gone — without this the interleave never happened and every
    // assertion below passes for the wrong reason…
    expect(await repository.refListing("refs/sidekicks/")).toBe("");
    // …and the snapshot COMMIT is still in the object store, unreferenced until
    // a `gc` this service neither runs nor schedules.
    expect(await repository.git(["cat-file", "-t", captured.snapshotCommit])).toBe("commit");

    // The measured contract, and it is a SUCCESS. A snapshot's identity is its
    // OID; the ref is a name for it, and the RESOLVE is what establishes which
    // OID this `(run, epoch, turn)` means — frozen into the minted target. Every
    // leg downstream of the resolve names that OID (the derivation and the
    // destructive checkout alike), so deleting the name afterwards removes a
    // label, not the snapshot. Refusing instead would convert a
    // retention-bookkeeping event into a failed user rollback and report it
    // through `partial_restore` — an arm that would then be describing nothing
    // that happened.
    const restored: TurnSnapshotRestored = expectRestored(await service.restoreToTurn(target));
    expect(restored).toEqual({
      outcome: "restored",
      ref: captured.ref,
      snapshotCommit: captured.snapshotCommit,
      overwrittenIgnoredPaths: [],
      divergentGitlinks: [],
    });
    // "Never a wrong tree" as GROUND TRUTH rather than as an outcome tag: the
    // worktree is byte-identical to the capture boundary, not merely to
    // something, and nothing is staged.
    expect(collectWorktreeCensus(repository.root)).toBe(censusAtCapture);
    expect(await repository.git(["diff", "--cached", "--name-only"])).toBe("");
    // The restore writes no refs, so the prune's deletion still stands and
    // branch history is untouched on both sides of the interleave (I-010-21).
    expect(await repository.refListing("refs/sidekicks/")).toBe("");
    expect(await repository.refListing("refs/heads/")).toBe(branchesAtCapture);
    expect(await repository.git(["rev-parse", "HEAD"])).toBe(headAtCapture);
    expect(fixture.diagnostics).toEqual([]);

    // The OTHER side of the window, driven in the same already-pruned fixture: a
    // prune landing BEFORE the resolve refuses, because there is then no OID to
    // freeze. The header residual's two cases are exactly these, and they differ
    // only in which side of the resolve the deletion falls on.
    const censusBeforeRefusal: string = collectWorktreeCensus(repository.root);
    const indexBeforeRefusal: string = readIndexFingerprint(repository.root);
    expect(await service.resolveRestoreTarget(buildResolveInput())).toEqual({
      outcome: "no_snapshot",
      ref: captured.ref,
      owningEpoch: 0,
      reason: "ref-absent",
    });
    // And the refusal costs nothing, as every refusal arm must: worktree and
    // index byte-identical across it.
    expect(collectWorktreeCensus(repository.root)).toBe(censusBeforeRefusal);
    expect(readIndexFingerprint(repository.root)).toBe(indexBeforeRefusal);
  });
});

// ----------------------------------------------------------------------------
// The sanctioned bootstrap wiring seam (T5.3)
// ----------------------------------------------------------------------------
//
// Lives in THIS file rather than in `../../bootstrap/__tests__/`, because the
// seam is Plan-010's obligation inside a Plan-007-owned file — the wiring call
// is sanctioned, a test surface there is not. The first case drives the seam
// over the REAL service and a real database, which is what makes "startup
// reconciles and the interval fires the sweep" an end-to-end claim; the rest
// drive injected callables, because their subject is the seam's containment and
// lifecycle rather than the sweep.
//
// `setInterval` / `clearInterval` are the ONLY faked timers. `execFile`'s own
// timeout uses `setTimeout`, and faking that would freeze every real git
// invocation the first case depends on.

describe("registerTurnSnapshotRetentionSweep", () => {
  afterEach(() => {
    vi.useRealTimers();
    closeRetentionDatabase();
  });

  it("reconciles at startup and fires the sweep again on the cadence", async () => {
    const repository: FixtureRepository = fixture.repository;
    const database: DatabaseType = openRetentionDatabase();
    const service: TurnSnapshotService = buildRetentionService(database);
    applyTurnEffects();
    const downtimeRun = await captureTurn(service, { turnOrdinal: 1 });
    const laterRun = expectCaptured(
      await service.captureTurnSnapshot({
        ...CAPTURE_DEFAULTS,
        runId: SIBLING_RUN_ID,
        executionRoot: repository.root,
      }),
    );

    // The window closed while the daemon was DOWN — there is no terminal event
    // left to fire, which is exactly why retention is a sweep.
    insertRunExecutionContext(database, {
      runId: RUN_ID,
      executionMode: "worktree",
      executionRoot: repository.root,
      gitCommonDir: canonicalGitDirectory(),
      releasedAt: RELEASED_LONG_AGO,
    });

    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    // Through the REAL bootstrap call — the sanctioned wiring edit — rather than
    // through the registrar it wraps. Nothing here constructs the service: the
    // wiring does, from daemon config, which is the clause of the T5.3 row this
    // case is the evidence for.
    const handle = wireTurnSnapshotRetentionSweep({
      turnSnapshot: {
        executionRootsDirectory: fixture.executionRootsDirectory,
        database,
        now: (): string => RETENTION_NOW,
        emitDiagnostic: (diagnostic: TurnSnapshotDiagnostic): void => {
          fixture.diagnostics.push(diagnostic);
        },
      },
      sweepCadenceMs: DEFAULT_TURN_SNAPSHOT_SWEEP_CADENCE_MS,
    });

    // The startup reconcile — kicked off by registration, not by a tick, and
    // asserted on the REFS rather than on a spy, since the sweeper the wiring
    // built is not a thing this case holds. Awaited by polling because the pass
    // is deliberately async and non-blocking: registration returns before it.
    await waitUntilSettled(
      async (): Promise<boolean> =>
        (await repository.refListing("refs/sidekicks/")) ===
        `${laterRun.snapshotCommit} ${laterRun.ref}`,
      "the startup reconcile to prune the downtime run",
    );
    expect(await repository.refListing(`refs/sidekicks/runs/${RUN_ID}/`)).toBe("");
    expect(downtimeRun.ref).toContain(RUN_ID);

    // A second run reaches its terminal release while the daemon is UP, and its
    // window is already closed. Nothing calls the sweeper; the interval does.
    insertRunExecutionContext(database, {
      runId: SIBLING_RUN_ID,
      executionMode: "worktree",
      executionRoot: repository.root,
      gitCommonDir: canonicalGitDirectory(),
      releasedAt: RELEASED_LONG_AGO,
    });
    // The startup pass's `.finally` has to have run before a tick can start, or
    // the in-flight guard swallows it. Waiting on the EFFECT above already
    // implies it — the settling continuations are microtasks and the observation
    // is real I/O — but the drain says so rather than relying on it, so a future
    // await added to the sweep's tail cannot turn this into a flake.
    await new Promise((resolve) => setImmediate(resolve));
    vi.advanceTimersByTime(DEFAULT_TURN_SNAPSHOT_SWEEP_CADENCE_MS);

    await waitUntilSettled(
      async (): Promise<boolean> => (await repository.refListing("refs/sidekicks/")) === "",
      "the periodic sweep to prune the run released while the daemon was up",
    );
    handle.dispose();
    expect(fixture.diagnostics).toEqual([]);
  });

  it("refuses to wire a sweeper with no database, at the moment the mistake is made", () => {
    // The mis-wire the service itself can only report once an hour. The wiring
    // call knows at construction that a sweeper without a handle can do nothing
    // but complain, so it refuses there — the service's own optionality (a
    // turn-boundary service holds no handle, CP-010-12) is untouched.
    //
    // BOTH refusals are pinned here, and the `@ts-expect-error` is half the
    // assertion rather than a nuisance suppression: it fails the typecheck if the
    // parameter type stops rejecting a handle-less wiring, and the `toThrow`
    // fails if the runtime guard stops answering the untyped caller who gets past
    // it. Deleting either mechanism breaks this case.
    expect(() =>
      wireTurnSnapshotRetentionSweep({
        // @ts-expect-error - `database` is required on the wiring input
        turnSnapshot: { executionRootsDirectory: fixture.executionRootsDirectory },
      }),
    ).toThrow(TypeError);
    expect(() =>
      wireTurnSnapshotRetentionSweep({
        // @ts-expect-error - `database` is required on the wiring input
        turnSnapshot: { executionRootsDirectory: fixture.executionRootsDirectory },
      }),
    ).toThrow(/needs an open `database`/);
  });

  it("passes the daemon-config window and cadence through to what it constructs", async () => {
    const repository: FixtureRepository = fixture.repository;
    const database: DatabaseType = openRetentionDatabase();
    applyTurnEffects();
    const captured = await captureTurn(buildRetentionService(database));
    const windowMs = 60_000;
    const cutoffMs: number = Date.parse(RETENTION_NOW) - windowMs;
    // Older than the ONE-MINUTE window, far younger than the seven-day default:
    // a wiring that dropped the configured window on the floor would retain this
    // run and the assertion below would fail.
    const releasedAt: string = new Date(cutoffMs - 1_000).toISOString();
    insertRunExecutionContext(database, {
      runId: RUN_ID,
      executionMode: "worktree",
      executionRoot: repository.root,
      gitCommonDir: canonicalGitDirectory(),
      releasedAt,
    });
    // The non-vacuity guard, computed from the timestamp this case ACTUALLY
    // seeds: age it past the default and the case would still pass while proving
    // nothing about the configured window, which is the whole regression this
    // guard exists to catch.
    expect(Date.parse(RETENTION_NOW) - Date.parse(releasedAt)).toBeLessThan(
      DEFAULT_TURN_SNAPSHOT_RETENTION_WINDOW_MS,
    );
    // And the refs are really there to lose before the sweep runs.
    expect(await repository.refListing("refs/sidekicks/")).toBe(
      `${captured.snapshotCommit} ${captured.ref}`,
    );

    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const handle = wireTurnSnapshotRetentionSweep({
      turnSnapshot: {
        executionRootsDirectory: fixture.executionRootsDirectory,
        database,
        retentionWindowMs: windowMs,
        now: (): string => RETENTION_NOW,
      },
      // And the cadence: one tick of it must fire a second pass.
      sweepCadenceMs: 1_000,
    });

    await waitUntilSettled(
      async (): Promise<boolean> => (await repository.refListing("refs/sidekicks/")) === "",
      "the configured window to make the run a candidate",
    );

    // A second run, and only the CADENCE can prune it — nothing else ticks.
    const second = expectCaptured(
      await buildRetentionService(database).captureTurnSnapshot({
        ...CAPTURE_DEFAULTS,
        runId: SIBLING_RUN_ID,
        executionRoot: repository.root,
      }),
    );
    insertRunExecutionContext(database, {
      runId: SIBLING_RUN_ID,
      executionMode: "worktree",
      executionRoot: repository.root,
      gitCommonDir: canonicalGitDirectory(),
      releasedAt: new Date(cutoffMs - 1_000).toISOString(),
    });
    expect(await repository.refListing("refs/sidekicks/")).toBe(
      `${second.snapshotCommit} ${second.ref}`,
    );
    // See the sibling case: the first pass must have settled before a tick can
    // start, and this drain is what makes that a fact rather than a timing bet.
    await new Promise((resolve) => setImmediate(resolve));
    vi.advanceTimersByTime(1_000);

    await waitUntilSettled(
      async (): Promise<boolean> => (await repository.refListing("refs/sidekicks/")) === "",
      "the configured cadence to fire a second pass",
    );
    handle.dispose();
  });

  it("stops firing once the handle is disposed, and disposes idempotently", async () => {
    let sweepCount = 0;
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const handle = registerTurnSnapshotRetentionSweep({
      runRetentionSweep: (): Promise<void> => {
        sweepCount += 1;
        return Promise.resolve();
      },
      sweepCadenceMs: 1_000,
    });

    // One tick at a time with a macrotask boundary between, because the
    // in-flight flag is cleared in the sweep promise's `.finally` — a MICROTASK,
    // which a synchronous `advanceTimersByTime(3_000)` never lets run. Three
    // fake seconds elapsing inside one synchronous statement is not a thing a
    // daemon does; an hour of real time between ticks is.
    for (let tick = 0; tick < 3; tick += 1) {
      await new Promise((resolve) => setImmediate(resolve));
      vi.advanceTimersByTime(1_000);
    }
    expect(sweepCount).toBe(4); // the startup reconcile plus three ticks

    handle.dispose();
    handle.dispose();
    for (let tick = 0; tick < 10; tick += 1) {
      await new Promise((resolve) => setImmediate(resolve));
      vi.advanceTimersByTime(1_000);
    }

    expect(sweepCount).toBe(4);
  });

  it("contains a rejecting sweeper and reports it instead of taking the daemon down", async () => {
    const failures: unknown[] = [];
    const rejection = new Error("candidate read exploded");
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const handle = registerTurnSnapshotRetentionSweep({
      // The seam does not assume its sweeper honours the never-rejects posture:
      // a rejection here has NOBODY awaiting it, and Node's default
      // `--unhandled-rejections=throw` would end the process.
      runRetentionSweep: (): Promise<never> => Promise.reject(rejection),
      sweepCadenceMs: 1_000,
      reportSweepFailure: (reason: unknown): void => {
        failures.push(reason);
      },
    });

    await new Promise((resolve) => setImmediate(resolve));
    vi.advanceTimersByTime(1_000);
    await new Promise((resolve) => setImmediate(resolve));
    handle.dispose();

    expect(failures).toEqual([rejection, rejection]);
  });

  it("contains the missing-database defect on the .catch path and a sync throw on the other", async () => {
    const failures: unknown[] = [];
    // The real wiring defect in its real shape: a service constructed without a
    // `database`, handed to the seam by a composition root that forgot one.
    // `sweepPrunableRuns` is `async`, so its `TypeError` is always a REJECTION —
    // it arrives through `.catch`, never through the synchronous guard. Which
    // arm catches which is asserted here rather than assumed, because the
    // dangerous misreading is the one that concludes the `.catch` is redundant.
    const misWiredService: TurnSnapshotService = buildService();
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const handle = registerTurnSnapshotRetentionSweep({
      runRetentionSweep: (): Promise<unknown> => misWiredService.sweepPrunableRuns(),
      sweepCadenceMs: 1_000,
      reportSweepFailure: (reason: unknown): void => {
        failures.push(reason);
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    handle.dispose();

    expect(failures).toHaveLength(1);
    expect(failures[0]).toBeInstanceOf(TypeError);
    expect(String(failures[0])).toContain("retention leg needs a `database` dependency");

    // And the OTHER guard, for the other arrival path: a NON-`async` sweeper
    // that throws before returning a promise at all, which no `.catch` can ever
    // see because there is no promise to attach one to. Both guards exist
    // because these are two paths, not one.
    failures.length = 0;
    const thrown = new Error("thrown before any promise existed");
    const throwingHandle = registerTurnSnapshotRetentionSweep({
      runRetentionSweep: (): Promise<unknown> => {
        throw thrown;
      },
      sweepCadenceMs: 1_000,
      reportSweepFailure: (reason: unknown): void => {
        failures.push(reason);
      },
    });
    throwingHandle.dispose();

    expect(failures).toEqual([thrown]);
  });

  it("skips a tick while a sweep is still in flight", async () => {
    let sweepStarts = 0;
    let releaseSweep: () => void = () => {
      throw new Error("the sweeper was never started");
    };
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const handle = registerTurnSnapshotRetentionSweep({
      runRetentionSweep: (): Promise<void> =>
        new Promise<void>((resolve) => {
          sweepStarts += 1;
          releaseSweep = resolve;
        }),
      sweepCadenceMs: 1_000,
    });

    expect(sweepStarts).toBe(1);
    // Three ticks pass while the first sweep is still running. Without the
    // in-flight guard these would be three CONCURRENT passes racing each other's
    // deletions, and a daemon whose sweep is slower than its cadence would pile
    // them up without bound.
    vi.advanceTimersByTime(3_000);
    expect(sweepStarts).toBe(1);

    releaseSweep();
    await new Promise((resolve) => setImmediate(resolve));
    vi.advanceTimersByTime(1_000);

    expect(sweepStarts).toBe(2);
    handle.dispose();
  });

  it("refuses every cadence the platform's timers would silently reinterpret", () => {
    const runRetentionSweep = (): Promise<void> => Promise.resolve();
    for (const sweepCadenceMs of [
      0,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      // ABOVE the 32-bit ceiling. A plausible monthly cadence written as
      // `DEFAULT_TURN_SNAPSHOT_RETENTION_WINDOW_MS * 4` is 2_419_200_000 —
      // positive and finite, and coerced to 1 ms all the same.
      2_147_483_648,
      DEFAULT_TURN_SNAPSHOT_RETENTION_WINDOW_MS * 4,
      // And BELOW 1, which is the same coercion from the other end.
      0.5,
    ]) {
      // `setInterval` silently coerces every one of these to a 1 ms interval,
      // which turns a configuration typo into a daemon spawning git in a hot
      // loop. Refused rather than normalized.
      expect(() =>
        registerTurnSnapshotRetentionSweep({ runRetentionSweep, sweepCadenceMs }),
      ).toThrow(RangeError);
    }
    // The ceiling itself is ACCEPTED — the boundary is inclusive, so the refusal
    // is a statement about the coercion and not an off-by-one.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    registerTurnSnapshotRetentionSweep({
      runRetentionSweep,
      sweepCadenceMs: 2_147_483_647,
    }).dispose();
  });

  it("takes the exported cadence default when the daemon configures none", async () => {
    let sweepCount = 0;
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    // An ABSENT cadence is config, not a refusal: the default is Plan-010's, the
    // same way the retention window's is.
    const handle = registerTurnSnapshotRetentionSweep({
      runRetentionSweep: (): Promise<void> => {
        sweepCount += 1;
        return Promise.resolve();
      },
    });

    expect(sweepCount).toBe(1);
    // The startup pass has to SETTLE before a tick can start — the in-flight
    // flag clears in a `.finally`, a microtask no synchronous timer advance lets
    // run. An hour of real time between ticks makes that boundary a non-issue;
    // an hour of fake time inside one statement does not.
    await new Promise((resolve) => setImmediate(resolve));
    vi.advanceTimersByTime(DEFAULT_TURN_SNAPSHOT_SWEEP_CADENCE_MS - 1);
    expect(sweepCount).toBe(1);
    vi.advanceTimersByTime(1);
    expect(sweepCount).toBe(2);
    handle.dispose();
  });

  it("returns normally when the failure REPORTER itself throws", async () => {
    const reported: unknown[] = [];
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    // The reporter runs from inside a `.catch`, so its own throw would reject
    // the promise that handler settles — with no further handler attached. That
    // is the unhandled rejection the whole wrapper exists to prevent, arriving
    // by the one path a `try` around the sweep would miss.
    const handle = registerTurnSnapshotRetentionSweep({
      runRetentionSweep: (): Promise<never> => Promise.reject(new Error("pass failed")),
      sweepCadenceMs: 1_000,
      reportSweepFailure: (reason: unknown): never => {
        reported.push(reason);
        throw new Error("the reporter is broken too");
      },
    });

    await new Promise((resolve) => setImmediate(resolve));
    // The reporter really ran and really threw, and the tick that follows still
    // starts: a swallowed reporter throw must not wedge the in-flight flag.
    expect(reported).toHaveLength(1);
    vi.advanceTimersByTime(1_000);
    await new Promise((resolve) => setImmediate(resolve));
    expect(reported).toHaveLength(2);
    handle.dispose();
  });

  it("contains the rejection when the failure reporter is ASYNC", async () => {
    const reported: unknown[] = [];
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    // No cast: an `async` function IS assignable to the seam's
    // `(reason: unknown) => void`, and that is the whole hazard. The case above
    // throws where this one REJECTS — the surrounding `try` sees the first and
    // cannot see the second, so a reporter wired to an exporter with a transient
    // failure raises a rejection nobody holds, from inside the `.catch` this
    // wrapper attaches, under Node's default `--unhandled-rejections=throw`.
    const handle = registerTurnSnapshotRetentionSweep({
      runRetentionSweep: (): Promise<never> => Promise.reject(new Error("pass failed")),
      sweepCadenceMs: 1_000,
      reportSweepFailure: (reason: unknown): Promise<never> => {
        reported.push(reason);
        return Promise.reject(new Error("the reporter is broken asynchronously"));
      },
    });

    // An escaped rejection is reported OUTSIDE any case and fails the run with a
    // non-zero exit — verified against a build with the `.catch` removed, the
    // same way the async diagnostic-sink case in this file was — so SURVIVING
    // the macrotasks below is the containment assertion. The counts only prove
    // it wasn't vacuous.
    await new Promise((resolve) => setImmediate(resolve));
    expect(reported).toHaveLength(1);
    vi.advanceTimersByTime(1_000);
    await new Promise((resolve) => setImmediate(resolve));
    // And the tick behind it still starts: containing a rejection must leave the
    // in-flight flag exactly where swallowing a throw leaves it.
    expect(reported).toHaveLength(2);
    handle.dispose();
  });

  it("lets a sweep already in flight settle after the handle is disposed", async () => {
    const failures: unknown[] = [];
    const rejection = new Error("the pass failed after disposal");
    let failSweep: () => void = () => {
      throw new Error("the sweeper was never started");
    };
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const handle = registerTurnSnapshotRetentionSweep({
      runRetentionSweep: (): Promise<void> =>
        new Promise<void>((_resolve, reject) => {
          failSweep = (): void => {
            reject(rejection);
          };
        }),
      sweepCadenceMs: 1_000,
      reportSweepFailure: (reason: unknown): void => {
        failures.push(reason);
      },
    });

    // Disposal stops the INTERVAL. It does not cancel a pass midway and it does
    // not detach the containment around one: the pass holds no resource this
    // handle owns, and an in-flight rejection arriving after shutdown is still a
    // rejection nobody else is holding.
    handle.dispose();
    failSweep();
    await new Promise((resolve) => setImmediate(resolve));

    expect(failures).toEqual([rejection]);
    // And the disposal really took: no further pass starts behind it.
    vi.advanceTimersByTime(5_000);
    await new Promise((resolve) => setImmediate(resolve));
    expect(failures).toEqual([rejection]);
  });

  it("exports a retention window and a sweep cadence as daemon-config defaults", () => {
    // Independently spelled, so a changed default is a decision somebody makes
    // rather than a number that drifted.
    expect(DEFAULT_TURN_SNAPSHOT_RETENTION_WINDOW_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(DEFAULT_TURN_SNAPSHOT_SWEEP_CADENCE_MS).toBe(60 * 60 * 1000);
    // The window must outlast the cadence, or no sweep could ever observe a run
    // inside its own window.
    expect(DEFAULT_TURN_SNAPSHOT_RETENTION_WINDOW_MS).toBeGreaterThan(
      DEFAULT_TURN_SNAPSHOT_SWEEP_CADENCE_MS,
    );
  });
});
