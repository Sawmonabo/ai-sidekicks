// The turn-snapshot cases' fixture: a real git repository under a temporary root, the service at
// production seams, and readers for what a capture wrote.

import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import type { Database as DatabaseType } from "better-sqlite3";
import { expect } from "vitest";

import {
  buildFixtureEnvironment as buildHermeticFixtureEnvironment,
  FIXTURE_GIT_TIMEOUT_MS,
  spawnFixtureGit,
  type FixtureGitResult,
} from "../../__fixtures__/command.js";
import { runGitWithExecFile, type GitRunner } from "../../process.js";
import { TurnSnapshotService } from "../service.js";
import type { TurnSnapshotCaptureResult, TurnSnapshotCaptured } from "../service.js";
import type { TurnSnapshotDiagnostic } from "../diagnostics.js";
import type { GitFilesystem } from "../../filesystem.js";

/** The run every case captures for; a UUID, which the ref-component validator admits. */
export const RUN_ID = "0192b3c0-1111-7c4a-9b1c-1b7c5b3e8f00";

/**
 * The ref a run's first capture writes, spelled literally rather than derived from the service, so
 * a changed ref builder cannot agree with itself.
 */
export const FIRST_TURN_REF: string = `refs/sidekicks/runs/${RUN_ID}/epoch-0/turn-1`;

/**
 * Every case spawns git, and a contended host can push a sub-second case past Vitest's 5s default.
 * Larger than the fixture's own git timeout, so a hung fixture spawn fails naming its leg.
 */
export const ORDINARY_CASE_TIMEOUT_MS = 45_000;

/** For the cases that run several capture pipelines or build a second checkout. */
export const MULTI_SEQUENCE_CASE_TIMEOUT_MS = 60_000;

// The turn-boundary instant the service stamps as author and committer date. Held fixed because it
// is an object-id input.
const FIXED_INSTANT = "2026-01-01T00:00:00.000Z";

const FIXTURE_IGNORE_RULES = "ignored-dir/\nignored-file.txt\ntracked-but-ignored.txt\n";

interface FixtureGitOptions {
  readonly cwd?: string;
  readonly environmentOverrides?: Readonly<Record<string, string>>;
  /** Written to the child's stdin, which is then closed. */
  readonly stdin?: string;
}

/**
 * One real git repository under the fixture root, driven under the hermetic fixture environment.
 */
export class FixtureRepository {
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

  /** Writes a worktree file, creating its parent directories. */
  write(relativePath: string, contents: string): void {
    const absolute: string = join(this.root, relativePath);
    mkdirSync(join(absolute, ".."), { recursive: true });
    writeFileSync(absolute, contents);
  }

  /** The `<oid> <name>` line per ref matching `pattern` (every ref when omitted), sorted. */
  refListing(pattern?: string): Promise<string> {
    const argv: readonly string[] = ["for-each-ref", "--format=%(objectname) %(refname)"];
    return this.git(pattern === undefined ? argv : [...argv, pattern]);
  }

  /** Every path in `treeish`, recursively. */
  async treePaths(treeish: string): Promise<readonly string[]> {
    const listing: string = await this.git(["ls-tree", "-r", "--name-only", treeish]);
    return listing.split("\n").filter((line) => line !== "");
  }

  /**
   * This repository's own index file, resolved through git: a linked worktree's `.git` is a file
   * and its index lives under `<main>/.git/worktrees/<id>/`.
   */
  async resolvedIndexPath(): Promise<string> {
    const reported: string = await this.git(["rev-parse", "--git-path", "index"]);
    return isAbsolute(reported) ? reported : join(this.root, reported);
  }

  /**
   * The tree porcelain `git add -A` would stage from the current worktree, staged against a copy
   * of the real index so fixture state is untouched. In a sparse root `add -A` exits 1 over
   * out-of-cone paths it declined, and the index it leaves is still the reference; any other
   * failure throws.
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

/** Seams a case replaces; everything unset stays at the production default. */
export interface ServiceOverrides {
  readonly git?: GitRunner;
  readonly filesystem?: Pick<GitFilesystem, "createDirectory" | "removePath">;
  readonly now?: () => string;
  readonly emitDiagnostic?: (diagnostic: TurnSnapshotDiagnostic) => void;
  /** The prune only; the capture cases construct without one. */
  readonly database?: DatabaseType;
}

interface CaptureOverrides {
  readonly runId?: string;
  readonly epoch?: number;
  readonly turnOrdinal?: number;
  readonly executionRoot?: string;
  /** Defaults to the execution root, its own checkout's top level. */
  readonly checkoutRoot?: string;
}

/**
 * One case's world: a base repository with a committed ignore file, a tracked file `.gitignore`
 * matches and a file the turn deletes, plus the diagnostics the service emitted. Built fresh per
 * case and removed after it.
 */
export class TurnSnapshotFixture {
  readonly fixtureRoot: string;
  readonly executionRootsDirectory: string;
  readonly repository: FixtureRepository;
  readonly diagnostics: TurnSnapshotDiagnostic[] = [];
  readonly #environment: NodeJS.ProcessEnv;
  #scratchIndexCount = 0;

  private constructor(fixtureRoot: string, environment: NodeJS.ProcessEnv) {
    this.fixtureRoot = fixtureRoot;
    this.executionRootsDirectory = join(fixtureRoot, "execution-roots");
    this.#environment = environment;
    this.repository = new FixtureRepository(join(fixtureRoot, "execution-root"), environment);
  }

  /** Builds the base repository; a setup that fails halfway removes what it made. */
  static async create(): Promise<TurnSnapshotFixture> {
    // `realpathSync` because macOS hands out `/var/...` symlinks for the temporary directory while
    // git reports the resolved `/private/var/...` form.
    const fixtureRoot: string = realpathSync(
      mkdtempSync(join(tmpdir(), "ai-sidekicks-turn-snapshot-")),
    );
    // Fixed dates: the porcelain legs are the reference a capture is compared against. The service
    // runs under the production environment, since its immunity to host config is the claim.
    const fixture = new TurnSnapshotFixture(
      fixtureRoot,
      buildHermeticFixtureEnvironment(fixtureRoot, {
        GIT_AUTHOR_DATE: "1735689600 +0000",
        GIT_COMMITTER_DATE: "1735689600 +0000",
      }),
    );
    try {
      await fixture.#initBaseRepository(fixture.repository, "sha1");
    } catch (error) {
      fixture.remove();
      throw error;
    }
    return fixture;
  }

  /** Deletes the fixture root. */
  remove(): void {
    rmSync(this.fixtureRoot, { recursive: true, force: true });
  }

  /** A second execution root with the base repository's shape, at a chosen object format. */
  async createBaseRepository(name: string, objectFormat: string): Promise<FixtureRepository> {
    const repository = new FixtureRepository(join(this.fixtureRoot, name), this.#environment);
    await this.#initBaseRepository(repository, objectFormat);
    return repository;
  }

  /** A linked worktree of the base repository on a new branch. */
  async addLinkedWorktree(name: string, branchName: string): Promise<FixtureRepository> {
    const root: string = join(this.fixtureRoot, name);
    await this.repository.git(["worktree", "add", "-q", "-b", branchName, root]);
    return new FixtureRepository(root, this.#environment);
  }

  /** The service under test, at production seams unless a case overrides one. */
  buildService(overrides: ServiceOverrides = {}): TurnSnapshotService {
    return new TurnSnapshotService({
      executionRootsDirectory: this.executionRootsDirectory,
      now: overrides.now ?? ((): string => FIXED_INSTANT),
      emitDiagnostic:
        overrides.emitDiagnostic ??
        ((diagnostic: TurnSnapshotDiagnostic): void => {
          this.diagnostics.push(diagnostic);
        }),
      ...(overrides.git === undefined ? {} : { git: overrides.git }),
      ...(overrides.filesystem === undefined ? {} : { filesystem: overrides.filesystem }),
      ...(overrides.database === undefined ? {} : { database: overrides.database }),
    });
  }

  /** Captures turn 1 of epoch 0 of {@link RUN_ID} in the base repository unless overridden. */
  capture(
    service: TurnSnapshotService,
    overrides: CaptureOverrides = {},
  ): Promise<TurnSnapshotCaptureResult> {
    const executionRoot = overrides.executionRoot ?? this.repository.root;
    return service.captureTurnSnapshot({
      runId: RUN_ID,
      epoch: 0,
      turnOrdinal: 1,
      checkoutRoot: executionRoot,
      ...overrides,
      executionRoot,
    });
  }

  /** {@link capture}, failing the case with the actual outcome unless it captured. */
  async captureTurn(
    service: TurnSnapshotService,
    overrides: CaptureOverrides = {},
  ): Promise<TurnSnapshotCaptured> {
    return expectCaptured(await this.capture(service, overrides));
  }

  /** Asserts the captured tree is the one `git add -A` would stage from the same worktree. */
  async expectPorcelainEquivalent(
    repository: FixtureRepository,
    captured: TurnSnapshotCaptured,
  ): Promise<void> {
    this.#scratchIndexCount += 1;
    const scratchIndexPath: string = join(
      this.fixtureRoot,
      `porcelain-${String(this.#scratchIndexCount)}.index`,
    );
    expect(await repository.git(["rev-parse", `${captured.ref}^{tree}`])).toBe(
      await repository.porcelainAddAllTree(scratchIndexPath),
    );
  }

  /** The turn's effects on the base repository: an edit, a delete, new and ignored files. */
  applyTurnEffects(): void {
    this.repository.write("tracked.txt", "tracked v2 — modified during the turn\n");
    rmSync(join(this.repository.root, "doomed.txt"));
    this.repository.write("created.txt", "created during the turn\n");
    this.repository.write("nested/deep/created.txt", "created deeper\n");
    this.repository.write("ignored-file.txt", "derived, project-declared disposable\n");
    this.repository.write("ignored-dir/artifact.bin", "derived\n");
  }

  /** The scratch indexes the service left behind; empty once every capture cleaned up. */
  scratchIndexEntries(): readonly string[] {
    return readdirSync(join(this.executionRootsDirectory, ".snapshot-indexes"));
  }

  async #initBaseRepository(repository: FixtureRepository, objectFormat: string): Promise<void> {
    mkdirSync(repository.root, { recursive: true });
    await repository.git(
      [
        "-c",
        "init.defaultBranch=main",
        "init",
        "-q",
        `--object-format=${objectFormat}`,
        repository.root,
      ],
      { cwd: this.fixtureRoot },
    );
    repository.write("tracked.txt", "tracked v1\n");
    repository.write(".gitignore", FIXTURE_IGNORE_RULES);
    repository.write("tracked-but-ignored.txt", "tracking wins over ignoring\n");
    repository.write("doomed.txt", "deleted during the turn\n");
    await repository.git(["add", "-A"]);
    // `-f`: the base commit must contain a file `.gitignore` matches, which `git add -A` skips.
    await repository.git(["add", "-f", "tracked-but-ignored.txt"]);
    await repository.git(["commit", "-q", "-m", "base"]);
  }
}

/** Narrows to the `captured` arm, failing the case with the actual outcome if not. */
export function expectCaptured(result: TurnSnapshotCaptureResult): TurnSnapshotCaptured {
  expect(result.outcome).toBe("captured");
  if (result.outcome !== "captured") {
    throw new Error("unreachable — asserted above");
  }
  return result;
}

/** An untracked embedded git repository with an unborn `HEAD`, which no gitlink can record. */
export async function initEmbeddedRepository(
  parent: FixtureRepository,
  relativePath: string,
  objectFormat = "sha1",
): Promise<string> {
  const absolute: string = join(parent.root, relativePath);
  mkdirSync(absolute, { recursive: true });
  await parent.git(
    ["-c", "init.defaultBranch=main", "init", "-q", `--object-format=${objectFormat}`, absolute],
    { cwd: parent.root },
  );
  return absolute;
}

/** An untracked embedded git repository with one commit; returns its `HEAD`. */
export async function createEmbeddedRepository(
  parent: FixtureRepository,
  relativePath: string,
  objectFormat = "sha1",
): Promise<string> {
  const absolute: string = await initEmbeddedRepository(parent, relativePath, objectFormat);
  writeFileSync(join(absolute, "inner.txt"), "inner\n");
  await parent.git(["add", "-A"], { cwd: absolute });
  await parent.git(["commit", "-q", "-m", "inner"], { cwd: absolute });
  return parent.git(["rev-parse", "HEAD"], { cwd: absolute });
}

/** A git seam that records every argv the service assembled, then really runs it. */
export function buildRecordingRunner(invocations: string[][]): GitRunner {
  return async (argv, options) => {
    invocations.push([...argv]);
    return runGitWithExecFile(argv, options);
  };
}

/**
 * Wraps the real git runner and fails the one leg whose argv `matches`, rejecting with `stderr` set
 * as the production runner does. Every other leg really runs.
 */
export function buildLegFailingRunner(
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

/**
 * The paths a snapshot's `trailerKey` trailer records, as bytes, or `null` when it has none.
 *
 * Bytes, because the trailer holds `latin1` keys: the commit object is UTF-8 text, `JSON.parse`
 * yields one code point per path byte, and `latin1` recovers git's bytes. Read through the
 * production runner because the fixture's `git` decodes as `utf8` and would mangle them.
 */
export async function readTrailerBytes(
  repository: FixtureRepository,
  snapshotCommit: string,
  trailerKey: string,
): Promise<readonly Buffer[] | null> {
  const body: Buffer = (
    await runGitWithExecFile(["-C", repository.root, "cat-file", "commit", snapshotCommit], {
      timeoutMs: FIXTURE_GIT_TIMEOUT_MS,
    })
  ).stdout;
  for (const line of body.toString("utf8").split("\n")) {
    if (line.startsWith(trailerKey)) {
      const recorded = JSON.parse(line.slice(trailerKey.length).trim()) as readonly string[];
      return recorded.map((pathKey) => Buffer.from(pathKey, "latin1"));
    }
  }
  return null;
}

/** {@link readTrailerBytes} decoded as UTF-8, for paths that are valid UTF-8. */
export async function readTrailer(
  repository: FixtureRepository,
  snapshotCommit: string,
  trailerKey: string,
): Promise<readonly string[] | null> {
  const recorded = await readTrailerBytes(repository, snapshotCommit, trailerKey);
  return recorded === null ? null : recorded.map((pathBytes) => pathBytes.toString("utf8"));
}
