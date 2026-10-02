// Turn snapshots over real git: a capture records exactly what `git add -A` would stage without
// touching the user's index, branches or hooks, and the prune deletes only the named run's
// snapshot refs. A case wraps the production git seam only to inject a fault or a race.

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
  buildFixtureEnvironment as buildHermeticFixtureEnvironment,
  FIXTURE_GIT_TIMEOUT_MS,
  spawnFixtureGit,
  type FixtureGitResult,
} from "../../workspace/__tests__/workspace.test-support.js";
import { runGitWithExecFile, type GitRunner } from "../git-process.js";
import { TurnSnapshotService } from "../turn-snapshot-service.js";
import {
  type TurnSnapshotCaptureResult,
  type TurnSnapshotCaptureStep,
  type TurnSnapshotCaptured,
  type TurnSnapshotDiagnostic,
  type TurnSnapshotFilesystem,
  type TurnSnapshotRetentionPruneResult,
} from "../turn-snapshot-types.js";

// ----------------------------------------------------------------------------
// Constants
// ----------------------------------------------------------------------------

// Run ids are UUIDs, which the ref-component validator admits. The ref assertions spell the
// resulting path literally rather than deriving it from the service, so a changed builder is
// caught.
const RUN_ID = "0192b3c0-1111-7c4a-9b1c-1b7c5b3e8f00";

// The turn-boundary instant the service stamps as author/committer date. Fixed because it is an
// OID input: two captures hash identically only if the clock is held.
const FIXED_INSTANT = "2026-01-01T00:00:00.000Z";

/** The base repository's committed ignore rules; a case that adds one extends these. */
const FIXTURE_IGNORE_RULES = "ignored-dir/\nignored-file.txt\ntracked-but-ignored.txt\n";

/**
 * Every case spawns git, and a contended host can push a sub-second case past Vitest's 5s default.
 * Larger than {@link FIXTURE_GIT_TIMEOUT_MS}, so a hung fixture spawn fails naming its leg.
 */
const ORDINARY_CASE_TIMEOUT_MS = 45_000;

vi.setConfig({ testTimeout: ORDINARY_CASE_TIMEOUT_MS });

/** For the cases that run several capture pipelines or build a second checkout. */
const MULTI_SEQUENCE_CASE_TIMEOUT_MS = 60_000;

// ----------------------------------------------------------------------------
// Real git, fixture side
// ----------------------------------------------------------------------------

interface FixtureGitOptions {
  readonly cwd?: string;
  readonly environmentOverrides?: Readonly<Record<string, string>>;
  /**
   * Written to the child's stdin, which is then closed. Needed for `update-index --index-info`,
   * the only way to write the stages of an unmerged path.
   */
  readonly stdin?: string;
}

/**
 * The hermetic fixture environment with fixed author and committer dates. The porcelain
 * `git add -A` legs are the reference the capture is compared against, and the negative controls
 * set host values repo-locally, so nothing else may supply them. The service, by contrast, runs
 * under the production environment (ambient `process.env` minus its own strip list), because its
 * immunity to host config is a claim about its `-c` pins.
 */
function buildFixtureEnvironment(fixtureRoot: string): NodeJS.ProcessEnv {
  return buildHermeticFixtureEnvironment(fixtureRoot, {
    GIT_AUTHOR_DATE: "1735689600 +0000",
    GIT_COMMITTER_DATE: "1735689600 +0000",
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

  /** The `<oid> <name>` line per ref matching `pattern` (every ref when omitted), sorted. */
  refListing(pattern?: string): Promise<string> {
    const argv: readonly string[] =
      pattern === undefined
        ? ["for-each-ref", "--format=%(objectname) %(refname)"]
        : ["for-each-ref", "--format=%(objectname) %(refname)", pattern];
    return this.git(argv);
  }

  /**
   * This repository's own index file, resolved through git rather than as `<root>/.git/index`: a
   * linked worktree's `.git` is a file and its index lives under `<main>/.git/worktrees/<id>/`.
   */
  async resolvedIndexPath(): Promise<string> {
    const reported: string = await this.git(["rev-parse", "--git-path", "index"]);
    return isAbsolute(reported) ? reported : join(this.root, reported);
  }

  /**
   * The tree porcelain `git add -A` would stage from the current worktree, the reference the
   * capture is measured against. Staged against a copy of the real index, so fixture state is
   * untouched and tracked deletions are visible.
   *
   * A non-zero `add -A` exit is tolerated only in a sparse root, where it exits 1 with advice
   * about out-of-cone paths it declined to update; the index it leaves is the reference wanted
   * (measured on git 2.50.1: byte-identical to staging only the in-cone listing). The scope is
   * read from `core.sparseCheckout`, not from the advice text, which may be worded differently
   * across git versions. Any other failure (a lock, a bad pathspec, an unwritable index) throws,
   * and `write-tree`'s status is always checked.
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

  // Published before the first fallible statement, so a setup that fails halfway still leaves
  // `afterEach` a root to remove instead of masking the real error and leaking the directory.
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
  // `-f`: the base commit must contain a file `.gitignore` matches, which `git add -A` skips.
  await repository.git(["add", "-f", "tracked-but-ignored.txt"]);
  await repository.git(["commit", "-q", "-m", "base"]);
});

afterEach(() => {
  // Ambient env stubs are per-case; unstubbed here too so a case cannot leak one into its
  // neighbors.
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(fixture.fixtureRoot, { recursive: true, force: true });
});

/** Seams a case replaces; everything unset stays at the production default. */
interface ServiceOverrides {
  readonly git?: GitRunner;
  readonly filesystem?: TurnSnapshotFilesystem;
  readonly now?: () => string;
  readonly emitDiagnostic?: (diagnostic: TurnSnapshotDiagnostic) => void;
  /** The prune only. The capture cases construct WITHOUT one. */
  readonly database?: DatabaseType;
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
  });
}

/**
 * The production filesystem seam with `removePath` replaced by a thrower. `createDirectory` stays
 * real so the capture runs end to end and the scratch index genuinely exists.
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
 * An untracked embedded git repository with a commit, at a chosen object format inside a chosen
 * parent. Returns its `HEAD`, whose hex length is what the mixed-format cases turn on.
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
 * An independent execution root at a chosen object format, with the harness's base commit shape.
 * The harness repository is SHA-1, so the SHA-256 superproject direction needs a second root;
 * capture takes its execution root per call.
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

    // The ref path is spelled literally (`refs/sidekicks/runs/<runId>/epoch-<E>/turn-<N>`), not
    // derived from the service, so a changed builder cannot agree with itself.
    expect(result.ref).toBe(`refs/sidekicks/runs/${RUN_ID}/epoch-0/turn-1`);
    expect(await repository.git(["rev-parse", result.ref])).toBe(result.snapshotCommit);

    // One base OID serves both legs: the recorded first parent and the reported `baseCommit` are
    // the value resolved at entry.
    expect(result.baseCommit).toBe(base);
    expect(await repository.git(["rev-parse", `${result.ref}^`])).toBe(base);
    expect(result.skippedEmbeddedRepositories).toEqual([]);

    // The fixed message is an OID input and carries no run id, epoch or ordinal; the ref carries
    // all three.
    expect(await repository.git(["log", "-1", "--format=%s", result.ref])).toBe(
      "sidekicks: turn-boundary snapshot",
    );
    // The daemon-owned identity at a fixed UTC offset: never the user's, never the host's
    // timezone.
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

    // The ref is where expected and nowhere else: the full listing is the pre-capture branches
    // plus the snapshot.
    expect(await repository.refListing("refs/heads/")).toBe(branchesBefore);
    expect(await repository.refListing()).toBe(
      `${branchesBefore}\n${result.snapshotCommit} ${result.ref}`,
    );

    // The load-bearing half: no branch contains the snapshot and `HEAD` did not move (neither its
    // symbolic target nor its commit), so branch history, PR preparation and diff attribution see
    // nothing.
    expect(await repository.git(["branch", "--contains", result.snapshotCommit])).toBe("");
    expect(await repository.git(["rev-parse", "HEAD"])).toBe(headBefore);
    expect(await repository.git(["symbolic-ref", "HEAD"])).toBe(symbolicHeadBefore);
    expect(await repository.git(["rev-list", "--count", "HEAD"])).toBe("1");
  });

  it("stages a tree byte-identical to `git add -A` under identical inputs", async () => {
    const repository: FixtureRepository = fixture.repository;
    applyTurnEffects();
    // An in-tree `.gitattributes` plus a path it converts. The pipeline pins
    // `core.attributesFile=/dev/null`, which neutralizes only the host's attributes; the project's
    // own still governs both legs, so equivalence must hold on a converted path.
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

    // The turn's edit, its deletion (the `--remove` half of staging) and its creations are all in.
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

    // The conversion fired: the blob is LF-normalized, so the equivalence above held on a path
    // both legs converted.
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

    // The bare pipeline would omit this repository: `ls-files -o` reports the single directory
    // entry `embedded/` and `update-index --add` drops it. The normalization pass restores it in
    // porcelain's representation.
    expect(await repository.git(["ls-tree", snapshotTree, "embedded"])).toBe(
      `160000 commit ${embeddedHead}\tembedded`,
    );
    expect(result.skippedEmbeddedRepositories).toEqual([]);

    // The `git add -A` equivalence holds here too, which is what the normalization preserves.
    expect(snapshotTree).toBe(
      await repository.porcelainAddAllTree(join(fixture.fixtureRoot, "porcelain.index")),
    );
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

    // Skipped and enumerated in the capture diagnostic; the result carries the same list for a
    // caller that does not subscribe.
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

    // Equivalence is not asserted here: porcelain hard-fails where capture skips, because capture
    // never blocks the turn. The control asserts the porcelain failure instead.
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
    // Both repositories are healthy; only their object formats differ.
    expect(await superproject.git(["rev-parse", "--show-object-format"])).toBe("sha256");
    expect(embeddedHead).toHaveLength(40);

    const result = expectCaptured(
      await buildService().captureTurnSnapshot({
        ...CAPTURE_DEFAULTS,
        executionRoot: superproject.root,
      }),
    );

    // A capture, not a failure. Unguarded, the `--cacheinfo` insert fails the whole
    // `normalize-embedded-repositories` step and every later rollback in the run resolves to
    // `no_snapshot`.
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
    // ...and the rest of the worktree is captured, so the skip is one path wide.
    expect(await superproject.git(["ls-tree", snapshotTree, "tracked.txt"])).toContain("blob");

    // Negative control: the insert the service now avoids refuses this OID, so the skip closes a
    // real failure.
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

  it("FAILS the capture when the embedded HEAD probe exits zero without an object id", async () => {
    const repository: FixtureRepository = fixture.repository;
    applyTurnEffects();
    // A healthy, recordable embedded repository. The two skip classes are unrecordable, so
    // skipping them loses nothing; this one is a `160000` gitlink the capture can record, so a
    // skip here would silently narrow the snapshot.
    await createEmbeddedRepository("embedded");
    const refsBefore: string = await repository.refListing();
    const embeddedRoot: string = join(repository.root, "embedded");

    // Exit zero with stdout that is not an object id, as bare `git rev-parse HEAD` does on a miss
    // (it echoes its argument). Keyed on the `-C` directory, not the subcommand, because the
    // capture's own base resolution runs the same `rev-parse --verify HEAD` against the execution
    // root.
    const echoingRunner: GitRunner = async (argv, options) => {
      if (argv.includes(embeddedRoot) && argv.includes("rev-parse")) {
        return { stdout: Buffer.from("HEAD\n"), stderr: "" };
      }
      return runGitWithExecFile(argv, options);
    };

    const result = await buildService({ git: echoingRunner }).captureTurnSnapshot({
      ...CAPTURE_DEFAULTS,
      executionRoot: repository.root,
    });

    // Refused through the capture funnel under its own step: never skipped, and never a throw,
    // since capture is not a turn gate.
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
    // The path was not enumerated as an unrecordable repository, which is what a swallow would
    // report.
    expect(
      fixture.diagnostics.some((diagnostic) => diagnostic.kind === "embedded-repositories-skipped"),
    ).toBe(false);
    // Nothing was published: the ref namespace and the scratch-index directory are as they were.
    expect(await repository.refListing()).toBe(refsBefore);
    expect(readdirSync(join(fixture.executionRootsDirectory, ".snapshot-indexes"))).toEqual([]);
  });

  it("writes a newline-bearing skipped path as one inert JSON line", async () => {
    const repository: FixtureRepository = fixture.repository;
    applyTurnEffects();
    // A path that, unencoded, would forge a second trailer naming a path the capture never
    // skipped, which on restore is authority to keep something the delete pass should remove.
    const hostilePath = 'ev\nSkipped-Embedded-Repositories: ["forged"]';
    await createCommitlessEmbeddedRepository(hostilePath);

    const captured: TurnSnapshotCaptured = await captureTurn(buildService());

    expect(captured.skippedEmbeddedRepositories).toEqual([hostilePath]);
    const message: string = await repository.git(["cat-file", "commit", captured.snapshotCommit]);
    // JSON-escaped: the newline is `\n` inside a string literal and the list is one physical line,
    // so the forged key never begins a line.
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

    // Ignore rules govern untracked files only.
    expect(entries).not.toContain("ignored-file.txt");
    expect(entries).not.toContain("ignored-dir/artifact.bin");
    // ...so a tracked file matching `.gitignore` is captured like any other.
    expect(entries).toContain("tracked-but-ignored.txt");
    // `.gitignore` itself is captured.
    expect(entries).toContain(".gitignore");
  });

  it(
    "mints a host-config-independent OID across autocrlf, commitEncoding and excludesFile",
    { timeout: MULTI_SEQUENCE_CASE_TIMEOUT_MS },
    async () => {
      const repository: FixtureRepository = fixture.repository;
      applyTurnEffects();
      // A CRLF worktree file gives `core.autocrlf` something to convert.
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
      // Negative control: unpinned staging under the same config re-hashes the CRLF bytes to LF
      // blobs and lands a different tree, so the pin is load-bearing.
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
      // Negative control and a reconstruction of the commit recipe: re-running `commit-tree` over
      // the same tree, parent, message and six-var ident/date set reproduces the service's OID
      // with the pin; without it the host encoding writes an `encoding` header and the OID moves.
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
      // A developer's private ignore patterns are not project declarations, so an untracked
      // project file matching one is still captured.
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
      // Negative control: porcelain consults the host excludes and omits the file, which is why
      // the recipe is plumbing with explicit exclusion flags rather than `git add -A`.
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

    // Attacker base: the real one minus a path that is both index-tracked and ignored. Only that
    // class survives the re-listing (`ls-files -o` never names an ignored path), so a seed that
    // drops it loses it from the snapshot silently.
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

    // Negative control, run first: an unpinned `read-tree` of the same base OID seeds from the
    // replacement and the path is gone, which proves the fixture is hostile.
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

    // Pinned, the capture seeds from the object it named, so the path stays in the snapshot and
    // the `add -A` equivalence holds despite the replace ref.
    const snapshotTree: string = await repository.git([
      "rev-parse",
      `${captured.snapshotCommit}^{tree}`,
    ]);
    expect(await repository.git(["ls-tree", snapshotTree, "tracked-but-ignored.txt"])).toContain(
      "blob",
    );
    // The parent recorded is the resolved id, not the substitute.
    expect(captured.baseCommit).toBe(baseCommit);
  });

  it("captures under a host `core.safecrlf` that would otherwise make staging FATAL", async () => {
    const repository: FixtureRepository = fixture.repository;
    const service: TurnSnapshotService = buildService();
    // The project's own attributes, checked in and honored. Without one, `core.safecrlf` converts
    // and refuses nothing.
    repository.write(".gitattributes", "*.txt text\n");
    await repository.git(["add", ".gitattributes"]);
    await repository.git(["commit", "-q", "-m", "in-tree attributes"]);
    await repository.git(["config", "core.safecrlf", "true"]);
    repository.write("crlf.txt", "line one\r\nline two\r\n");

    const captured: TurnSnapshotCaptured = await captureTurn(service);

    // Read back from git: the in-tree attribute still normalized the blob to LF and the worktree
    // keeps its CRLF bytes. The pin removes the host's veto, not the project's conversion.
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

    // Negative control: the same staging argv without `core.safecrlf=false` is fatal here, so the
    // capture above shows the pin working. It runs against a scratch index, leaving the
    // fixture's own untouched.
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
    // The one added pin closes it, so capture availability does not depend on host config.
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

    // The worktree moves on between the captures. Over unchanged content, a service that
    // repointed the ref would pass, since the new commit would hash identically.
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
    // Success, not a failure: nothing was diagnosed.
    expect(fixture.diagnostics).toEqual([]);
  });

  it("mints a fresh ref for the same turn ordinal under a new epoch", async () => {
    const repository: FixtureRepository = fixture.repository;
    applyTurnEffects();
    const service: TurnSnapshotService = buildService();

    const epochZero = expectCaptured(
      await service.captureTurnSnapshot({ ...CAPTURE_DEFAULTS, executionRoot: repository.root }),
    );
    // A rollback advanced the epoch and re-executed the same position with different content.
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
    // The superseded epoch's ref survives and still names its own tree; a service that clobbered
    // it would still satisfy "mints a distinct ref".
    expect(await repository.git(["rev-parse", epochZero.ref])).toBe(epochZero.snapshotCommit);
    expect(await repository.refListing("refs/sidekicks/")).toBe(
      `${epochZero.snapshotCommit} ${epochZero.ref}\n${epochOne.snapshotCommit} ${epochOne.ref}`,
    );
  });

  it("records the base resolved at entry as the parent when HEAD advances mid-capture", async () => {
    const repository: FixtureRepository = fixture.repository;
    applyTurnEffects();
    const base: string = await repository.git(["rev-parse", "HEAD"]);

    // The runner wraps the production one: the branch moves between the `read-tree` and
    // `commit-tree` legs, where passing symbolic `HEAD` to both would pair an old-HEAD tree with a
    // new-HEAD parent.
    let advanced = false;
    const advancingRunner: GitRunner = async (argv, options) => {
      const result = await runGitWithExecFile(argv, options);
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
    // The parent is the base resolved at entry, so a later comparison against HEAD can see the
    // move instead of anti-diffing the landed commit's files into the worktree.
    expect(result.baseCommit).toBe(base);
    expect(await repository.git(["rev-parse", `${result.ref}^`])).toBe(base);
    expect(await repository.git(["rev-parse", `${result.ref}^`])).not.toBe(movedHead);
  });

  it("reports an induced capture failure as a typed result plus a diagnostic, never a throw", async () => {
    const repository: FixtureRepository = fixture.repository;
    applyTurnEffects();
    const refsBefore: string = await repository.refListing();

    const failingRunner: GitRunner = async (argv, options) => {
      if (argv.includes("write-tree")) {
        throw new Error("induced write-tree failure");
      }
      return runGitWithExecFile(argv, options);
    };

    // No `rejects` wrapper: the assertion is that this resolves, since capture never gates a turn.
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
    // A failed capture publishes nothing.
    expect(await repository.refListing()).toBe(refsBefore);
    // No scratch index is left behind: the `finally` runs on the failure path too, so a daemon
    // that fails captures does not accumulate index files.
    expect(readdirSync(join(fixture.executionRootsDirectory, ".snapshot-indexes"))).toEqual([]);
  });

  it("reports an update-ref failure as `write-ref` when no ref explains it", async () => {
    const repository: FixtureRepository = fixture.repository;
    applyTurnEffects();
    const refsBefore: string = await repository.refListing();

    // Only the compare-and-swap fails; the existence probe runs for real and finds nothing, since
    // no ref was written. Reporting `already-captured` would hand out an OID for a snapshot that
    // does not exist, so the failure is rethrown. The probe's exact-read flags are a further guard
    // behind the runner's exit-status check and `requireObjectId`.
    let updateRefAttempts = 0;
    const failingRunner: GitRunner = async (argv, options) => {
      if (argv.includes("update-ref")) {
        updateRefAttempts += 1;
        throw new Error("induced update-ref failure");
      }
      return runGitWithExecFile(argv, options);
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
    // The tree and commit objects are unreferenced (`git gc` collects them); the namespace gains
    // nothing.
    expect(await repository.refListing()).toBe(refsBefore);
  });

  it("resolves when the diagnostic sink THROWS from inside the failure reporter", async () => {
    const repository: FixtureRepository = fixture.repository;
    applyTurnEffects();

    const failingRunner: GitRunner = async (argv, options) => {
      if (argv.includes("write-tree")) {
        throw new Error("induced write-tree failure");
      }
      return runGitWithExecFile(argv, options);
    };
    // The sink is called from inside `#failCapture`; an unguarded throw would replace the typed
    // failure with a thrown one, turning an observability fault into a turn-blocking one.
    const observed: TurnSnapshotDiagnostic[] = [];
    const throwingSink = (diagnostic: TurnSnapshotDiagnostic): void => {
      observed.push(diagnostic);
      throw new Error("induced sink failure");
    };

    const result = await buildService({
      git: failingRunner,
      emitDiagnostic: throwingSink,
    }).captureTurnSnapshot({ ...CAPTURE_DEFAULTS, executionRoot: repository.root });

    // Not vacuous: the sink ran and threw.
    expect(observed).toHaveLength(1);
    expect(observed[0]?.kind).toBe("capture-failed");
    expect(result).toEqual({
      outcome: "failed",
      ref: `refs/sidekicks/runs/${RUN_ID}/epoch-0/turn-1`,
      failedStep: "write-tree",
    });
  });

  it("resolves when the diagnostic sink is async and its promise REJECTS", async () => {
    const repository: FixtureRepository = fixture.repository;
    applyTurnEffects();

    const failingRunner: GitRunner = async (argv, options) => {
      if (argv.includes("write-tree")) {
        throw new Error("induced write-tree failure");
      }
      return runGitWithExecFile(argv, options);
    };
    // No cast: a promise-returning function is assignable to the seam's `(diagnostic) => void`.
    // An exporter that rejects a promise nobody holds would take the daemon down under Node's
    // default `--unhandled-rejections=throw`, past any `try` around the call.
    const observed: TurnSnapshotDiagnostic[] = [];
    const rejectingSink = (diagnostic: TurnSnapshotDiagnostic): Promise<void> => {
      observed.push(diagnostic);
      return Promise.reject(new Error("induced exporter failure"));
    };

    const result = await buildService({
      git: failingRunner,
      emitDiagnostic: rejectingSink,
    }).captureTurnSnapshot({ ...CAPTURE_DEFAULTS, executionRoot: repository.root });

    // An escaped rejection is reported outside any case and fails the run with a non-zero exit
    // (verified against an unguarded build), so surviving this macrotask is the containment
    // assertion.
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

    // The temp index lives outside the worktree (inside it, the `ls-files -o` listing would report
    // it as untracked content) and does not outlive its capture.
    expect(readdirSync(join(fixture.executionRootsDirectory, ".snapshot-indexes"))).toEqual([]);
    expect(existsSync(join(repository.root, ".snapshot-indexes"))).toBe(false);
    expect(await repository.git(["status", "--porcelain", "--ignored=no"])).not.toContain(
      "snapshot-index",
    );
  });

  it("leaves the execution root's OWN index untouched, staged work included", async () => {
    const repository: FixtureRepository = fixture.repository;
    applyTurnEffects();
    // Staged work mid-turn, a modification and an addition: the state the out-of-worktree index
    // protects. Every other case leaves the index empty, so they would still pass if
    // `GIT_INDEX_FILE` stopped reaching the index-touching legs; `read-tree` would then hit the
    // real index, produce the same OID, and discard the staged work.
    await repository.git(["add", "tracked.txt", "created.txt"]);
    const statusBefore: string = await repository.git(["status", "--porcelain"]);
    const stagedBefore: string = await repository.git(["diff", "--cached", "--name-only"]);
    // Guards against the byte-equality below holding trivially for an empty index.
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
    // The snapshot happened anyway, from the same worktree.
    expect(await repository.git(["rev-parse", result.ref])).toBe(result.snapshotCommit);
  });

  it("still resolves when the scratch-index cleanup fails on the SUCCESS arm", async () => {
    const repository: FixtureRepository = fixture.repository;
    applyTurnEffects();
    const cleanupFailure = new Error("EPERM: operation not permitted, unlink");

    // The `finally` is the one statement outside the failure funnel; a cleanup rejection (a
    // scanner holding the file, a throwing filesystem seam) would replace the typed result.
    const result = expectCaptured(
      await buildService({
        filesystem: buildRemoveFailingFilesystem(cleanupFailure),
      }).captureTurnSnapshot({
        ...CAPTURE_DEFAULTS,
        executionRoot: repository.root,
      }),
    );

    // The capture is intact.
    expect(await repository.git(["rev-parse", result.ref])).toBe(result.snapshotCommit);
    // The injection was not inert: the scratch index survived, so the result above is about the
    // `finally` and not a cleanup that quietly succeeded.
    expect(readdirSync(join(fixture.executionRootsDirectory, ".snapshot-indexes"))).toHaveLength(1);
    // Best-effort, but never silent.
    expect(fixture.diagnostics).toHaveLength(1);
    expect(fixture.diagnostics[0]).toMatchObject({
      kind: "scratch-index-cleanup-failed",
      runId: RUN_ID,
      epoch: 0,
      turnOrdinal: 1,
      detail: cleanupFailure.message,
    });
  });

  it("refuses every unusable ref component before any git call", async () => {
    const repository: FixtureRepository = fixture.repository;
    applyTurnEffects();
    const refsBefore: string = await repository.refListing();

    const invocations: string[][] = [];
    const recordingRunner: GitRunner = buildRecordingRunner(invocations);

    // Table-driven because the guard is a disjunction: driving only the `runId` arm would let the
    // epoch and ordinal arms be deleted unnoticed. The first row is a `runId` that would name a
    // branch; the rest would interpolate a nonsense segment into the ref path.
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
      // Dot shapes the character class alone admitted. Git also refuses the first two (measured
      // on git 2.50.1), but they are refused here as well: a refusal from git is a swallowed
      // capture failure, not a typed one.
      { label: "runId with consecutive dots", overrides: { runId: "run..1" } },
      { label: "runId with a .lock suffix", overrides: { runId: "run.lock" } },
      // Git accepts these two (measured on git 2.50.1), so they are this module's own narrowing.
      // Win32 strips a trailing dot, so `run.` and `run` would share a loose-ref directory. Git's
      // `.lock` rule is case-sensitive but APFS and NTFS are not, so `.LOCK` would name a sibling
      // ref's lock file.
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

    // The guard runs before any git call. Git would also refuse the escaping spelling, but that
    // refusal is a capture failure this service swallows into a diagnostic, so the namespace
    // guard cannot be delegated to it.
    expect(invocations).toEqual([]);
    expect(await repository.refListing()).toBe(refsBefore);
  });

  it("captures into the execution root under a hijacked ambient environment", async () => {
    const repository: FixtureRepository = fixture.repository;
    applyTurnEffects();
    const decoyRepository: string = join(fixture.fixtureRoot, "decoy.git");
    const hijackedObjectDirectory: string = join(fixture.fixtureRoot, "hijacked-objects");
    await repository.git(["init", "-q", "--bare", "-b", "main", decoyRepository], {
      cwd: fixture.fixtureRoot,
    });

    // The environment is a channel no ref-path validation can reach. These variables demonstrably
    // bite (confirmed on git 2.50.1, `-C <root>` notwithstanding):
    //
    //   * `GIT_DIR` wins over `-C`, so an unstripped one writes a correctly spelled snapshot ref
    //     into the decoy repository's store.
    //   * `GIT_OBJECT_DIRECTORY` without `GIT_DIR` makes git refuse discovery (`not a git
    //     repository`, exit 128), so an unstripped one captures nothing.
    //
    // `GIT_NAMESPACE` is stubbed only to show it is harmless in the mix, and nothing is asserted
    // about it: local ref plumbing ignores it, so no assertion could tell whether it was stripped.
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
      // Restored before the assertions so the fixture's own reads do not run under the hijack.
      vi.unstubAllEnvs();
    }

    const captured = expectCaptured(result);
    expect(captured.ref).toBe(`refs/sidekicks/runs/${RUN_ID}/epoch-0/turn-1`);
    // In the EXECUTION ROOT's repository, resolving to the reported OID…
    expect(await repository.refListing("refs/sidekicks/")).toBe(
      `${captured.snapshotCommit} ${captured.ref}`,
    );
    expect(await repository.git(["cat-file", "-t", captured.snapshotCommit])).toBe("commit");
    // …and nowhere else: the decoy has no refs and the hijacked object store was never created.
    expect(
      await repository.git(["--git-dir", decoyRepository, "for-each-ref", "--format=%(refname)"]),
    ).toBe("");
    expect(existsSync(hijackedObjectDirectory)).toBe(false);
  });

  it("never touches refs/heads when a DANGLING symref squats the capture path", async () => {
    const repository: FixtureRepository = fixture.repository;
    applyTurnEffects();

    // The create side's symref channel, which the create-only compare-and-swap does not cover: git
    // moves the must-not-exist check to the symref's referent. A live referent refuses either
    // way; a dangling one is the hole. The turn path is predictable from inside the run, so it
    // can be squatted before the capture that will use it.
    const squattedRef = `refs/sidekicks/runs/${RUN_ID}/epoch-0/turn-1`;
    const hostileBranch = "refs/heads/evil";
    await repository.git(["symbolic-ref", squattedRef, hostileBranch]);
    const headsBefore: string = await repository.refListing("refs/heads/");
    // Non-vacuity: the target is dangling. Against an existing branch the compare-and-swap
    // refuses and this case proves nothing.
    expect(headsBefore).not.toContain(hostileBranch);
    expect(
      (await repository.gitCapturing(["rev-parse", "--verify", hostileBranch])).exitCode,
    ).not.toBe(0);

    const result: TurnSnapshotCaptureResult = await buildService().captureTurnSnapshot({
      ...CAPTURE_DEFAULTS,
      executionRoot: repository.root,
    });

    // First and unbranched, because it holds on every git version and kills a dropped
    // `--no-deref`. Unflagged, this create writes `refs/heads/evil` at the snapshot commit and
    // exits 0, reporting a successful capture: a silent daemon write outside the namespace.
    // Measured unflagged on both git versions named below, so the mutant lands on the `captured`
    // arm on either; inside that arm these assertions would let it survive on the other.
    expect(await repository.refListing("refs/heads/")).toBe(headsBefore);
    expect(
      (await repository.gitCapturing(["rev-parse", "--verify", hostileBranch])).exitCode,
    ).not.toBe(0);

    // What the flagged create does with the squatted name depends on the git version, and the
    // outcome tag is the only split:
    //
    //   * git 2.50.1 (the local suite) drives the `captured` arm: the write lands on the validated
    //     in-namespace name, replacing the planted pointer with an ordinary snapshot ref.
    //   * git 2.54.0 (CI) drives the `failed` arm: the flagged create refuses over a dangling
    //     in-namespace symref. The existence probe reads nothing back (a dangling symref does not
    //     resolve for `show-ref --verify`), so the rethrow reaches the funnel as `failed` at
    //     `write-ref`.
    //
    // Both arms preserve the invariant: a squatted path that refuses fail-closed with a diagnostic
    // and lets the turn proceed is not a breach.
    if (result.outcome === "captured") {
      const captured = expectCaptured(result);
      // Whole-repository claim: every ref this capture produced is inside the run's namespace.
      // (`for-each-ref` sorts by refname, so `refs/heads/…` precedes `refs/sidekicks/…`.)
      expect(await repository.refListing()).toBe(
        `${headsBefore}\n${captured.snapshotCommit} ${squattedRef}`,
      );
      // The capture is truthful, not merely safe: the reported ref holds the reported commit.
      expect(captured.ref).toBe(squattedRef);
      expect(await repository.git(["rev-parse", "--verify", squattedRef])).toBe(
        captured.snapshotCommit,
      );
      expect(fixture.diagnostics).toEqual([]);
    } else {
      // The whole typed shape, so a third outcome fails here. An `already-captured` above all
      // would mean the existence probe fabricated an OID for a snapshot never written.
      expect(result).toEqual({
        outcome: "failed",
        ref: squattedRef,
        failedStep: "write-ref" satisfies TurnSnapshotCaptureStep,
      });
      // A refusal is not a half-write: the planted pointer survives as planted. Read it with
      // `symbolic-ref`, since `for-each-ref` omits a dangling symref and a listing claim about the
      // survivor would be vacuous.
      expect(await repository.git(["symbolic-ref", squattedRef])).toBe(hostileBranch);
      // For the same reason, the whole-repository listing is `refs/heads/` alone.
      expect(await repository.refListing()).toBe(headsBefore);
      // Diagnosed, not silent. The detail is Node's echoed argv followed by git's stderr, so it is
      // asserted on the argv token; pinning git's wording would break when a version rewords it.
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
    const recordingRunner: GitRunner = buildRecordingRunner(invocations);

    expectCaptured(
      await buildService({ git: recordingRunner }).captureTurnSnapshot({
        ...CAPTURE_DEFAULTS,
        executionRoot: repository.root,
      }),
    );

    // Structural: there is one private entry point, so this asserts the whole recorded set,
    // including the invocation the normalization pass makes inside the embedded repository.
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
    // The directory the flag points at exists and is empty; the empty directory is the mechanism.
    expect(readdirSync(neutralizationDirectory)).toEqual([]);
  });

  // Mode bits need POSIX.
  const itOnPosix = it.skipIf(process.platform === "win32");

  itOnPosix(
    "honors a TRACKED file's recorded 100755 under core.fileMode=false, as add -A does",
    async () => {
      const repository: FixtureRepository = fixture.repository;
      // The file is executable in the base commit, so its mode is a recorded fact rather than a
      // disk observation.
      repository.write("tool.sh", "#!/bin/sh\necho tool\n");
      chmodSync(join(repository.root, "tool.sh"), 0o755);
      await repository.git(["add", "-A"]);
      await repository.git(["commit", "-q", "-m", "exec base"]);
      expect(await repository.git(["ls-tree", "HEAD", "tool.sh"])).toContain("100755 blob");

      applyTurnEffects();
      // The turn drops the bit on disk and the host says disk modes are untrusted; under `false`
      // git believes the record.
      chmodSync(join(repository.root, "tool.sh"), 0o644);
      await repository.git(["config", "core.fileMode", "false"]);

      const captured: TurnSnapshotCaptured = await captureTurn(buildService());

      // A `-c core.fileMode=true` pin on the staging leg would record `100644` here: the seeded
      // scratch index has no stat data, so `update-index` re-stats every path and lstat would
      // outrank the base commit's recorded mode, destroying an exec bit the turn never meant to
      // change. That is why the recipe does not pin it.
      expect(await repository.git(["ls-tree", `${captured.ref}^{tree}`, "tool.sh"])).toContain(
        "100755 blob",
      );

      // Porcelain control: under the same host config `git add -A` also keeps `100755`.
      const porcelainTree: string = await repository.porcelainAddAllTree(
        join(fixture.fixtureRoot, "filemode-tracked.index"),
      );
      expect(await repository.git(["ls-tree", porcelainTree, "tool.sh"])).toContain("100755 blob");
    },
  );
});

// The sparse cases need a repository in a non-cone sparse state, because cone mode exercises only
// the easy half of git's sparsity matcher. The fixtures write `$GIT_DIR/info/sparse-checkout` and
// set the config bits directly, which is also what a repository configured by another tool looks
// like.

/**
 * Puts `repository` into a non-cone sparse state with the given patterns and makes the worktree
 * match.
 *
 * Applies the definition with `read-tree -mu HEAD`; the `sparse-checkout set` porcelain would
 * rewrite the patterns into cone form and leave `core.sparseCheckoutCone` true.
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
 * Asserts the tree the service captured is the tree `git add -A` would stage from this worktree
 * under the same config.
 *
 * Comparative rather than a literal path list, because git defines the sparse matcher: a literal
 * list would re-implement it and go version-fragile.
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
 * Returns the `Sparse-Boundary-Paths:` trailer's recorded paths as bytes, or `null` when the
 * snapshot has no such trailer.
 *
 * Bytes, because the trailer records `latin1` byte keys and decoded strings would test this
 * helper's decode. The chain matches production: the commit object is UTF-8 text, `JSON.parse`
 * yields one code point per path byte, and `latin1` recovers git's bytes. Read through the
 * service's runner because {@link FixtureRepository}'s `git` decodes as `utf8` and would mangle
 * the byte sequences under test.
 */
async function readSparseBoundaryTrailerBytes(
  repository: FixtureRepository,
  snapshotCommit: string,
): Promise<readonly Buffer[] | null> {
  const body: Buffer = (
    await runGitWithExecFile(["-C", repository.root, "cat-file", "commit", snapshotCommit], {
      timeoutMs: FIXTURE_GIT_TIMEOUT_MS,
    })
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
 * Returns the same trailer as text, for arms whose paths are plain ASCII.
 *
 * Non-ASCII paths must go through {@link readSparseBoundaryTrailerBytes}, which pins the format.
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
 * Wraps the real git runner and fails the one leg whose argv `matches`, rejecting with `stderr`
 * set as the production runner does.
 *
 * This drives the below-2.41 floor without an old git binary: what is tested is the service's
 * handling of an unknown-subcommand failure. Every other leg really runs.
 */
function buildLegFailingRunner(
  matches: (argv: readonly string[]) => boolean,
  message: string,
): GitRunner {
  return async (argv, options) => {
    if (matches(argv)) {
      return Promise.reject(Object.assign(new Error(message), { stderr: message }));
    }
    return runGitWithExecFile(argv, options);
  };
}

describe("TurnSnapshotService sparse execution roots", () => {
  it(
    "matches porcelain across cone, non-cone and NEGATION definitions, clean and materialized",
    async () => {
      const repository: FixtureRepository = fixture.repository;
      // The negation fixture is load-bearing. A `/*` include plus a nested `!/a/b/` re-exclusion
      // is where the gitignore machinery gives the wrong answer (measured on git 2.50.1: it scores
      // `a/b/deep.txt` includable, the sparsity matcher does not), so a partition built on the
      // exclude pipeline instead of `check-rules` passes the cone arm and fails here.
      repository.write("cone-in/kept.txt", "in cone\n");
      repository.write("cone-out/excluded.txt", "out of cone\n");
      repository.write("a/top.txt", "a top\n");
      repository.write("a/b/deep.txt", "a b deep\n");
      repository.write("a/b/c/deeper.txt", "a b c deeper\n");
      await repository.git(["add", "-A"]);
      await repository.git(["commit", "-q", "-m", "sparse matrix fixture"]);

      const service: TurnSnapshotService = buildService();
      let turnOrdinal = 0;

      // Each arm applies a definition, captures, and asserts porcelain equivalence. Cone mode goes
      // first as the control that a later failure is about the matcher, not the pipeline.
      await repository.git(["sparse-checkout", "set", "cone-in"]);
      turnOrdinal += 1;
      await expectCapturePorcelainEquivalent(
        repository,
        await captureTurn(service, { turnOrdinal }),
        "porcelain-cone.index",
      );

      // Non-cone positive pattern.
      await repository.git(["sparse-checkout", "disable"]);
      await applyNonConeSparseDefinition(repository, ["/cone-in/", "/*.txt", "/.gitignore"]);
      turnOrdinal += 1;
      await expectCapturePorcelainEquivalent(
        repository,
        await captureTurn(service, { turnOrdinal }),
        "porcelain-noncone.index",
      );

      // Top-level negation: everything minus one directory.
      await applyNonConeSparseDefinition(repository, ["/*", "!/cone-out/"]);
      turnOrdinal += 1;
      await expectCapturePorcelainEquivalent(
        repository,
        await captureTurn(service, { turnOrdinal }),
        "porcelain-negate-top.index",
      );

      // Nested negation, the case a gitignore-based oracle gets wrong.
      await applyNonConeSparseDefinition(repository, ["/*", "!/a/b/"]);
      turnOrdinal += 1;
      await expectCapturePorcelainEquivalent(
        repository,
        await captureTurn(service, { turnOrdinal }),
        "porcelain-negate-nested.index",
      );

      // The same definition with the worktree materialized at out-of-cone paths, a different index
      // state: writing at an out-of-cone path leaves a file git lists as untracked. Porcelain and
      // the capture must still agree about it.
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
    // Every other porcelain arm compares a clean worktree, where the scratch index's live-index
    // seed already carries the answer: an in-cone listing that staged nothing would still write
    // the right tree, because empty-stdin `update-index` is a no-op over a seeded index. Measured
    // by making the matcher return the empty set: the suite stayed green on every arm but one.
    // This arm holds uncommitted in-cone content, the shape that fails when the partition's
    // in-cone half breaks.
    repository.write("cone-in/kept.txt", "committed content\n");
    repository.write("cone-out/excluded.txt", "out of cone\n");
    await repository.git(["add", "-A"]);
    await repository.git(["commit", "-q", "-m", "in-cone staging fixture"]);
    await repository.git(["sparse-checkout", "set", "cone-in"]);

    // A modification to a tracked in-cone file and a new untracked one. The out-of-cone write is
    // the control: a partition that simply staged everything passes neither.
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
    // Sparse detection is keyed on the root and agnostic to the mode. `git worktree add` copies
    // the sparse state, so a `provisioned-worktree` root is sparse without the daemon saying so;
    // a detector keyed on the mode would call it non-sparse and lose its out-of-cone content.
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
    // Inheritance is asserted so a future git that stops copying the state does not silently turn
    // this into a non-sparse case.
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
    // The live-index seed's discriminating fixture. The user stages out-of-cone content and then
    // narrows the cone; the live index now differs from `HEAD` at that path, and seeding with
    // `read-tree <base>` would record the base's blob, not the staged one.
    repository.write("cone-in/kept.txt", "in cone\n");
    repository.write("cone-out/excluded.txt", "base content\n");
    await repository.git(["add", "-A"]);
    await repository.git(["commit", "-q", "-m", "sparse fixture"]);
    repository.write("cone-out/excluded.txt", "STAGED out-of-cone content\n");
    await repository.git(["add", "--sparse", "cone-out/excluded.txt"]);
    await repository.git(["sparse-checkout", "set", "cone-in"]);

    const captured: TurnSnapshotCaptured = await captureTurn(buildService());
    await expectCapturePorcelainEquivalent(repository, captured, "porcelain-staged.index");
    // Ground truth independent of the porcelain comparison: the recorded blob is the staged
    // content.
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

    // Intent-to-add guard, asserted comparatively: whether `write-tree` omits an intent-to-add
    // entry is git's call, so the claim is that capture agrees with porcelain about it.
    await expectCapturePorcelainEquivalent(repository, captured, "porcelain-boundary.index");

    // The boundary set is exactly the two paths the tree could not hold. The tracked out-of-cone
    // path is not in it: the live-index seed recorded it, so restore has a copy.
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

    // No untracked or intent-to-add out-of-cone content, so the boundary set is empty and the
    // trailer is written anyway: its presence marks a sparse-aware capture, so a missing trailer
    // can be told apart from an empty one.
    const service: TurnSnapshotService = buildService();
    const captured: TurnSnapshotCaptured = await captureTurn(service);
    expect(await readSparseBoundaryTrailer(repository, captured.snapshotCommit)).toEqual([]);

    // A second capture of the identical state at a later turn mints the identical commit, so the
    // trailer encoding is stable (the message is an OID input).
    const second: TurnSnapshotCaptured = await captureTurn(service, { turnOrdinal: 2 });
    expect(second.snapshotCommit).toBe(captured.snapshotCommit);
  });

  it("runs the NON-SPARSE pipeline byte-identically: no trailer, same `-F -` OID", async () => {
    const repository: FixtureRepository = fixture.repository;
    // Regression guard for the stdin transport: the commit rebuilt with fixture git using `-m`
    // must get the same OID as the service's `-F -` stream, for the one-paragraph message and for
    // the two-paragraph skipped-trailer form (where a join without a terminator would diverge).
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

    // Two-paragraph form, driven through a real skipped embedded repository so the trailer is the
    // service's own bytes.
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
    // Windows caps a command line at 32767 characters and the sparse trailer is unbounded, so the
    // message rides stdin: `commit-tree` carries `-F -`, no `-m`, and no argument is the message.
    // An argv transport keeps every OID, so only the argv shows it.
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
    // Detection is the bit alone: a leftover `$GIT_DIR/info/sparse-checkout` from a disabled sparse
    // checkout must not pull the root onto the sparse arm, because the worktree is intact.
    // `sparse-checkout disable` leaves the patterns file behind and clears only the bit (measured).
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
    // Non-sparse pipeline: no trailer at all, and the tree is still porcelain's.
    expect(await readSparseBoundaryTrailer(repository, captured.snapshotCommit)).toBeNull();
    await expectCapturePorcelainEquivalent(repository, captured, "porcelain-stale-rules.index");
  });

  it("FAILS CLOSED at `check-sparse-rules` when the bit is set but rules vanished", async () => {
    const repository: FixtureRepository = fixture.repository;
    // The bit is set, the rules file is gone, and the worktree still holds every out-of-cone path
    // (measured on git 2.50.1: porcelain `add -A` still records them). A detector that also
    // required the rules to parse would classify this non-sparse, seed from `read-tree <base>`, and
    // drop exactly what porcelain keeps.
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
    // Never a partial capture: no ref was written, so nothing can restore a snapshot with a hole in
    // it.
    expect(await repository.refListing("refs/sidekicks/")).toBe("");
  });

  it("FAILS CLOSED at `check-sparse-rules` on a git too old to know the subcommand", async () => {
    const repository: FixtureRepository = fixture.repository;
    repository.write("cone-in/kept.txt", "in cone\n");
    repository.write("cone-out/excluded.txt", "out of cone\n");
    await repository.git(["add", "-A"]);
    await repository.git(["commit", "-q", "-m", "sparse fixture"]);
    await repository.git(["sparse-checkout", "set", "cone-in"]);

    // The below-2.41 floor, driven through the seam (see `buildLegFailingRunner`). A matcher the
    // service cannot run is a typed failure, never a degrade to the unpartitioned listing.
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

    // With `--default=false` an unset key is a clean `false` at exit 0, so the only rejection left
    // is an unreadable config; defaulting that to the non-sparse pipeline would silently lose
    // content.
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
    // Negative control for the partition's scope: the cone decides which paths the matcher admits,
    // never which paths are ignorable. Replacing the exclude pipeline with the cone test would
    // capture this project-ignored file.
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
    // A real held lock, not an injected seam: the property is that this leg honors git's own
    // lockfile protocol. The lock is created the way git creates one (exclusively, at
    // `<index>.lock`) and removed by this case, never by the service.
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
      // The service must not remove a lock it did not create; doing so would corrupt the
      // repository of the process that holds it.
      expect(existsSync(lockPath)).toBe(true);
    } finally {
      rmSync(lockPath, { force: true });
    }

    // With the lock released, the same capture succeeds; otherwise the case would pass against a
    // leg that always failed.
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
      // The index path comes from `rev-parse --git-path index`, not `<root>/.git/index`: a linked
      // worktree keeps its index under `<main>/.git/worktrees/<id>/index`, so the naive spelling
      // would lock and copy the main checkout's index.
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
      // The layout is asserted, not assumed.
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

      // Discriminator: with only the main checkout's index locked, the worktree's capture
      // succeeds. A leg that resolved the index path naively would fail here.
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
    // Parity with porcelain, not a bespoke rule: `write-tree` refuses an unmerged entry, and the
    // capture must not turn that refusal into a silently dropped path. The stages are written with
    // `update-index --index-info` because a real merge conflict at an out-of-cone path is not
    // reachable (git resolves sparseness before it merges).
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

    // Porcelain's answer first, so the assertion below is a parity claim.
    const porcelainIndex: string = join(fixture.fixtureRoot, "porcelain-unmerged.index");
    copyFileSync(await repository.resolvedIndexPath(), porcelainIndex);
    const porcelainWriteTree: FixtureGitResult = await repository.gitCapturing(["write-tree"], {
      environmentOverrides: { GIT_INDEX_FILE: porcelainIndex },
    });

    // Asserted, not branched on, so the case cannot pass vacuously if the fixture stops producing
    // an unmerged path.
    expect(porcelainWriteTree.exitCode).not.toBe(0);
    expect(porcelainWriteTree.stderr).toContain("unmerged");

    // The capture fails at the leg that refused, never a snapshot silently missing the unmerged
    // path (which filtering it out of the staging listing would produce).
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
      // The trailer names every out-of-cone untracked path at the boundary, so it is unbounded,
      // and `-m` would put that on a command line. Windows `CreateProcess` stops accepting one at
      // 32767 characters while POSIX allows far more, so an argv transport would pass here and
      // fail there. The stream has no such bound; this drives a set past it end to end.
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
      // Assert the bound on the serialized line, so a shorter filler cannot leave the case
      // testing less than its name says.
      expect(JSON.stringify(trailer).length).toBeGreaterThan(32_767);
    },
    MULTI_SEQUENCE_CASE_TIMEOUT_MS,
  );

  it("carries a MULTIBYTE out-of-cone name through capture under `core.quotepath`", async () => {
    const repository: FixtureRepository = fixture.repository;
    // `core.quotepath=true` makes git C-quote non-ASCII paths in porcelain output. Every listing
    // this module reads is `-z`, which defeats that quoting; a quoted echo would key the in-cone
    // map on a different string than the listing slice and drop the path from the snapshot.
    //
    // A CJK name rather than accented Latin: APFS normalizes filenames to NFD, so `café` would
    // round-trip through different bytes and measure the filesystem instead of git's quoting.
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
    // Verbatim in the trailer, asserted on bytes: not `cone-out/\346\227\245…` (what reading
    // porcelain output would record) and not a re-encoding of a decode. The trailer holds `latin1`
    // keys, so `JSON.stringify`, the commit message's UTF-8, `JSON.parse` and `latin1` must
    // reproduce the file name's original bytes.
    expect(await readSparseBoundaryTrailerBytes(repository, captured.snapshotCommit)).toEqual([
      Buffer.from("cone-out/日本語.txt", "utf8"),
    ]);
  });

  it("subtracts the boundary set BYTE-EXACTLY; paths that decode alike stay distinct", async () => {
    const repository: FixtureRepository = fixture.repository;
    // Both listings are synthesized, so this drives the keying of
    // `TurnSnapshotCaptureSteps.deriveSparseBoundaryPaths` and asserts only the trailer and the
    // staged tree. APFS rejects a non-UTF-8 filename at `creat(2)` with `EILSEQ` (measured), so the
    // seam is the only way to get such paths.
    //
    // The two injected paths share no bytes but decode to the same string (`0xFF` and `0xFE` are
    // invalid UTF-8 lead bytes, both U+FFFD). A subtraction keyed on decoded strings would see the
    // tree already holding the boundary candidate and drop it from the trailer; one keyed on bytes
    // does not.
    repository.write("cone-in/kept.txt", "in cone\n");
    await repository.git(["add", "-A"]);
    await repository.git(["commit", "-q", "-m", "sparse fixture"]);
    await repository.git(["sparse-checkout", "set", "cone-in"]);

    const invalidCandidate: Buffer = Buffer.concat([Buffer.from("cone-out/"), Buffer.from([0xff])]);
    const invalidTreePath: Buffer = Buffer.concat([Buffer.from("cone-out/"), Buffer.from([0xfe])]);
    const NUL: Buffer = Buffer.from([0]);
    // Matched on the flags after the subcommand: `-co` is unique to the capture listing, and
    // `--name-only` to the boundary derivation's `ls-tree`.
    const injectingRunner: GitRunner = async (argv, options) => {
      const result = await runGitWithExecFile(argv, options);
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

    // The candidate survives the subtraction and is recorded as its own bytes: capture subtracts
    // on bytes and records bytes, so the whole lifecycle is byte-keyed.
    expect(await readSparseBoundaryTrailerBytes(repository, captured.snapshotCommit)).toEqual([
      invalidCandidate,
    ]);
    // The injection perturbed only the subtraction: the staged tree is still the one porcelain
    // builds.
    await expectCapturePorcelainEquivalent(repository, captured, "porcelain-byte-exact.index");
  });

  it("records a non-descended boundary DIRECTORY with its slash", async () => {
    const repository: FixtureRepository = fixture.repository;
    // At capture an out-of-cone untracked embedded repository is one `ls-files -o` entry with a
    // trailing slash (git does not descend it); the slash marks a recorded name that stands for a
    // subtree.
    repository.write("cone-in/kept.txt", "in cone\n");
    await repository.git(["add", "-A"]);
    await repository.git(["commit", "-q", "-m", "sparse fixture"]);
    await repository.git(["sparse-checkout", "set", "cone-in"]);
    mkdirSync(join(repository.root, "cone-out"), { recursive: true });
    await createEmbeddedRepository("cone-out/nested");
    writeFileSync(join(repository.root, "cone-out", "nested", "payload.txt"), "boundary payload\n");

    const service: TurnSnapshotService = buildService();
    const captured: TurnSnapshotCaptured = await captureTurn(service);
    // Recorded with the slash git listed it with.
    expect(await readSparseBoundaryTrailer(repository, captured.snapshotCommit)).toEqual([
      "cone-out/nested/",
    ]);
  });
});

// ----------------------------------------------------------------------------
// Retention fixtures
// ----------------------------------------------------------------------------
//
// A real migrated SQLite database, not a stubbed row source: the prune reads `git_common_dir` from
// `run_execution_contexts`. Seeding through the real DDL keeps its mode-conditional CHECK, which
// decides which companion rows a context legally has, in force.

const RETENTION_SESSION_ID = "0192b3c0-3333-7c4a-9b1c-1b7c5b3e8f00";
const RETENTION_MOUNT_ID = "0192b3c0-4444-7c4a-9b1c-1b7c5b3e8f00";
const RETENTION_WORKSPACE_ID = "0192b3c0-5555-7c4a-9b1c-1b7c5b3e8f00";

/** The seeded rows' timestamp, held fixed. */
const RETENTION_NOW = "2026-06-01T00:00:00.000Z";

/**
 * A second run id that extends {@link RUN_ID} by one character. The enumeration pattern is
 * `refs/sidekicks/runs/<runId>/`; only a sibling whose id starts with the pruned one catches a
 * pattern that matches by prefix instead of by path segment.
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
  /** The git dir the prune runs its ref operations through. */
  readonly gitCommonDir: string;
}

/**
 * Seed one `run_execution_contexts` row plus the companion rows its mode's CHECK requires: a
 * branch context for every mode, and a worktree row for `provisioned-worktree`.
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
         worktree_id, branch_context_id, created_at
       ) VALUES (
         @run_id, @session_id, @workspace_id, @execution_mode, @execution_root, @git_common_dir,
         @worktree_id, @branch_context_id, @now
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
    });
}

/** The fixture repository's own git directory, the surviving canonical store. */
function canonicalGitDirectory(): string {
  return join(fixture.repository.root, ".git");
}

/** A prune-wired service: the real DB, the held clock, the production git seam. */
function buildRetentionService(
  database: DatabaseType,
  overrides: ServiceOverrides = {},
): TurnSnapshotService {
  return buildService({ database, now: (): string => RETENTION_NOW, ...overrides });
}

/** A git seam that records every argv the service assembled, then really runs it. */
function buildRecordingRunner(invocations: string[][]): GitRunner {
  return async (argv, options) => {
    invocations.push([...argv]);
    return runGitWithExecFile(argv, options);
  };
}

describe("TurnSnapshotService retention prune", () => {
  afterEach(() => {
    // Close the handle before the outer hook removes the fixture root.
    closeRetentionDatabase();
  });

  it("deletes only the named run's namespace — heads and a sibling run survive", async () => {
    const repository: FixtureRepository = fixture.repository;
    const database: DatabaseType = openRetentionDatabase();
    const service: TurnSnapshotService = buildRetentionService(database);
    applyTurnEffects();
    // Two epochs and two ordinals, so "deleted the run's refs" is a claim about a set.
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
    });

    const pruned: TurnSnapshotRetentionPruneResult = await service.pruneSnapshotsForRun(RUN_ID);

    expect(pruned.skipped).toBeNull();
    expect([...pruned.deletedRefs].sort()).toEqual([first.ref, second.ref].sort());
    // Branch history is untouched, and the prefix-extension sibling (whose ref path starts with
    // the pruned run's id) kept every ref it had.
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

    // The name check cannot see this: the name is legitimate, a symbolic ref at a well-formed
    // in-namespace path whose target is a branch. `for-each-ref` reports `%(objectname)` resolved
    // through the symref, so the listing entry is a 40-hex oid at an in-prefix name, and the
    // compare-and-swap matches because that oid is already the branch's. Only `--no-deref` stands
    // between this row and a deleted branch.
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
    // The listing the prune acts on really does resolve through the symref; otherwise the case
    // would test nothing.
    expect(await repository.refListing(`refs/sidekicks/runs/${RUN_ID}/`)).toContain(
      `${branchTipBefore} ${plantedRef}`,
    );
    insertRunExecutionContext(database, {
      runId: RUN_ID,
      executionMode: "provisioned-worktree",
      executionRoot: repository.root,
      gitCommonDir: canonicalGitDirectory(),
    });

    const pruned: TurnSnapshotRetentionPruneResult = await service.pruneSnapshotsForRun(RUN_ID);

    // Branch history is byte-identical. Measured on git 2.50.1: without `--no-deref` this same
    // argv deletes the branch, leaves the symref dangling, exits 0, and the prune reports a clean
    // result with `skipped: null`; with it, the deletion lands on the symref.
    expect(await repository.refListing("refs/heads/")).toBe(headsBefore);
    expect(await repository.git(["rev-parse", "--verify", checkedOutBranch])).toBe(branchTipBefore);
    // The in-namespace pointer is gone along with the real snapshot: the flag scopes the delete,
    // it does not skip the entry.
    expect(await repository.refListing("refs/sidekicks/")).toBe("");
    expect([...pruned.deletedRefs].sort()).toEqual([captured.ref, plantedRef].sort());
    expect(pruned.skipped).toBeNull();
    expect(fixture.diagnostics).toEqual([]);
  });

  it("refuses a namespace-escaping run id before any git call", async () => {
    const repository: FixtureRepository = fixture.repository;
    const database: DatabaseType = openRetentionDatabase();
    const invocations: string[][] = [];
    const service: TurnSnapshotService = buildRetentionService(database, {
      git: buildRecordingRunner(invocations),
    });
    const headsBefore: string = await repository.refListing("refs/heads/");
    expect(headsBefore).not.toBe("");

    // A hostile row as well as a hostile argument: the lookup finds it, so only the id check stops
    // it.
    insertRunExecutionContext(database, {
      runId: UNSAFE_RUN_ID,
      executionMode: "provisioned-worktree",
      executionRoot: repository.root,
      gitCommonDir: canonicalGitDirectory(),
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
    // Refused before git, not by git: no invocation was assembled. Git's own `refusing to update
    // ref with bad name` would report a successful prune of nothing.
    expect(invocations).toEqual([]);
    expect(await repository.refListing("refs/heads/")).toBe(headsBefore);
  });

  it("drops a listing entry outside the run prefix instead of deleting it", async () => {
    const repository: FixtureRepository = fixture.repository;
    const database: DatabaseType = openRetentionDatabase();
    const headCommit: string = await repository.git(["rev-parse", "HEAD"]);
    const deletions: string[][] = [];

    // Covers what a validated `runId` cannot: git's own pattern matching. The enumeration is
    // fabricated to name a branch, as a `for-each-ref` that matched more than asked would.
    const hostileListingRunner: GitRunner = async (argv, options) => {
      if (argv.includes("for-each-ref")) {
        return { stdout: Buffer.from(`${headCommit} refs/heads/main\n`, "utf8"), stderr: "" };
      }
      if (argv.includes("update-ref")) {
        deletions.push([...argv]);
      }
      return runGitWithExecFile(argv, options);
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
    });

    const pruned: TurnSnapshotRetentionPruneResult = await service.pruneSnapshotsForRun(RUN_ID);

    expect(pruned).toEqual({ runId: RUN_ID, deletedRefs: [], skipped: null });
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
    // A real object that is not the snapshot commit: the snapshot's own parent.
    const staleObjectId: string = await repository.git(["rev-parse", "HEAD"]);

    // The deletion names the oid the enumeration read (a compare-and-swap). This listing reports a
    // stale oid for the second ref, as a ref that moved between the two commands would.
    const staleListingRunner: GitRunner = async (argv, options) => {
      if (argv.includes("for-each-ref")) {
        return {
          stdout: Buffer.from(
            `${first.snapshotCommit} ${first.ref}\n${staleObjectId} ${second.ref}\n`,
            "utf8",
          ),
          stderr: "",
        };
      }
      return runGitWithExecFile(argv, options);
    };
    insertRunExecutionContext(database, {
      runId: RUN_ID,
      executionMode: "provisioned-worktree",
      executionRoot: repository.root,
      gitCommonDir: canonicalGitDirectory(),
    });

    const pruned: TurnSnapshotRetentionPruneResult = await buildRetentionService(database, {
      git: staleListingRunner,
    }).pruneSnapshotsForRun(RUN_ID);

    // Convergent: the refs it really deleted are reported with the reason it stopped, not an
    // atomic all-or-nothing claim.
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

    // The common dir as recorded at context creation, read the same way, not hardcoded, so the
    // fixture cannot agree with the service by accident.
    const recordedCommonDirectory: string = await repository.git(
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd: worktreeRoot },
    );

    const captured = expectCaptured(
      await service.captureTurnSnapshot({ ...CAPTURE_DEFAULTS, executionRoot: worktreeRoot }),
    );
    // The premise, established: a ref written from inside a linked worktree lands in the shared
    // common store.
    expect(await repository.refListing("refs/sidekicks/")).toBe(
      `${captured.snapshotCommit} ${captured.ref}`,
    );

    insertRunExecutionContext(database, {
      runId: RUN_ID,
      executionMode: "provisioned-worktree",
      executionRoot: worktreeRoot,
      gitCommonDir: recordedCommonDirectory,
    });

    // The physical retirement: the execution root is gone while its refs remain. A prune that ran
    // through `execution_root` would find nothing and leak these refs.
    rmSync(worktreeRoot, { recursive: true, force: true });
    await repository.git(["worktree", "prune"]);
    expect(existsSync(worktreeRoot)).toBe(false);

    const pruned: TurnSnapshotRetentionPruneResult = await service.pruneSnapshotsForRun(RUN_ID);

    expect(pruned).toEqual({ runId: RUN_ID, deletedRefs: [captured.ref], skipped: null });
    expect(await repository.refListing("refs/sidekicks/")).toBe("");
  });

  it("skips a REMOVED repository as git-dir-absent, never fatal", async () => {
    const database: DatabaseType = openRetentionDatabase();
    const service: TurnSnapshotService = buildRetentionService(database);
    const removedRepositoryRoot: string = join(fixture.fixtureRoot, "removed-repo");
    insertRunExecutionContext(database, {
      runId: RUN_ID,
      executionMode: "provisioned-worktree",
      executionRoot: removedRepositoryRoot,
      gitCommonDir: join(removedRepositoryRoot, ".git"),
    });

    const pruned: TurnSnapshotRetentionPruneResult = await service.pruneSnapshotsForRun(RUN_ID);

    expect(pruned.deletedRefs).toEqual([]);
    // Absent, not merely unusable: the mode is `provisioned-worktree`, so nothing was supposed to
    // remove this store. The skip names the run and git's refusal.
    expect(pruned.skipped).toMatchObject({ runId: RUN_ID, reason: "git-dir-absent" });
    expect(pruned.skipped?.detail).toContain("not a git repository");
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
    });

    const first: TurnSnapshotRetentionPruneResult = await service.pruneSnapshotsForRun(RUN_ID);
    const refsAfterFirst: string = await repository.refListing();
    const second: TurnSnapshotRetentionPruneResult = await service.pruneSnapshotsForRun(RUN_ID);

    expect(first).toEqual({ runId: RUN_ID, deletedRefs: [captured.ref], skipped: null });
    // An empty result, not the same one: the second prune enumerated nothing, so it issued no
    // `update-ref -d`, and the ref set is byte-identical.
    expect(second).toEqual({ runId: RUN_ID, deletedRefs: [], skipped: null });
    expect(await repository.refListing()).toBe(refsAfterFirst);
    expect(fixture.diagnostics).toEqual([]);
  });

  it("drops a listing entry whose OID is not an object id, before it reaches an argv", async () => {
    const database: DatabaseType = openRetentionDatabase();
    const invocations: string[][] = [];
    const capturing: TurnSnapshotService = buildRetentionService(database);
    applyTurnEffects();
    const captured = await captureTurn(capturing);

    // The other half of the listing guard: this line's ref is under the correct prefix, but the
    // field git would fill with an object id carries a git option. The deletion argv is
    // `update-ref -d <ref> <oid>`, so an unchecked value there is a flag in a command that
    // deletes refs.
    const forgedOidRunner: GitRunner = async (argv, options) => {
      invocations.push([...argv]);
      if (argv.includes("for-each-ref")) {
        return {
          stdout: Buffer.from(`--upload-pack=x ${captured.ref}\n`, "utf8"),
          stderr: "",
        };
      }
      return runGitWithExecFile(argv, options);
    };
    insertRunExecutionContext(database, {
      runId: RUN_ID,
      executionMode: "provisioned-worktree",
      executionRoot: fixture.repository.root,
      gitCommonDir: canonicalGitDirectory(),
    });

    const pruned: TurnSnapshotRetentionPruneResult = await buildRetentionService(database, {
      git: forgedOidRunner,
    }).pruneSnapshotsForRun(RUN_ID);

    expect(pruned).toEqual({ runId: RUN_ID, deletedRefs: [], skipped: null });
    expect(invocations.filter((argv) => argv.includes("update-ref"))).toEqual([]);
    // The ref the forged line named is untouched: dropped, not refused.
    expect(await fixture.repository.refListing("refs/sidekicks/")).toBe(
      `${captured.snapshotCommit} ${captured.ref}`,
    );
  });
});
