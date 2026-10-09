// The repo mount services over a scratch database with two sessions seeded, and the writes the
// mount and re-attach tests both make through them.

import { join } from "node:path";

import type { NodeId } from "@ai-sidekicks/contracts/runtime-node/id";
import type { RepoAttachResponse } from "@ai-sidekicks/contracts/repo/folders";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import {
  openScratchDatabase,
  type ScratchDatabase,
} from "../../../database/__fixtures__/scratch.js";
import { EventLogService } from "../../../events/log-service.js";
import { WorktreeEventEmitter } from "../../../git/worktree/event-emitter.js";
import { seedSessionRow } from "../../../session/directory/__fixtures__/directory-rows.js";
import { mintProjectId, projectRowStatement } from "../../__fixtures__/rows.js";
import { WorkspaceEventEmitter } from "../../event-emitter.js";
import { WorkspaceService } from "../../service.js";
import { RepoMountService } from "../mount-service.js";

/** The session seeded first, which most tests bind. */
export const SESSION_ID: SessionId = "0190f9a0-0000-7000-8000-000000000001" as SessionId;
/** The second session seeded. */
export const OTHER_SESSION_ID: SessionId = "0190f9a0-0000-7000-8000-000000000002" as SessionId;
/** The node every mount is attached on. */
export const NODE_ID: NodeId = "node-local" as NodeId;
/** The run {@link seedUnreleasedRun} seeds. */
export const RUN_ID: string = "0190f9a6-0000-7000-8000-000000000001";
const BRANCH_CONTEXT_ID: string = "0190f9a7-0000-7000-8000-000000000001";

/** Mount ids the services mint, in order; real UUIDs, since a counter would fail the schemas. */
export const MOUNT_ID_POOL: readonly string[] = [
  "0190f9a1-0000-7000-8000-000000000001",
  "0190f9a1-0000-7000-8000-000000000002",
  "0190f9a1-0000-7000-8000-000000000003",
  "0190f9a1-0000-7000-8000-000000000004",
];
const WORKSPACE_ID_POOL: readonly string[] = [
  "0190f9a2-0000-7000-8000-000000000001",
  "0190f9a2-0000-7000-8000-000000000002",
  "0190f9a2-0000-7000-8000-000000000003",
  "0190f9a2-0000-7000-8000-000000000004",
  "0190f9a2-0000-7000-8000-000000000005",
  "0190f9a2-0000-7000-8000-000000000006",
];

/** The services the tests drive, over one scratch database. */
export interface RepoMountHarness {
  readonly database: ScratchDatabase;
  readonly emitter: WorkspaceEventEmitter;
  readonly worktreeEvents: WorktreeEventEmitter;
  readonly workspaces: WorkspaceService;
  readonly service: RepoMountService;
}

/** An id source answering each of `pool` once, then throwing; `label` names it in the error. */
export function makeIdSource(pool: readonly string[], label: string): () => string {
  let index: number = 0;
  return () => {
    const value = pool[index];
    if (value === undefined) {
      throw new Error(`${label} id pool exhausted; add more UUIDs`);
    }
    index += 1;
    return value;
  };
}

/** Opens the services over a new scratch database with both sessions seeded. */
export async function openRepoMountHarness(): Promise<RepoMountHarness> {
  const database = await openScratchDatabase();
  const sessionEvents = new EventLogService({
    writer: database.writer,
    reader: database.reader,
    writeServiceLog: (line) => {
      throw new Error(`unexpected service log line: ${line}`);
    },
  });
  const emitter = new WorkspaceEventEmitter({ sessionEvents });
  const harness: RepoMountHarness = {
    database,
    emitter,
    worktreeEvents: new WorktreeEventEmitter({ sessionEvents }),
    workspaces: new WorkspaceService({
      database,
      events: emitter,
      newWorkspaceId: makeIdSource(WORKSPACE_ID_POOL, "workspace"),
    }),
    service: new RepoMountService({
      database,
      events: emitter,
      nodeId: NODE_ID,
      newRepoMountId: makeIdSource(MOUNT_ID_POOL, "repo mount"),
    }),
  };
  await seedSessionRow(database.writer, SESSION_ID);
  await seedSessionRow(database.writer, OTHER_SESSION_ID);
  return harness;
}

/** Attaches a folder as a new project's mount, the project row and the mount in one write. */
export async function attachFolder(
  harness: RepoMountHarness,
  localPath: string,
  service: RepoMountService = harness.service,
): Promise<RepoAttachResponse> {
  const target = await service.resolveAttachTarget({ localPath });
  const projectId = mintProjectId();
  return service.insertAttachedMount(target, projectId, [projectRowStatement(projectId)]);
}

/** Runs one raw statement through the writer, as another writer would. */
export function writeRaw(
  harness: RepoMountHarness,
  sql: string,
  bindings: unknown[] | Record<string, unknown>,
): Promise<void> {
  return harness.database.writer.write([{ sql, bindings }]).then(() => undefined);
}

/** Seeds {@link RUN_ID} unreleased in `workspaceId`, with the branch context its row names. */
export async function seedUnreleasedRun(
  harness: RepoMountHarness,
  workspaceId: string,
  sessionId: SessionId,
  root: string,
): Promise<void> {
  await harness.database.writer.write(unreleasedRunStatements(workspaceId, sessionId, root));
}

/** The two writes that seed {@link RUN_ID} unreleased, for a caller that sends them itself. */
export function unreleasedRunStatements(
  workspaceId: string,
  sessionId: SessionId,
  root: string,
): { readonly sql: string; readonly bindings: unknown[] }[] {
  return [
    {
      sql: `INSERT INTO branch_contexts (
         id, workspace_id, base_branch, head_branch, created_at, updated_at
       ) VALUES (?, ?, 'main', 'main', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      bindings: [BRANCH_CONTEXT_ID, workspaceId],
    },
    {
      sql: `INSERT INTO run_execution_contexts (
         run_id, session_id, workspace_id, execution_mode, execution_root, checkout_root,
         git_common_dir, branch_context_id, created_at
       ) VALUES (?, ?, ?, 'bound-root', ?, ?, ?, ?, '2026-01-01T00:00:00.000Z')`,
      bindings: [RUN_ID, sessionId, workspaceId, root, root, join(root, ".git"), BRANCH_CONTEXT_ID],
    },
  ];
}
