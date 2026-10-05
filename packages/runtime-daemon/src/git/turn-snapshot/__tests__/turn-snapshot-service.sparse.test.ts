// Turn-snapshot capture in sparse roots over real git: the tree is what `git add -A` stages, the
// out-of-cone paths the tree cannot hold are named in a trailer a restore relies on, and anything
// the capture cannot partition faithfully fails closed.

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runGitWithExecFile, type GitRunner } from "../../process.js";
import type { TurnSnapshotCaptureStep } from "../types.js";
import {
  buildLegFailingRunner,
  buildRecordingRunner,
  createEmbeddedRepository,
  type FixtureRepository,
  MULTI_SEQUENCE_CASE_TIMEOUT_MS,
  ORDINARY_CASE_TIMEOUT_MS,
  readTrailer,
  readTrailerBytes,
  TurnSnapshotFixture,
} from "./turn-snapshot-service.test-support.js";

vi.setConfig({ testTimeout: ORDINARY_CASE_TIMEOUT_MS });

const BOUNDARY_TRAILER = "Sparse-Boundary-Paths:";

let fixture: TurnSnapshotFixture;

beforeEach(async () => {
  fixture = await TurnSnapshotFixture.create();
});

afterEach(() => {
  fixture.remove();
});

/** Commits `files` in the base repository, then narrows it to a cone of `cone-in`. */
async function commitConeFixture(files: Readonly<Record<string, string>>): Promise<void> {
  const { repository } = fixture;
  for (const [relativePath, contents] of Object.entries(files)) {
    repository.write(relativePath, contents);
  }
  await repository.git(["add", "-A"]);
  await repository.git(["commit", "-q", "-m", "sparse fixture"]);
  await repository.git(["sparse-checkout", "set", "cone-in"]);
}

/**
 * Puts `repository` into a non-cone sparse state with `patterns` and makes the worktree match.
 * `read-tree -mu HEAD` rather than `sparse-checkout set`, which would rewrite them into cone form.
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

describe("TurnSnapshotService in sparse execution roots", () => {
  it(
    "matches porcelain across cone, non-cone and negation definitions, uncommitted work included",
    async () => {
      const { repository } = fixture;
      repository.write("cone-in/kept.txt", "committed content\n");
      repository.write("cone-out/excluded.txt", "out of cone\n");
      repository.write("a/top.txt", "a top\n");
      repository.write("a/b/deep.txt", "a b deep\n");
      repository.write("a/b/c/deeper.txt", "a b c deeper\n");
      await repository.git(["add", "-A"]);
      await repository.git(["commit", "-q", "-m", "sparse matrix fixture"]);
      // Uncommitted in-cone work: over a clean worktree the live-index seed alone already holds the
      // answer, so an in-cone listing that staged nothing would pass. The ignored file checks the
      // cone never rescues a path the project ignores.
      repository.write("cone-in/kept.txt", "uncommitted edit\n");
      repository.write("cone-in/added.txt", "uncommitted addition\n");
      repository.write("cone-in/ignored-file.txt", "in cone and ignored\n");
      const service = fixture.buildService();

      await repository.git(["sparse-checkout", "set", "cone-in"]);
      const coneCapture = await fixture.captureTurn(service, { turnOrdinal: 1 });
      await fixture.expectPorcelainEquivalent(repository, coneCapture);
      // Written in every sparse root, so a missing trailer is never mistaken for an empty one.
      expect(await readTrailer(repository, coneCapture.snapshotCommit, BOUNDARY_TRAILER)).toEqual(
        [],
      );

      await repository.git(["sparse-checkout", "disable"]);
      // The nested negation is where gitignore matching and git's sparsity matcher disagree about
      // `a/b/deep.txt`, so a partition not built on `check-rules` fails there. The last arm writes
      // at out-of-cone paths, which git then lists as untracked.
      const definitions: readonly (readonly string[])[] = [
        ["/cone-in/", "/*.txt", "/.gitignore"],
        ["/*", "!/cone-out/"],
        ["/*", "!/a/b/"],
      ];
      for (const [index, patterns] of definitions.entries()) {
        await applyNonConeSparseDefinition(repository, patterns);
        const captured = await fixture.captureTurn(service, { turnOrdinal: index + 2 });
        await fixture.expectPorcelainEquivalent(repository, captured);
      }
      repository.write("a/b/deep.txt", "materialized out-of-cone edit\n");
      repository.write("a/b/stray.txt", "materialized out-of-cone stray\n");
      const materialized = await fixture.captureTurn(service, { turnOrdinal: 9 });
      await fixture.expectPorcelainEquivalent(repository, materialized);
    },
    MULTI_SEQUENCE_CASE_TIMEOUT_MS,
  );

  it(
    "captures a sparse linked worktree from its own index and honors git's lock on it",
    async () => {
      const { repository } = fixture;
      await commitConeFixture({
        "cone-in/kept.txt": "in cone\n",
        "cone-out/excluded.txt": "out of cone\n",
      });
      // `git worktree add` copies the sparse state, so a provisioned worktree is sparse without the
      // daemon saying so; keyed on the mode, it would lose its out-of-cone content.
      const worktree = await fixture.addLinkedWorktree("linked-worktree", "feature/sparse");
      expect(await worktree.git(["config", "--type=bool", "--get", "core.sparseCheckout"])).toBe(
        "true",
      );
      const service = fixture.buildService();
      const mainLock = `${await repository.resolvedIndexPath()}.lock`;
      const worktreeLock = `${await worktree.resolvedIndexPath()}.lock`;

      // A held lock on the main index blocks the main capture and never the worktree's, which reads
      // its index from `<main>/.git/worktrees/<id>/`.
      writeFileSync(mainLock, "");
      try {
        expect(await fixture.capture(service)).toMatchObject({
          outcome: "failed",
          failedStep: "seed-index",
        });
        // Removing a lock it did not take would corrupt the holder's repository.
        expect(existsSync(mainLock)).toBe(true);
        const captured = await fixture.captureTurn(service, { executionRoot: worktree.root });
        await fixture.expectPorcelainEquivalent(worktree, captured);
        expect(await worktree.treePaths(`${captured.ref}^{tree}`)).toContain(
          "cone-out/excluded.txt",
        );
      } finally {
        rmSync(mainLock, { force: true });
      }

      writeFileSync(worktreeLock, "");
      try {
        expect(
          await fixture.capture(service, { executionRoot: worktree.root, turnOrdinal: 2 }),
        ).toMatchObject({ outcome: "failed", failedStep: "seed-index" });
      } finally {
        rmSync(worktreeLock, { force: true });
      }
      // Released, the main capture runs, so the refusal above was the lock's.
      await fixture.captureTurn(service, { turnOrdinal: 3 });
    },
    MULTI_SEQUENCE_CASE_TIMEOUT_MS,
  );

  it(
    "keeps staged out-of-cone content and names " +
      "untracked and intent-to-add paths in the trailer",
    async () => {
      const { repository } = fixture;
      repository.write("cone-in/kept.txt", "in cone\n");
      repository.write("cone-out/tracked.txt", "base content\n");
      await repository.git(["add", "-A"]);
      await repository.git(["commit", "-q", "-m", "sparse fixture"]);
      // Staged before the cone narrowed: the live index differs from `HEAD` there, so a seed from
      // the base would record the base's blob.
      repository.write("cone-out/tracked.txt", "staged out-of-cone content\n");
      await repository.git(["add", "--sparse", "cone-out/tracked.txt"]);
      await repository.git(["sparse-checkout", "set", "cone-in"]);
      // The two shapes the tree cannot hold, created after the cone narrowed.
      repository.write("cone-out/untracked.txt", "untracked out of cone\n");
      repository.write("cone-out/intent.txt", "intent-to-add out of cone\n");
      await repository.git(["add", "-N", "--sparse", "cone-out/intent.txt"]);

      const captured = await fixture.captureTurn(fixture.buildService());

      await fixture.expectPorcelainEquivalent(repository, captured);
      expect(
        await repository.git([
          "cat-file",
          "blob",
          `${captured.snapshotCommit}:cone-out/tracked.txt`,
        ]),
      ).toBe("staged out-of-cone content");
      // Exactly the paths a restore would otherwise delete; the tracked one has a copy in the tree.
      expect(await readTrailer(repository, captured.snapshotCommit, BOUNDARY_TRAILER)).toEqual([
        "cone-out/intent.txt",
        "cone-out/untracked.txt",
      ]);
    },
  );

  it(
    "records boundary paths byte-exactly: multibyte, a non-descended directory, and bytes that " +
      "decode alike",
    async () => {
      const { repository } = fixture;
      // `core.quotepath` C-quotes non-ASCII names in porcelain output; only `-z` listings carry
      // them verbatim. A CJK name, because APFS would normalize an accented one to NFD.
      await repository.git(["config", "core.quotepath", "true"]);
      await commitConeFixture({ "cone-in/kept.txt": "in cone\n" });
      repository.write("cone-out/日本語.txt", "multibyte out of cone\n");
      // An untracked embedded repository is one listing entry with a trailing slash, which a
      // restore reads as a whole subtree to keep.
      await createEmbeddedRepository(repository, "cone-out/nested");
      // Two injected names that share no bytes but both decode to U+FFFD: a subtraction keyed on
      // decoded strings would think the tree already holds the candidate. APFS refuses non-UTF-8
      // names, so the seam is the only way in.
      const invalidCandidate = Buffer.concat([Buffer.from("cone-out/"), Buffer.from([0xff])]);
      const invalidTreePath = Buffer.concat([Buffer.from("cone-out/"), Buffer.from([0xfe])]);
      const nul = Buffer.from([0]);
      const injectingRunner: GitRunner = async (argv, options) => {
        const result = await runGitWithExecFile(argv, options);
        const lsFilesIndex: number = argv.indexOf("ls-files");
        if (
          lsFilesIndex !== -1 &&
          argv.slice(lsFilesIndex + 1).join(" ") === "-co --exclude-per-directory=.gitignore -z"
        ) {
          return { ...result, stdout: Buffer.concat([result.stdout, invalidCandidate, nul]) };
        }
        if (argv.includes("ls-tree") && argv.includes("--name-only")) {
          return { ...result, stdout: Buffer.concat([result.stdout, invalidTreePath, nul]) };
        }
        return result;
      };

      const captured = await fixture.captureTurn(fixture.buildService({ git: injectingRunner }));

      expect(await readTrailerBytes(repository, captured.snapshotCommit, BOUNDARY_TRAILER)).toEqual(
        [
          Buffer.from("cone-out/nested/"),
          Buffer.from("cone-out/日本語.txt", "utf8"),
          invalidCandidate,
        ],
      );
      await fixture.expectPorcelainEquivalent(repository, captured);
    },
  );

  it("passes the commit message on stdin, never on the argv", async () => {
    // Windows caps a command line at 32767 characters and the boundary trailer is unbounded. An
    // argv transport keeps every object id, so only the argv shows it.
    const invocations: string[][] = [];
    await fixture.captureTurn(fixture.buildService({ git: buildRecordingRunner(invocations) }));

    const commitTree: string[] | undefined = invocations.find((argv) =>
      argv.includes("commit-tree"),
    );
    expect(commitTree?.slice(-2)).toEqual(["-F", "-"]);
    expect(commitTree).not.toContain("-m");
    expect(commitTree?.some((element) => element.includes("turn-boundary snapshot"))).toBe(false);
  });

  it(
    "keeps a root whose sparse bit is off on the full pipeline, a stale rules file " +
      "notwithstanding",
    async () => {
      const { repository } = fixture;
      // `sparse-checkout disable` clears the bit and leaves the patterns file; the worktree is
      // whole, so partitioning it would drop real content into the trailer.
      await commitConeFixture({
        "cone-in/kept.txt": "in cone\n",
        "cone-out/excluded.txt": "out of cone\n",
      });
      await repository.git(["sparse-checkout", "disable"]);
      const gitDirectory: string = await repository.git(["rev-parse", "--absolute-git-dir"]);
      expect(existsSync(join(gitDirectory, "info", "sparse-checkout"))).toBe(true);

      const captured = await fixture.captureTurn(fixture.buildService());

      expect(await readTrailer(repository, captured.snapshotCommit, BOUNDARY_TRAILER)).toBeNull();
      await fixture.expectPorcelainEquivalent(repository, captured);
    },
  );

  // A capture that cannot partition the root faithfully refuses; a partial snapshot would restore
  // with a hole in it.
  it.each<{
    readonly label: string;
    readonly failedStep: TurnSnapshotCaptureStep;
    readonly arrange?: (repository: FixtureRepository) => Promise<void>;
    readonly git?: GitRunner;
  }>([
    {
      label: "the sparse bit is set but the rules file is gone",
      failedStep: "check-sparse-rules",
      arrange: async (repository) => {
        await repository.git(["sparse-checkout", "set", "cone-in", "cone-out"]);
        const gitDirectory: string = await repository.git(["rev-parse", "--absolute-git-dir"]);
        rmSync(join(gitDirectory, "info", "sparse-checkout"));
      },
    },
    {
      label: "git is too old to know `sparse-checkout check-rules`",
      failedStep: "check-sparse-rules",
      git: buildLegFailingRunner(
        (argv) => argv.includes("check-rules"),
        "git: 'sparse-checkout check-rules' is not a git command.",
      ),
    },
    {
      label: "`core.sparseCheckout` cannot be read",
      failedStep: "detect-sparse-root",
      git: buildLegFailingRunner(
        (argv) => argv.includes("config") && argv.includes("core.sparseCheckout"),
        "fatal: unable to read config file",
      ),
    },
    {
      // Unreachable through a real merge, since git resolves sparseness first, so the stages are
      // written directly; `write-tree` refuses them as porcelain does.
      label: "an out-of-cone entry is unmerged",
      failedStep: "write-tree",
      arrange: async (repository) => {
        const conflicted = "cone-out/excluded.txt";
        const baseBlob: string = await repository.git(["rev-parse", `HEAD:${conflicted}`]);
        const oursBlob: string = await repository.git(["hash-object", "-w", "--stdin"], {
          stdin: "ours\n",
        });
        const theirsBlob: string = await repository.git(["hash-object", "-w", "--stdin"], {
          stdin: "theirs\n",
        });
        await repository.git(["update-index", "--index-info"], {
          stdin:
            `0 0000000000000000000000000000000000000000\t${conflicted}\n` +
            `100644 ${baseBlob} 1\t${conflicted}\n` +
            `100644 ${oursBlob} 2\t${conflicted}\n` +
            `100644 ${theirsBlob} 3\t${conflicted}\n`,
        });
      },
    },
  ])("fails closed at $failedStep when $label", async ({ failedStep, arrange, git }) => {
    const { repository } = fixture;
    await commitConeFixture({
      "cone-in/kept.txt": "in cone\n",
      "cone-out/excluded.txt": "out of cone\n",
    });
    await arrange?.(repository);

    const result = await fixture.capture(fixture.buildService(git === undefined ? {} : { git }));

    expect(result).toMatchObject({ outcome: "failed", failedStep });
    expect(await repository.refListing("refs/sidekicks/")).toBe("");
  });
});
