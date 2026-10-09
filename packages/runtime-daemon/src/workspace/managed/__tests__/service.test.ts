// A chat's managed workspace is made as a git repository with exactly one managed mount row and
// none of the person's template hooks, a second make for the same chat leaves the first whole, a
// failed make leaves nothing behind, and a delete takes the folder and every row naming it. Real
// git, folders and SQLite.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { NodeId } from "@ai-sidekicks/contracts/runtime-node/id";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import {
  openScratchDatabase,
  type ScratchDatabase,
} from "../../../database/__fixtures__/scratch.js";
import { EventLogService } from "../../../events/log-service.js";
import { captureRejection } from "../../../__fixtures__/capture-failure.js";
import { buildFixtureEnvironment, runFixtureGit } from "../../../git/__fixtures__/command.js";
import { runGitWithExecFile, type GitRunner } from "../../../git/process.js";
import { seedSessionRow } from "../../../session/directory/__fixtures__/directory-rows.js";
import { WorkspaceEventEmitter } from "../../event-emitter.js";
import { RepoAlreadyAttachedError } from "../../repo/errors.js";
import { RepoMountService } from "../../repo/mount-service.js";
import { WorkspaceService } from "../../service.js";
import { ManagedWorkspaceService, managedWorkspacesDirectoryOf } from "../service.js";

const SESSION_ID = "0190f9c0-0000-7000-8000-000000000001" as SessionId;
const NODE_ID = "node-local" as NodeId;
const SIMULATED_GIT_FAILURE = "simulated git init failure";

interface ManagedMountRow {
  readonly id: string;
  readonly canonical_root: string;
  readonly origin: string;
  readonly managed_session_id: string | null;
  readonly state: string;
}

let database: ScratchDatabase;
let homeDirectory: string;
let repoMounts: RepoMountService;
let fixtureGit: GitRunner;

beforeEach(async () => {
  database = await openScratchDatabase();
  homeDirectory = mkdtempSync(join(tmpdir(), "ai-sidekicks-managed-workspace-"));
  repoMounts = new RepoMountService({
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
  fixtureGit = gitUnder();
});

// The daemon's runner under an environment no developer git setting reaches but `overrides`.
function gitUnder(overrides: Readonly<Record<string, string>> = {}): GitRunner {
  const environment = buildFixtureEnvironment(homeDirectory, overrides);
  const environmentOverrides = Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  return (argv, options) => runGitWithExecFile(argv, { ...options, environmentOverrides });
}

afterEach(async () => {
  await database.close();
  rmSync(homeDirectory, { recursive: true, force: true });
});

function buildService(git: GitRunner = fixtureGit): ManagedWorkspaceService {
  return new ManagedWorkspaceService({ homeDirectory, repoMounts, git });
}

function readMountRows(): readonly ManagedMountRow[] {
  return database.reader
    .prepare(
      "SELECT id, canonical_root, origin, managed_session_id, state FROM repo_mounts ORDER BY id",
    )
    .all() as readonly ManagedMountRow[];
}

// A branch context on the workspace and a run's execution root naming both, as a run leaves them.
async function seedRunExecutionContext(workspaceId: string, executionRoot: string): Promise<void> {
  const at = "2026-10-07T00:00:00.000Z";
  await database.writer.write([
    {
      sql: `INSERT INTO branch_contexts (id, workspace_id, base_branch, head_branch, created_at,
                                         updated_at)
            VALUES ('branch-context-1', ?, 'main', 'main', ?, ?)`,
      bindings: [workspaceId, at, at],
    },
    {
      sql: `INSERT INTO run_execution_contexts (run_id, session_id, workspace_id, execution_mode,
                                                execution_root, checkout_root, git_common_dir,
                                                branch_context_id, created_at)
            VALUES ('run-1', ?, ?, 'bound-root', ?, ?, ?, 'branch-context-1', ?)`,
      bindings: [
        SESSION_ID,
        workspaceId,
        executionRoot,
        executionRoot,
        join(executionRoot, ".git"),
        at,
      ],
    },
  ]);
}

function workspacePathOf(sessionId: SessionId): string {
  return join(realpathSync(managedWorkspacesDirectoryOf(homeDirectory)), sessionId);
}

describe("ManagedWorkspaceService.create", () => {
  it("makes the folder a git repository and registers one managed mount for the chat", async () => {
    const created = await buildService().create({ sessionId: SESSION_ID });

    expect(created.path).toBe(workspacePathOf(SESSION_ID));
    const toplevel = await runFixtureGit(
      ["-C", created.path, "rev-parse", "--show-toplevel"],
      buildFixtureEnvironment(homeDirectory),
      created.path,
    );
    expect(realpathSync(toplevel.trim())).toBe(created.path);
    expect(readMountRows()).toEqual([
      {
        id: created.repoMountId,
        canonical_root: created.path,
        origin: "managed",
        managed_session_id: SESSION_ID,
        state: "attached",
      },
    ]);
  });

  it("copies none of the person's template hooks into the chat's repository", async () => {
    // A template folder holding a hook, named both ways git reads one besides `--template`.
    const templateFolder = join(homeDirectory, "person-template");
    mkdirSync(join(templateFolder, "hooks"), { recursive: true });
    writeFileSync(join(templateFolder, "hooks", "pre-commit"), "#!/bin/sh\nexit 1\n");
    chmodSync(join(templateFolder, "hooks", "pre-commit"), 0o755);
    const globalConfig = join(homeDirectory, "person-gitconfig");
    writeFileSync(globalConfig, `[init]\n\ttemplateDir = ${templateFolder}\n`);

    const created = await buildService(
      gitUnder({ GIT_CONFIG_GLOBAL: globalConfig, GIT_TEMPLATE_DIR: templateFolder }),
    ).create({ sessionId: SESSION_ID });

    expect(existsSync(join(created.path, ".git", "HEAD"))).toBe(true);
    const hooksFolder = join(created.path, ".git", "hooks");
    expect(existsSync(hooksFolder) ? readdirSync(hooksFolder) : []).toEqual([]);
  });

  it("refuses a second create for the chat and leaves the first workspace whole", async () => {
    const service = buildService();
    const first = await service.create({ sessionId: SESSION_ID });
    const notePath = join(first.path, "notes.md");
    writeFileSync(notePath, "kept\n");

    const refusal = await captureRejection(() => service.create({ sessionId: SESSION_ID }));

    expect(refusal).toBeInstanceOf(RepoAlreadyAttachedError);
    expect(readMountRows().map((row) => row.id)).toEqual([first.repoMountId]);
    expect(readFileSync(notePath, "utf8")).toBe("kept\n");
    expect(existsSync(join(first.path, ".git", "HEAD"))).toBe(true);
  });

  it("removes the folder and the mount row when git init fails", async () => {
    const failingGit: GitRunner = () => Promise.reject(new Error(SIMULATED_GIT_FAILURE));

    const failure = await captureRejection(() =>
      buildService(failingGit).create({ sessionId: SESSION_ID }),
    );

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(SIMULATED_GIT_FAILURE);
    expect(existsSync(workspacePathOf(SESSION_ID))).toBe(false);
    expect(readMountRows()).toEqual([]);
  });
});

describe("ManagedWorkspaceService.delete", () => {
  it("deletes the folder whole, its mount row and every row on it", async () => {
    const service = buildService();
    const created = await service.create({ sessionId: SESSION_ID });
    writeFileSync(join(created.path, "draft.md"), "gone\n");
    // The chat's workspace names the mount, and a branch context and a run's execution root name
    // the workspace, so with foreign keys on, each must go before what it names.
    await seedSessionRow(database.writer, SESSION_ID, "chat");
    const { workspaceId } = await new WorkspaceService({
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
    }).bind({
      sessionId: SESSION_ID,
      repoMountId: created.repoMountId,
      executionMode: "bound-root",
    });
    await seedRunExecutionContext(workspaceId, created.path);

    await service.delete({ sessionId: SESSION_ID });

    expect(existsSync(created.path)).toBe(false);
    expect(readMountRows()).toEqual([]);
    for (const table of ["workspaces", "branch_contexts", "run_execution_contexts"]) {
      expect(
        database.reader.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get(),
        table,
      ).toEqual({ total: 0 });
    }
  });
});
