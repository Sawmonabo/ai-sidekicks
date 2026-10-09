// A project's edits over a real database and a real attached repository: an environment name the
// rules refuse, credential-shaped or set by the app, is refused with nothing written.

import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  APP_SET_ENVIRONMENT_NAMES,
  DAEMON_ENVIRONMENT_NAME_REFUSED_CODE,
} from "@ai-sidekicks/contracts/machine-settings";
import type { ProjectId } from "@ai-sidekicks/contracts/project";
import type { NodeId } from "@ai-sidekicks/contracts/runtime-node/id";

import {
  openSessionLog,
  type SessionLog,
} from "../../../session/directory/__fixtures__/event-log.js";
import { mintUuidV7 } from "../../../uuid-v7.js";
import { WorkspaceEventEmitter } from "../../event-emitter.js";
import { RepoMountService } from "../../repo/mount-service.js";
import type { ProjectService } from "../service.js";
import { buildTestProjectService } from "../service.test-support.js";

let log: SessionLog;
let home: string;
let projects: ProjectService;

beforeEach(async () => {
  log = await openSessionLog();
  home = await mkdtemp(path.join(tmpdir(), "aisk-project-"));
  const mounts = new RepoMountService({
    database: log.scratch,
    events: new WorkspaceEventEmitter({ sessionEvents: log.eventLog }),
    nodeId: mintUuidV7() as NodeId,
  });
  ({ projects } = buildTestProjectService({
    database: log.scratch,
    mounts,
    worktreesDirectory: path.join(home, "worktrees"),
  }));
});

afterEach(async () => {
  await log.scratch.close();
  await rm(home, { recursive: true, force: true });
});

// A repository attached as a project.
async function attachProject(): Promise<ProjectId> {
  const repository = path.join(home, "billing-api");
  await mkdir(repository);
  execFileSync("git", ["init", "--quiet", repository]);
  return (await projects.attachOrFind({ localPath: repository })).projectId;
}

interface StoredProject {
  readonly name: string;
  readonly slug: string;
  readonly environment_rows: string;
  readonly branch_pattern: string | null;
  readonly updated_at: string;
}

function projectRow(projectId: ProjectId): StoredProject {
  return log.scratch.reader
    .prepare(
      `SELECT name, slug, environment_rows, branch_pattern, updated_at
         FROM projects WHERE id = ?`,
    )
    .get(projectId) as StoredProject;
}

describe("a refused project edit", () => {
  it("refuses a credential-shaped or app-set environment name and writes nothing", async () => {
    const projectId = await attachProject();
    const before = projectRow(projectId);

    for (const name of ["DEPLOY_TOKEN", APP_SET_ENVIRONMENT_NAMES[0] ?? ""]) {
      await expect(
        projects.updateEnvironment(projectId, [
          { name: "REGION", value: "eu-west-1" },
          { name, value: "x" },
        ]),
      ).rejects.toMatchObject({ code: DAEMON_ENVIRONMENT_NAME_REFUSED_CODE, detail: { name } });
    }

    expect(projectRow(projectId)).toStrictEqual(before);
  });
});
