// Making a worktree on real git: git's own judgment of a name, the repository's own hooks running
// as they do for the person, a refusal that leaves the main checkout and its branches as they
// were, and a failed ready step that leaves no live row.

import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { captureRejection } from "../../../__fixtures__/capture-failure.js";
import { EventLogService } from "../../../events/log-service.js";
import { KeyedLock } from "../../../keyed-lock.js";
import { WorktreeCreator } from "../creation.js";
import { WorktreeBranchCollisionError, WorktreeCreateFailedError } from "../errors.js";
import { WorktreeEventEmitter } from "../event-emitter.js";
import { WorktreeNaming } from "../naming.js";
import {
  FIXTURE_BRANCH_PATTERN,
  FIXTURE_PROJECT_SLUG,
  openWorktreeFixture,
  type WorktreeFixture,
} from "../__fixtures__/services.js";
import { snapshotCheckout } from "../__fixtures__/repository.js";

vi.setConfig({ testTimeout: 60_000 });

let fixture: WorktreeFixture;

beforeEach(async () => {
  fixture = await openWorktreeFixture();
});

afterEach(async () => {
  await fixture.close();
});

function readBranches(): Promise<string> {
  return fixture.repository.git([
    "for-each-ref",
    "--format=%(refname) %(objectname)",
    "refs/heads",
  ]);
}

function readLiveRows(): readonly { fs_root: string; branch_name: string }[] {
  return fixture.db
    .prepare<[], { fs_root: string; branch_name: string }>(
      `SELECT fs_root, branch_name FROM worktrees
        WHERE state NOT IN ('retired', 'failed') ORDER BY created_at, id`,
    )
    .all();
}

describe("a new worktree", () => {
  it("runs the repository's own post-checkout hook in the new tree", async () => {
    const hookPath = join(fixture.repository.root, ".git", "hooks", "post-checkout");
    writeFileSync(hookPath, "#!/bin/sh\necho ran > hook-marker\n");
    chmodSync(hookPath, 0o755);

    const created = await fixture.creator.create({
      repoMountId: fixture.repoMountId,
      sessionId: fixture.seedSession(),
      name: { kind: "tail", tail: "hooked" },
      onCollision: "refuse",
    });

    expect(readFileSync(join(created.fsRoot, "hook-marker"), "utf8")).toBe("ran\n");
  });

  it("refuses a name git refuses or a tree holds, with git's own line, changing nothing", async () => {
    const sessionId = fixture.seedSession();
    await fixture.repository.git(["branch", "release"]);
    await fixture.repository.git(["branch", "feature/taken"]);
    const live = await fixture.creator.create({
      repoMountId: fixture.repoMountId,
      sessionId,
      name: { kind: "branch", branchName: "feature/live" },
      onCollision: "refuse",
    });
    const before = await snapshotCheckout(fixture.repository, fixture.repository.root);
    const branchesBefore = await readBranches();
    const create = (branchName: string, baseRef?: string) =>
      captureRejection(() =>
        fixture.creator.create({
          repoMountId: fixture.repoMountId,
          sessionId,
          name: { kind: "branch", branchName },
          onCollision: "refuse",
          ...(baseRef === undefined ? {} : { baseRef }),
        }),
      );

    // `worktree add -b -D <path> release` would read `-D` as an option and delete `release`.
    const optionLike = await create("-D", "release");
    expect(optionLike).toBeInstanceOf(WorktreeCreateFailedError);
    expect(optionLike).toMatchObject({
      reason: "branch_name_invalid",
      message: "fatal: '-D' is not a valid branch name",
    });
    expect(await create("feature/x", "--orphan")).toMatchObject({ reason: "base_ref_option_like" });
    expect(await create("feature/taken")).toMatchObject({
      reason: "branch_name_taken",
      message: "fatal: a branch named 'feature/taken' already exists",
    });
    expect(await create("feature")).toMatchObject({ reason: "branch_name_taken" });
    expect(await create("feature/live")).toBeInstanceOf(WorktreeBranchCollisionError);

    expect(await snapshotCheckout(fixture.repository, fixture.repository.root)).toEqual(before);
    expect(await readBranches()).toBe(branchesBefore);
    expect(readLiveRows()).toEqual([{ fs_root: live.fsRoot, branch_name: "feature/live" }]);
  });

  it("marks the row failed and removes the tree when its ready step cannot be recorded", async () => {
    // The ready append fails after the row and the tree exist; a row left `creating` would hold
    // the branch in the unique index with nothing able to sweep it.
    class FailingReadyEmitter extends WorktreeEventEmitter {
      override emitWorktreeReady(): never {
        throw new Error("the ready append failed");
      }
    }
    const eventLog = new EventLogService({
      writer: fixture.scratch.writer,
      reader: fixture.scratch.reader,
      writeServiceLog: () => {},
    });
    const creator = new WorktreeCreator({
      checkoutLock: new KeyedLock<string>(),
      database: fixture.scratch,
      events: new FailingReadyEmitter({ sessionEvents: eventLog }),
      naming: new WorktreeNaming({
        worktreesDirectory: fixture.worktreesDirectory,
        sources: {
          readProjectNaming: async () => ({ slug: FIXTURE_PROJECT_SLUG, branchPattern: null }),
          readMachineBranchPattern: async () => FIXTURE_BRANCH_PATTERN,
        },
      }),
      git: fixture.repository.runner,
      writeServiceLog: () => {},
      worktrees: fixture.worktrees,
      setup: fixture.setup,
    });

    const failure = await captureRejection(() =>
      creator.create({
        repoMountId: fixture.repoMountId,
        sessionId: fixture.seedSession(),
        name: { kind: "tail", tail: "never-ready" },
        onCollision: "refuse",
      }),
    );

    expect(failure).toBeInstanceOf(Error);
    const rows = fixture.db
      .prepare<[], { state: string; fs_root: string }>("SELECT state, fs_root FROM worktrees")
      .all();
    expect(rows.map((row) => row.state)).toEqual(["failed"]);
    expect(existsSync(rows[0]?.fs_root ?? "")).toBe(false);
  });
});
