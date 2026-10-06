// Turn-snapshot capture over real git: a capture records exactly what `git add -A` would stage,
// never touches the user's index, branches or hooks, and never fails the turn. A case wraps the
// production git seam only to inject a fault or a race.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { drainMicrotasks } from "../../../provider/__fixtures__/drain-microtasks.js";
import { runGitWithExecFile, type GitRunner } from "../../process.js";
import type { TurnSnapshotCaptureResult } from "../service.js";
import type { TurnSnapshotCaptureStep, TurnSnapshotDiagnostic } from "../diagnostics.js";
import {
  buildLegFailingRunner,
  buildRecordingRunner,
  createEmbeddedRepository,
  expectCaptured,
  FIRST_TURN_REF,
  initEmbeddedRepository,
  MULTI_SEQUENCE_CASE_TIMEOUT_MS,
  ORDINARY_CASE_TIMEOUT_MS,
  readTrailer,
  RUN_ID,
  TurnSnapshotFixture,
} from "./service.test-support.js";

vi.setConfig({ testTimeout: ORDINARY_CASE_TIMEOUT_MS });

let fixture: TurnSnapshotFixture;

beforeEach(async () => {
  fixture = await TurnSnapshotFixture.create();
});

afterEach(() => {
  fixture.remove();
});

describe("TurnSnapshotService.captureTurnSnapshot", () => {
  it("stages exactly what `git add -A` would, from the worktree as it stands", async () => {
    const { repository } = fixture;
    fixture.applyTurnEffects();
    // The project's own attributes govern both legs, so equivalence must hold on a converted path.
    repository.write(".gitattributes", "*.txt text\n");
    repository.write("converted.txt", "alpha\r\nbeta\r\n");
    const embeddedHead: string = await createEmbeddedRepository(repository, "embedded");

    const captured = await fixture.captureTurn(fixture.buildService());

    await fixture.expectPorcelainEquivalent(repository, captured);
    const tree = `${captured.ref}^{tree}`;
    const paths: readonly string[] = await repository.treePaths(tree);
    expect(paths).toEqual(
      expect.arrayContaining([
        ".gitignore",
        "created.txt",
        "nested/deep/created.txt",
        "tracked-but-ignored.txt",
      ]),
    );
    expect(paths).not.toContain("doomed.txt");
    expect(paths).not.toContain("ignored-file.txt");
    expect(paths).not.toContain("ignored-dir/artifact.bin");
    expect(await repository.git(["show", `${tree}:tracked.txt`])).toBe(
      "tracked v2 — modified during the turn",
    );
    expect(await repository.git(["cat-file", "-p", `${tree}:converted.txt`])).toBe("alpha\nbeta");
    // `ls-files -o` names an embedded repository as one directory entry that `update-index --add`
    // drops; it must come back as the gitlink porcelain records.
    expect(await repository.git(["ls-tree", tree, "embedded"])).toBe(
      `160000 commit ${embeddedHead}\tembedded`,
    );
  });

  it("leaves the user's branches, HEAD, staged work and worktree untouched", async () => {
    const { repository } = fixture;
    fixture.applyTurnEffects();
    // Staged work mid-turn, which a scratch index that leaked into the real one would discard.
    await repository.git(["add", "tracked.txt", "created.txt"]);
    expect(await repository.git(["diff", "--cached", "--name-only"])).toBe(
      "created.txt\ntracked.txt",
    );
    const branchesBefore: string = await repository.refListing("refs/heads/");
    const headBefore: string = await repository.git(["rev-parse", "HEAD"]);
    const statusBefore: string = await repository.git(["status", "--porcelain"]);

    const captured = await fixture.captureTurn(fixture.buildService());

    expect(await repository.refListing()).toBe(
      `${branchesBefore}\n${captured.snapshotCommit} ${captured.ref}`,
    );
    expect(await repository.git(["branch", "--contains", captured.snapshotCommit])).toBe("");
    expect(await repository.git(["symbolic-ref", "HEAD"])).toBe("refs/heads/main");
    expect(await repository.git(["rev-parse", "HEAD"])).toBe(headBefore);
    expect(await repository.git(["status", "--porcelain"])).toBe(statusBefore);
    expect(fixture.scratchIndexEntries()).toEqual([]);
  });

  it(
    "parents the run's epoch ref at the base resolved " +
      "on entry, even when HEAD moves mid-capture",
    async () => {
      const { repository } = fixture;
      fixture.applyTurnEffects();
      const base: string = await repository.git(["rev-parse", "HEAD"]);
      // The branch moves between `read-tree` and `commit-tree`; resolving `HEAD` twice would pair
      // an old tree with a new parent, and a later diff would undo the landed commit's files.
      let advanced = false;
      const advancingRunner: GitRunner = async (argv, options) => {
        const result = await runGitWithExecFile(argv, options);
        if (!advanced && argv.includes("read-tree")) {
          advanced = true;
          await repository.git(["commit", "-q", "--allow-empty", "-m", "landed mid-capture"]);
        }
        return result;
      };

      const captured = await fixture.captureTurn(fixture.buildService({ git: advancingRunner }));

      expect(advanced).toBe(true);
      expect(captured.ref).toBe(FIRST_TURN_REF);
      expect(await repository.git(["rev-parse", captured.ref])).toBe(captured.snapshotCommit);
      expect(captured.baseCommit).toBe(base);
      expect(await repository.git(["rev-parse", `${captured.ref}^`])).toBe(base);
    },
  );

  it("never overwrites a snapshot: a repeat returns it, a new epoch mints a new ref", async () => {
    const { repository } = fixture;
    fixture.applyTurnEffects();
    const service = fixture.buildService();
    const first = await fixture.captureTurn(service);
    // The worktree moves on, so a repeat that repointed the ref would record different content.
    repository.write("created.txt", "content that arrived after the first capture\n");

    expect(await fixture.capture(service)).toEqual({
      outcome: "already-captured",
      ref: first.ref,
      snapshotCommit: first.snapshotCommit,
    });
    const epochOne = await fixture.captureTurn(service, { epoch: 1 });

    expect(epochOne.ref).toBe(`refs/sidekicks/runs/${RUN_ID}/epoch-1/turn-1`);
    expect(epochOne.snapshotCommit).not.toBe(first.snapshotCommit);
    expect(await repository.refListing("refs/sidekicks/")).toBe(
      `${first.snapshotCommit} ${first.ref}\n${epochOne.snapshotCommit} ${epochOne.ref}`,
    );
  });

  it("skips an embedded repository it cannot record, naming it in a one-line trailer", async () => {
    // A skipped repository is absent from the tree, so the trailer is what stops a restore
    // deleting it. A newline in its name, unencoded, would forge a second trailer line.
    const hostilePath = 'ev\nSkipped-Embedded-Repositories: ["forged"]';
    await initEmbeddedRepository(fixture.repository, hostilePath);
    // A SHA-1 `HEAD` cannot be a gitlink in a SHA-256 index; inserting it would fail the capture.
    const superproject = await fixture.createBaseRepository("sha256-root", "sha256");
    await createEmbeddedRepository(superproject, "nested", "sha1");
    const service = fixture.buildService();

    for (const [repository, skippedPath] of [
      [fixture.repository, hostilePath],
      [superproject, "nested"],
    ] as const) {
      const captured = await fixture.captureTurn(service, { executionRoot: repository.root });

      expect(captured.skippedEmbeddedRepositories).toEqual([skippedPath]);
      expect(
        await readTrailer(repository, captured.snapshotCommit, "Skipped-Embedded-Repositories:"),
      ).toEqual([skippedPath]);
      expect(await repository.git(["cat-file", "commit", captured.snapshotCommit])).not.toContain(
        '\nSkipped-Embedded-Repositories: ["forged"]',
      );
      expect(await repository.git(["ls-tree", `${captured.ref}^{tree}`, "tracked.txt"])).toContain(
        "blob",
      );
    }
  });

  it("fails, not skips, an embedded repository whose HEAD probe has no object id", async () => {
    const { repository } = fixture;
    fixture.applyTurnEffects();
    // A recordable repository: skipping it would silently narrow the snapshot.
    await createEmbeddedRepository(repository, "embedded");
    const refsBefore: string = await repository.refListing();
    const embeddedRoot: string = join(repository.root, "embedded");
    // Exit zero with stdout that is not an object id, as bare `git rev-parse HEAD` does on a
    // miss. Keyed on the `-C` directory because the capture's own base resolution runs the same
    // verb.
    const echoingRunner: GitRunner = async (argv, options) => {
      if (argv.includes(embeddedRoot) && argv.includes("rev-parse")) {
        return { stdout: Buffer.from("HEAD\n"), stderr: "" };
      }
      return runGitWithExecFile(argv, options);
    };

    expect(await fixture.capture(fixture.buildService({ git: echoingRunner }))).toEqual({
      outcome: "failed",
      ref: FIRST_TURN_REF,
      failedStep: "normalize-embedded-repositories",
    });
    expect(await repository.refListing()).toBe(refsBefore);
  });

  it("seeds from the base commit itself, past a replace ref planted on it", async () => {
    const { repository } = fixture;
    fixture.applyTurnEffects();
    const baseCommit: string = await repository.git(["rev-parse", "HEAD"]);
    // The replacement drops a tracked-and-ignored path, the one class `ls-files -o` never re-lists,
    // so a seed that followed the replace ref would lose it from the snapshot silently.
    const attackerEnvironment = { GIT_INDEX_FILE: join(fixture.fixtureRoot, "attacker.index") };
    await repository.git(["read-tree", baseCommit], { environmentOverrides: attackerEnvironment });
    await repository.git(["update-index", "--force-remove", "tracked-but-ignored.txt"], {
      environmentOverrides: attackerEnvironment,
    });
    const attackerTree: string = await repository.git(["write-tree"], {
      environmentOverrides: attackerEnvironment,
    });
    const attackerCommit: string = await repository.git(["commit-tree", attackerTree, "-m", "x"]);
    await repository.git(["update-ref", `refs/replace/${baseCommit}`, attackerCommit]);

    const captured = await fixture.captureTurn(fixture.buildService());

    expect(
      await repository.git(["ls-tree", `${captured.ref}^{tree}`, "tracked-but-ignored.txt"]),
    ).toContain("blob");
    expect(captured.baseCommit).toBe(baseCommit);
  });

  it(
    "captures the same snapshot whatever the host's git config says",
    async () => {
      const { repository } = fixture;
      fixture.applyTurnEffects();
      repository.write("crlf.txt", "line one\r\nline two\r\n");
      const excludesFile: string = join(fixture.fixtureRoot, "host-excludes");
      writeFileSync(excludesFile, "created.txt\n");
      const service = fixture.buildService();
      const baseline = await fixture.captureTurn(service);

      // Unpinned, each would change what is recorded: CRLF bytes re-hashed as LF, an `encoding`
      // header in the commit, and project files dropped for matching a developer's private ignores.
      const hostSettings: readonly (readonly [string, string])[] = [
        ["core.autocrlf", "true"],
        ["i18n.commitEncoding", "ISO-8859-1"],
        ["core.excludesFile", excludesFile],
      ];
      for (const [index, [key, value]] of hostSettings.entries()) {
        await repository.git(["config", key, value]);
        const underSetting = await fixture.captureTurn(service, { turnOrdinal: index + 2 });
        expect(underSetting.snapshotCommit, key).toBe(baseline.snapshotCommit);
        await repository.git(["config", "--unset", key]);
      }

      // `core.safecrlf` would make staging fatal over a project attribute that converts CRLF. The
      // capture still runs, and the project's conversion still applies.
      repository.write(".gitattributes", "*.txt text\n");
      await repository.git(["add", ".gitattributes"]);
      await repository.git(["commit", "-q", "-m", "in-tree attributes"]);
      await repository.git(["config", "core.safecrlf", "true"]);
      const underSafecrlf = await fixture.captureTurn(service, { turnOrdinal: 9 });
      expect(await repository.git(["cat-file", "-p", `${underSafecrlf.ref}^{tree}:crlf.txt`])).toBe(
        "line one\nline two",
      );
      expect(readFileSync(join(repository.root, "crlf.txt"), "utf8")).toBe(
        "line one\r\nline two\r\n",
      );
    },
    MULTI_SEQUENCE_CASE_TIMEOUT_MS,
  );

  it(
    "resolves every fault to a typed result that " +
      "publishes nothing and never throws into the turn",
    async () => {
      const { repository } = fixture;
      fixture.applyTurnEffects();
      const refsBefore: string = await repository.refListing();
      // A sink that throws, or rejects a promise nobody holds, would otherwise turn an
      // observability fault into a thrown capture or an unhandled rejection that takes the daemon
      // down.
      const sinks = {
        recording: (): void => undefined,
        throwing: (): void => {
          throw new Error("induced sink failure");
        },
        rejecting: (): Promise<void> => Promise.reject(new Error("induced exporter failure")),
      };
      // An `update-ref` failure is `write-ref`, never `already-captured`, which would hand out the
      // object id of a snapshot that does not exist.
      const rows: readonly {
        readonly failingLeg: string;
        readonly failedStep: TurnSnapshotCaptureStep;
        readonly sink: keyof typeof sinks;
      }[] = [
        { failingLeg: "write-tree", failedStep: "write-tree", sink: "recording" },
        { failingLeg: "update-ref", failedStep: "write-ref", sink: "recording" },
        { failingLeg: "write-tree", failedStep: "write-tree", sink: "throwing" },
        { failingLeg: "write-tree", failedStep: "write-tree", sink: "rejecting" },
      ];

      for (const row of rows) {
        const label = `${row.failingLeg} with a ${row.sink} sink`;
        const observed: TurnSnapshotDiagnostic[] = [];
        const service = fixture.buildService({
          git: buildLegFailingRunner(
            (argv) => argv.includes(row.failingLeg),
            `induced ${row.failingLeg} failure`,
          ),
          emitDiagnostic: (diagnostic) => {
            observed.push(diagnostic);
            return sinks[row.sink]();
          },
        });

        const result = await fixture.capture(service);
        await drainMicrotasks();

        expect(result, label).toEqual({
          outcome: "failed",
          ref: FIRST_TURN_REF,
          failedStep: row.failedStep,
        });
        expect(observed, label).toEqual([
          expect.objectContaining({
            kind: "capture-failed",
            failedStep: row.failedStep,
            detail: `induced ${row.failingLeg} failure`,
          }),
        ]);
      }
      expect(await repository.refListing()).toBe(refsBefore);
      expect(fixture.scratchIndexEntries()).toEqual([]);

      // A failed scratch-index removal after a good capture keeps the capture and is diagnosed.
      const cleanupFailure = new Error("EPERM: operation not permitted, unlink");
      const captured = await fixture.captureTurn(
        fixture.buildService({
          filesystem: {
            createDirectory: (path: string): Promise<void> => {
              mkdirSync(path, { recursive: true });
              return Promise.resolve();
            },
            removePath: (): Promise<void> => Promise.reject(cleanupFailure),
          },
        }),
      );
      expect(await repository.git(["rev-parse", captured.ref])).toBe(captured.snapshotCommit);
      expect(fixture.scratchIndexEntries()).toHaveLength(1);
      expect(fixture.diagnostics).toEqual([
        expect.objectContaining({
          kind: "scratch-index-cleanup-failed",
          detail: cleanupFailure.message,
        }),
      ]);
    },
  );

  it("refuses every unusable ref component before any git call", async () => {
    const { repository } = fixture;
    const refsBefore: string = await repository.refListing();
    const invocations: string[][] = [];
    const service = fixture.buildService({ git: buildRecordingRunner(invocations) });
    // The guard is a disjunction, so every arm gets a row. Git refuses some of these itself, but a
    // refusal from git is a swallowed capture failure, not a typed refusal. Git accepts a trailing
    // dot and `.LOCK`; Windows strips the dot and case-insensitive filesystems fold `.LOCK` onto a
    // sibling ref's lock file.
    const rows: readonly {
      readonly runId?: string;
      readonly epoch?: number;
      readonly turnOrdinal?: number;
    }[] = [
      { runId: "../../heads/main" },
      { runId: "run/1" },
      { runId: "-run" },
      { runId: "" },
      { runId: "run@{0}" },
      { runId: "run..1" },
      { runId: "run.lock" },
      { runId: "run." },
      { runId: "run.LOCK" },
      { epoch: -1 },
      { epoch: 1.5 },
      { turnOrdinal: -3 },
      { turnOrdinal: Number.NaN },
    ];

    for (const row of rows) {
      expect(await fixture.capture(service, row), JSON.stringify(row)).toEqual({
        outcome: "failed",
        ref: null,
        failedStep: "validate-inputs",
      });
    }

    expect(invocations).toEqual([]);
    expect(await repository.refListing()).toBe(refsBefore);
  });

  it("captures into the execution root under a hijacked ambient git environment", async () => {
    const { repository } = fixture;
    fixture.applyTurnEffects();
    const decoyRepository: string = join(fixture.fixtureRoot, "decoy.git");
    const hijackedObjectDirectory: string = join(fixture.fixtureRoot, "hijacked-objects");
    await repository.git(["init", "-q", "--bare", "-b", "main", decoyRepository], {
      cwd: fixture.fixtureRoot,
    });
    // `GIT_DIR` wins over `-C`, so an unstripped one writes the snapshot into the decoy's store;
    // `GIT_OBJECT_DIRECTORY` alone makes git refuse discovery, so the capture would record nothing.
    let result: TurnSnapshotCaptureResult;
    try {
      vi.stubEnv("GIT_DIR", decoyRepository);
      vi.stubEnv("GIT_OBJECT_DIRECTORY", hijackedObjectDirectory);
      result = await fixture.capture(fixture.buildService());
    } finally {
      vi.unstubAllEnvs();
    }

    const captured = expectCaptured(result);
    expect(await repository.refListing("refs/sidekicks/")).toBe(
      `${captured.snapshotCommit} ${captured.ref}`,
    );
    expect(
      await repository.git(["--git-dir", decoyRepository, "for-each-ref", "--format=%(refname)"]),
    ).toBe("");
    expect(existsSync(hijackedObjectDirectory)).toBe(false);
  });

  it("never writes a branch through a dangling symref squatting the capture path", async () => {
    const { repository } = fixture;
    fixture.applyTurnEffects();
    // The turn path is predictable from inside the run. Git moves a create-only ref update's
    // must-not-exist check to a symref's referent, so a dangling one would let the write land on
    // `refs/heads/evil` and report success.
    const hostileBranch = "refs/heads/evil";
    await repository.git(["symbolic-ref", FIRST_TURN_REF, hostileBranch]);
    const headsBefore: string = await repository.refListing("refs/heads/");
    expect(headsBefore).not.toContain(hostileBranch);

    const result = await fixture.capture(fixture.buildService());

    expect(await repository.refListing("refs/heads/")).toBe(headsBefore);
    expect(
      (await repository.gitCapturing(["rev-parse", "--verify", hostileBranch])).exitCode,
    ).not.toBe(0);
    // Git versions differ here: some replace the planted pointer with an ordinary snapshot ref,
    // others refuse over the dangling symref. Either stays inside the run's namespace.
    if (result.outcome === "captured") {
      expect(result.ref).toBe(FIRST_TURN_REF);
      expect(await repository.refListing()).toBe(
        `${headsBefore}\n${result.snapshotCommit} ${FIRST_TURN_REF}`,
      );
    } else {
      expect(result).toEqual({ outcome: "failed", ref: FIRST_TURN_REF, failedStep: "write-ref" });
      expect(await repository.git(["symbolic-ref", FIRST_TURN_REF])).toBe(hostileBranch);
    }
  });

  it("neutralizes repository hooks on every git call, embedded repositories included", async () => {
    const { repository } = fixture;
    fixture.applyTurnEffects();
    await createEmbeddedRepository(repository, "embedded");
    const invocations: string[][] = [];

    await fixture.captureTurn(fixture.buildService({ git: buildRecordingRunner(invocations) }));

    // A mounted repository's hooks and fsmonitor are its own code; one missing pin runs it.
    const neutralizationDirectory: string = join(
      fixture.executionRootsDirectory,
      ".hook-neutralization",
    );
    expect(invocations.some((argv) => argv.includes(join(repository.root, "embedded")))).toBe(true);
    for (const argv of invocations) {
      expect(argv.slice(0, 4)).toEqual([
        "-c",
        `core.hooksPath=${neutralizationDirectory}`,
        "-c",
        "core.fsmonitor=false",
      ]);
    }
  });

  // Mode bits need POSIX.
  it.skipIf(process.platform === "win32")(
    "keeps a tracked file's recorded executable bit under core.fileMode=false",
    async () => {
      const { repository } = fixture;
      repository.write("tool.sh", "#!/bin/sh\necho tool\n");
      chmodSync(join(repository.root, "tool.sh"), 0o755);
      await repository.git(["add", "-A"]);
      await repository.git(["commit", "-q", "-m", "exec base"]);
      // The disk drops the bit and the host says disk modes are untrusted. A `core.fileMode=true`
      // pin would let lstat outrank the recorded mode and a restore would clear the bit.
      chmodSync(join(repository.root, "tool.sh"), 0o644);
      await repository.git(["config", "core.fileMode", "false"]);

      const captured = await fixture.captureTurn(fixture.buildService());

      expect(await repository.git(["ls-tree", `${captured.ref}^{tree}`, "tool.sh"])).toContain(
        "100755 blob",
      );
    },
  );
});
