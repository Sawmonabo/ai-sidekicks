// Plan-010 Phase 5 — T5.1, the turn-snapshot CAPTURE leg.
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
//     the commitless embedded repository skipped and enumerated; ignore
//     semantics (project-declared rules only, tracking wins over ignoring); the
//     `core.autocrlf` / `core.attributesFile` / `i18n.commitEncoding` pins and
//     the `core.excludesFile` non-consultation that make the OID host-
//     independent; the create-only `update-ref` and its per-epoch idempotence;
//     the writable-modes-only applicability rule, exercised across ALL THREE
//     writable modes and the one non-applicable mode; and the out-of-worktree
//     scratch index, asserted against the execution root's OWN index rather than
//     only against stray worktree content.
//   * `Spec-004 §Required Behavior` — the execution epoch is the CALLER's value
//     (`0` before any rollback, advanced with each accepted `run.rolled_back`),
//     placed in the ref verbatim and never derived here (CP-010-12).
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
//   * I-010-22 — create-only, PER-EPOCH refs. The discriminating case mutates
//     the worktree between two captures of the same `(runId, epoch, turnOrdinal)`
//     and asserts the ref did not move, which is what "never repoints an existing
//     ref at later file state" means; the epoch case then asserts the superseded
//     epoch's ref SURVIVES beside the fresh one.
//
// Each host-config pin carries a NEGATIVE CONTROL in the same case: the fixture
// re-runs the equivalent leg WITHOUT the pin and the assertion is that the
// result differs. A stability assertion whose pin was already inert would
// otherwise pass for the wrong reason.

import { execFile } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ExecutionMode } from "@ai-sidekicks/contracts";

import {
  SNAPSHOT_NEUTRALIZED_GIT_ENV_KEYS,
  TurnSnapshotService,
  runTurnSnapshotGitWithExecFile,
  type TurnSnapshotCaptureResult,
  type TurnSnapshotCaptureStep,
  type TurnSnapshotDiagnostic,
  type TurnSnapshotFilesystem,
  type TurnSnapshotGitRunner,
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
 * This suite's INDEPENDENT spelling of the environment variables the service
 * strips, pinned to the service's exported list by set equality below.
 *
 * The first seven mirror `../workspace/repo-root-resolver.ts`'s discovery
 * redirectors, which the service's list imports rather than re-spells; they are
 * repeated here deliberately, because the claim under test is about the whole
 * set THIS module strips, not about how it was assembled. A key the resolver
 * adds therefore surfaces here as a census failure rather than as silently
 * widened behaviour nothing asserts.
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
  repository.write(".gitignore", "ignored-dir/\nignored-file.txt\ntracked-but-ignored.txt\n");
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

  it("mints a host-config-independent OID across autocrlf, commitEncoding and excludesFile", async () => {
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
    const recordingRunner: TurnSnapshotGitRunner = async (argv, options) => {
      invocations.push([...argv]);
      return runTurnSnapshotGitWithExecFile(argv, options);
    };

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
    const recordingRunner: TurnSnapshotGitRunner = async (argv, options) => {
      invocations.push([...argv]);
      return runTurnSnapshotGitWithExecFile(argv, options);
    };

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
    // The behavioural case below drives ONE variable. Set equality is what keeps
    // the other ten from going silently unasserted: a key added to the service's
    // list and to nothing else fails here, and a key dropped from it fails here
    // too. The two spellings stay independent, so neither side can drift alone.
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

  it("prepends the hook-neutralization flags to every invocation (D-010-10)", async () => {
    const repository: FixtureRepository = fixture.repository;
    applyTurnEffects();
    await createEmbeddedRepository("embedded");

    const invocations: string[][] = [];
    const recordingRunner: TurnSnapshotGitRunner = async (argv, options) => {
      invocations.push([...argv]);
      return runTurnSnapshotGitWithExecFile(argv, options);
    };

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
});
