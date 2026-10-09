// Proves attach keeps one project per repository by its identity, not only by its folder: a main
// checkout whose git folder lives apart from it and that checkout's linked worktree resolve to two
// roots of one repository, and the second attach is refused inside its own write.

import { rmSync } from "node:fs";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { NodeId } from "@ai-sidekicks/contracts/runtime-node/id";

import { captureRejection } from "../../../__fixtures__/capture-failure.js";
import {
  openScratchDatabase,
  type ScratchDatabase,
} from "../../../database/__fixtures__/scratch.js";
import { EventLogService } from "../../../events/log-service.js";
import { buildFixtureEnvironment, runFixtureGit } from "../../../git/__fixtures__/command.js";
import { mintProjectId, projectRowStatement } from "../../__fixtures__/rows.js";
import { WorkspaceEventEmitter } from "../../event-emitter.js";
import { RepoAlreadyAttachedError } from "../errors.js";
import { RepoMountService } from "../mount-service.js";

vi.setConfig({ testTimeout: 60_000 });

const NODE_ID: NodeId = "node-local" as NodeId;

let fixtureRoot: string;
let database: ScratchDatabase;

beforeEach(async () => {
  fixtureRoot = await realpath(await mkdtemp(join(tmpdir(), "ai-sidekicks-mount-identity-")));
  database = await openScratchDatabase();
});

afterEach(async () => {
  await database.close();
  rmSync(fixtureRoot, { recursive: true, force: true });
});

function countRows(table: "repo_mounts" | "projects"): number {
  return database.reader.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get() as number;
}

describe("RepoMountService attach — one project per repository identity", () => {
  it("refuses a second root of a repository already attached, in the insert itself", async () => {
    const environment = buildFixtureEnvironment(fixtureRoot);
    const mainCheckout = join(fixtureRoot, "main");
    const linkedWorktree = join(fixtureRoot, "linked");
    const gitDirectory = join(fixtureRoot, "git-directory");
    await runFixtureGit(
      ["init", "-q", `--separate-git-dir=${gitDirectory}`, mainCheckout],
      environment,
      fixtureRoot,
    );
    await runFixtureGit(
      ["-C", mainCheckout, "commit", "-q", "--allow-empty", "-m", "seed"],
      environment,
      fixtureRoot,
    );
    await runFixtureGit(
      ["-C", mainCheckout, "worktree", "add", "-q", linkedWorktree],
      environment,
      fixtureRoot,
    );
    const service = new RepoMountService({
      database,
      events: new WorkspaceEventEmitter({
        sessionEvents: new EventLogService({
          writer: database.writer,
          reader: database.reader,
          writeServiceLog: (line) => {
            throw new Error(`unexpected service log line: ${line}`);
          },
        }),
      }),
      nodeId: NODE_ID,
    });

    // Both resolve while neither is attached, so only the insert's identity check is left.
    const mainTarget = await service.resolveAttachTarget({ localPath: mainCheckout });
    const linkedTarget = await service.resolveAttachTarget({ localPath: linkedWorktree });
    expect(linkedTarget.canonicalRoot).not.toBe(mainTarget.canonicalRoot);
    expect(linkedTarget.commonDir).toBe(mainTarget.commonDir);

    const firstProjectId = mintProjectId();
    const first = await service.insertAttachedMount(mainTarget, firstProjectId, [
      projectRowStatement(firstProjectId),
    ]);
    const secondProjectId = mintProjectId();
    const refusal = await captureRejection(() =>
      service.insertAttachedMount(linkedTarget, secondProjectId, [
        projectRowStatement(secondProjectId),
      ]),
    );

    expect(refusal).toBeInstanceOf(RepoAlreadyAttachedError);
    expect(refusal).toMatchObject({
      conflictingRepoMountId: first.repoMountId,
      conflictingProjectId: firstProjectId,
    });
    expect(countRows("repo_mounts")).toBe(1);
    expect(countRows("projects")).toBe(1);
  });
});
