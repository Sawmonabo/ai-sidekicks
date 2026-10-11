// The whole-session purge deletes each provider's own copy of the session's conversations, removes
// a chat's managed workspace folder and then deletes every row
// naming the session outright, in foreign-key order, re-scores the related lists it leaves behind,
// tells the live list whatever happens to the receipt, refuses a session whose range the receipt
// could not name, can be run again after any failure to finish, leaves no copy of the content in
// the database file or its write-ahead log, truncating it every time and trying again a bounded
// number of times while a reader keeps it busy, keeps every worktree folder and the rows of those
// still on disk, waits for the session lock, and never runs inside an append-lock hold. A run's
// rows go whether its log, its `runs` row or its execution root names it.

import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DAEMON_SCOPE_SENTINEL_SESSION_ID } from "@ai-sidekicks/contracts/event/envelope";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import type { DatabaseWriter } from "../../../database/writer.js";
import { sessionAppendLock } from "../append-lock.js";
import { recordedSessionLinkStatement } from "../../../session/links/recorded.js";
import { managedWorkspacesDirectoryOf } from "../../../workspace/managed/service.js";
import type { SessionPurgeEventLog, SessionPurgeOutcome } from "../purge.js";
import {
  onlyOutcome,
  PurgeFixture,
  PURGE_INSTANT,
  RecordingEventLog,
  SECOND_SESSION,
  SESSION,
  THIRD_SESSION,
} from "./purge.test-support.js";

let fixture: PurgeFixture;

beforeEach(async () => {
  fixture = await PurgeFixture.open();
});

afterEach(async () => {
  await fixture.close();
});

describe("SessionPurge — the whole session", () => {
  it("deletes every purgeable row and snapshot, sparing maintenance rows and others", async () => {
    const first = await fixture.seedMessage("hi");
    const maintenance = await fixture.seed({
      category: "event_maintenance",
      type: "event.compacted",
      payload: { ok: true },
    });
    const newest = await fixture.seedMessage("yo");
    const snapshot = await fixture.seedSnapshot(SESSION, newest.sequence);
    const otherSession = await fixture.seedMessage("kept", SECOND_SESSION);
    const otherSnapshot = await fixture.seedSnapshot(SECOND_SESSION, otherSession.sequence);

    const eventLog = new RecordingEventLog();
    const result = await fixture.buildPurge({ eventLog }).purge([SESSION]);
    const outcome = onlyOutcome(result);

    expect(result.refusedReason).toBeUndefined();
    expect(outcome.refusedReason).toBeUndefined();
    expect(outcome.rowsDeleted).toBe(2);
    expect(outcome.fromSequence).toBe(first.sequence);
    expect(outcome.toSequence).toBe(newest.sequence);

    expect(fixture.rowExists("session_events", first.id)).toBe(false);
    expect(fixture.rowExists("session_events", newest.id)).toBe(false);
    expect(fixture.rowExists("session_snapshots", snapshot)).toBe(false);
    expect(fixture.rowExists("session_events", maintenance.id)).toBe(true);
    expect(fixture.rowExists("session_events", otherSession.id)).toBe(true);
    expect(fixture.rowExists("session_snapshots", otherSnapshot)).toBe(true);

    // One receipt, bound to the sentinel, naming the deleted range.
    expect(eventLog.appended).toHaveLength(1);
    expect(eventLog.appended[0]?.sessionId).toBe(DAEMON_SCOPE_SENTINEL_SESSION_ID);
    expect(eventLog.appended[0]?.category).toBe("event_maintenance");
    expect(eventLog.appended[0]?.type).toBe("event.compacted");
    expect(eventLog.appended[0]?.payload.removedSessions).toEqual([
      { sessionId: SESSION, fromSeq: first.sequence, toSeq: newest.sequence },
    ]);
  });
});

describe("SessionPurge — the session's directory rows and managed workspace", () => {
  it("deletes every row naming the session, the group it empties and its workspace", async () => {
    // The purged session is a converted chat: its managed workspace and its project's checkout.
    await fixture.scratch.writer.write([
      {
        sql: `INSERT INTO projects (id, name, slug, folder_path, state, setup, created_at,
                                    updated_at)
              VALUES ('project-1', 'Project', 'project', '/repos/project', 'active', '{}', ?, ?)`,
        bindings: [PURGE_INSTANT, PURGE_INSTANT],
      },
      {
        sql: `INSERT INTO repo_mounts (id, node_id, local_path, canonical_root, project_id,
                                       attached_at, updated_at)
              VALUES ('project-1', 'node-1', '/repos/project', '/repos/project', 'project-1', ?, ?)`,
        bindings: [PURGE_INSTANT, PURGE_INSTANT],
      },
      {
        sql: `INSERT INTO session_groups (id, project_id, name, name_folded, created_at)
              VALUES ('group-emptied', 'project-1', 'Emptied', 'emptied', ?),
                     ('group-kept', 'project-1', 'Kept', 'kept', ?)`,
        bindings: [PURGE_INSTANT, PURGE_INSTANT],
      },
    ]);
    await fixture.seedSessionRow(SESSION, "group-emptied");
    await fixture.seedSessionRow(SECOND_SESSION, "group-kept");
    await fixture.seedSessionRow(THIRD_SESSION, "group-kept");
    await fixture.seedMessage("hi");
    // A run the log names, one only its execution root names, and one only its `runs` row names,
    // as a run the rebuild reached but whose events a damaged row hides, each with a steer.
    await fixture.seed({
      category: "run_lifecycle",
      type: "run.running",
      payload: { runId: "run-logged" },
    });
    const purgedWorkspace = await fixture.managedWorkspaces.create({ sessionId: SESSION });
    const keptWorkspace = await fixture.managedWorkspaces.create({ sessionId: SECOND_SESSION });
    await fixture.seedBoundRun({
      sessionId: SESSION,
      repoMountId: purgedWorkspace.repoMountId,
      workspaceId: "workspace-chat",
      runId: "run-chat",
    });
    await fixture.seedBoundRun({
      sessionId: SESSION,
      repoMountId: "project-1",
      workspaceId: "workspace-project",
      runId: "run-project",
    });
    await fixture.seedBoundRun({
      sessionId: SECOND_SESSION,
      repoMountId: keptWorkspace.repoMountId,
      workspaceId: "workspace-kept",
      runId: "run-kept",
    });
    await fixture.seedRowsNamingSession(SESSION, ["run-logged", "run-project", `run-${SESSION}`]);
    await fixture.seedRowsNamingSession(SECOND_SESSION, ["run-kept"]);
    for (const sessionId of [SESSION, SECOND_SESSION]) {
      await fixture.scratch.writer.write([
        {
          sql: `INSERT INTO runs (run_id, session_id, state, run_version)
                VALUES (?, ?, 'running', 2)`,
          bindings: [`run-${sessionId}`, sessionId],
        },
        {
          sql: "INSERT INTO session_console_state (session_id, updated_at) VALUES (?, ?)",
          bindings: [sessionId, PURGE_INSTANT],
        },
        {
          sql: `INSERT INTO session_tags (session_id, tag, tag_folded)
                VALUES (?, 'Billing', 'billing')`,
          bindings: [sessionId],
        },
        {
          sql: "INSERT INTO session_drafts (session_id, text, updated_at) VALUES (?, 'unsent', ?)",
          bindings: [sessionId, PURGE_INSTANT],
        },
        {
          sql: `INSERT INTO session_review_notes
                  (session_id, note_id, scope, base, head_commit_id, path, side, line, quote, body,
                   created_at, updated_at)
                VALUES (?, 'note-1', 'branch', 'main', 'abc123', 'src/app.ts', 'added', 3,
                        'const total = 0;', 'Start from the saved total', ?, ?)`,
          bindings: [sessionId, PURGE_INSTANT, PURGE_INSTANT],
        },
      ]);
    }
    for (const [source, target] of [
      [SESSION, SECOND_SESSION],
      [SECOND_SESSION, SESSION],
      [SECOND_SESSION, THIRD_SESSION],
    ]) {
      await fixture.scratch.writer.write([
        {
          sql: `INSERT INTO session_links (source_session_id, target_session_id, kind, first_at,
                                           last_at)
                VALUES (?, ?, 'related', ?, ?)`,
          bindings: [source, target, PURGE_INSTANT, PURGE_INSTANT],
        },
        {
          sql: `INSERT INTO session_related (session_id, related_session_id, score)
                VALUES (?, ?, 0.5)`,
          bindings: [source, target],
        },
      ]);
    }

    const result = await fixture.buildPurge().purge([SESSION]);

    expect(result.refusedReason).toBeUndefined();
    expect(onlyOutcome(result).refusedReason).toBeUndefined();
    expect(fixture.readDirectoryRows()).toEqual({
      sessions: [SECOND_SESSION, THIRD_SESSION],
      drafts: [SECOND_SESSION],
      reviewNotes: [SECOND_SESSION],
      groups: ["group-kept"],
      runs: [SECOND_SESSION],
      consoleState: [SECOND_SESSION],
      links: [`${SECOND_SESSION} ${THIRD_SESSION}`],
      tags: [SECOND_SESSION],
      related: [`${SECOND_SESSION} ${THIRD_SESSION}`],
      mounts: [keptWorkspace.repoMountId, "project-1"].sort(),
      workspaces: ["workspace-kept"],
      branchContexts: ["branch-workspace-kept"],
      runExecutionContexts: ["run-kept"],
      queueItems: [SECOND_SESSION],
      createRequests: [SECOND_SESSION],
      convertRequests: [SECOND_SESSION],
      convertFiles: [SECOND_SESSION],
      interventions: ["run-kept"],
      runtimeBindings: ["run-kept"],
      commandReceipts: ["run-kept"],
      worktrees: [],
    });
    expect(existsSync(purgedWorkspace.path)).toBe(false);
    expect(existsSync(keptWorkspace.path)).toBe(true);
    expect(fixture.sessionList.refreshedSessionIds).toEqual([SESSION]);
  });

  it("re-scores a linked session's list, so no score keeps a share of the purged one", async () => {
    for (const sessionId of [SESSION, SECOND_SESSION, THIRD_SESSION]) {
      await fixture.seedSessionRow(sessionId);
    }
    await fixture.seedMessage("hi");
    for (const [sourceSessionId, targetSessionId] of [
      [SESSION, SECOND_SESSION],
      [SECOND_SESSION, THIRD_SESSION],
    ] as const) {
      await fixture.scratch.writer.write([
        recordedSessionLinkStatement({
          sourceSessionId,
          targetSessionId,
          kind: "started",
          occurredAt: PURGE_INSTANT,
        }),
      ]);
    }
    fixture.relatedRanking.rescoreAround([SESSION, SECOND_SESSION, THIRD_SESSION]);
    await fixture.relatedRanking.whenIdle();
    const secondSessionScores = (): readonly string[] =>
      (
        fixture.scratch.reader
          .prepare("SELECT related_session_id, score FROM session_related WHERE session_id = ?")
          .raw()
          .all(SECOND_SESSION) as unknown[][]
      ).map((row) => row.join(" "));
    // Half of the second session's walk goes to each of its two linked sessions.
    expect([...secondSessionScores()].sort()).toEqual(
      [`${SESSION} 0.5`, `${THIRD_SESSION} 0.5`].sort(),
    );

    const result = await fixture.buildPurge().purge([SESSION]);
    await fixture.relatedRanking.whenIdle();

    expect(result.refusedReason).toBeUndefined();
    expect(secondSessionScores()).toEqual([`${THIRD_SESSION} 1`]);
  });

  it("keeps every row while the folder cannot be removed, and finishes once it can", async () => {
    await fixture.seedSessionRow(SESSION);
    const message = await fixture.seedMessage("kept until the folder goes");
    const workspace = await fixture.managedWorkspaces.create({ sessionId: SESSION });
    // A folder whose parent refuses the removal.
    const workspacesFolder = realpathSync(managedWorkspacesDirectoryOf(fixture.homeDirectory));
    chmodSync(workspacesFolder, 0o500);
    let refused: SessionPurgeOutcome;
    try {
      refused = onlyOutcome(await fixture.buildPurge().purge([SESSION]));
    } finally {
      chmodSync(workspacesFolder, 0o700);
    }

    expect(refused.refusedReason).toContain("managed workspace could not be removed");
    expect(fixture.rowExists("session_events", message.id)).toBe(true);
    expect(fixture.readDirectoryRows().sessions).toEqual([SESSION]);
    expect(fixture.readDirectoryRows().mounts).toEqual([workspace.repoMountId]);
    expect(fixture.sessionList.refreshedSessionIds).toEqual([]);

    const retried = onlyOutcome(await fixture.buildPurge().purge([SESSION]));

    expect(retried.refusedReason).toBeUndefined();
    expect(existsSync(workspace.path)).toBe(false);
    expect(fixture.readDirectoryRows().mounts).toEqual([]);
  });

  it("ends the session's shells before its folder goes, keeping every row while one will not", async () => {
    await fixture.seedSessionRow(SESSION);
    const message = await fixture.seedMessage("kept while a shell runs");
    const workspace = await fixture.managedWorkspaces.create({ sessionId: SESSION });
    const shellsThatWillNotEnd = {
      closeSessionShells: async () => {
        throw new Error("the terminal host did not answer");
      },
    };

    const refused = onlyOutcome(
      await fixture.buildPurge({ shellTable: shellsThatWillNotEnd }).purge([SESSION]),
    );

    expect(refused.refusedReason).toContain("the session's shells could not all be ended");
    expect(existsSync(workspace.path)).toBe(true);
    expect(fixture.rowExists("session_events", message.id)).toBe(true);

    // Each shell ends while the folder it runs in is still there, and no shell opens in the session
    // again until its rows are gone.
    const folderStoodAtShellEnd: [string, boolean][] = [];
    const rowStoodAtOpensAllowed: boolean[] = [];
    const shellTable = {
      closeSessionShells: async (sessionId: string) => {
        folderStoodAtShellEnd.push([sessionId, existsSync(workspace.path)]);
        return () => {
          rowStoodAtOpensAllowed.push(fixture.rowExists("session_events", message.id));
        };
      },
    };
    const retried = onlyOutcome(await fixture.buildPurge({ shellTable }).purge([SESSION]));

    expect(retried.refusedReason).toBeUndefined();
    expect(folderStoodAtShellEnd).toEqual([[SESSION, true]]);
    expect(rowStoodAtOpensAllowed).toEqual([false]);
    expect(existsSync(workspace.path)).toBe(false);
  });

  it("keeps the rows a refused write named after the folder went; a retry finishes", async () => {
    await fixture.seedSessionRow(SESSION);
    await fixture.seedMessage("a");
    const workspace = await fixture.managedWorkspaces.create({ sessionId: SESSION });
    await fixture.scratch.writer.write([
      {
        sql: `CREATE TRIGGER refuse_purge BEFORE DELETE ON session_events
                BEGIN SELECT RAISE(ABORT, 'refused for the test'); END`,
      },
    ]);

    const refused = onlyOutcome(await fixture.buildPurge().purge([SESSION]));

    expect(refused.refusedReason).toContain("refused for the test");
    expect(existsSync(workspace.path)).toBe(false);
    expect(fixture.readDirectoryRows().mounts).toEqual([workspace.repoMountId]);

    await fixture.scratch.writer.write([{ sql: "DROP TRIGGER refuse_purge" }]);
    const retried = onlyOutcome(await fixture.buildPurge().purge([SESSION]));

    expect(retried.refusedReason).toBeUndefined();
    expect(retried.rowsDeleted).toBe(1);
    expect(fixture.readDirectoryRows().sessions).toEqual([]);
    expect(fixture.readDirectoryRows().mounts).toEqual([]);
  });

  it("tells the live list of the removal when the receipt cannot be appended", async () => {
    await fixture.seedSessionRow(SESSION);
    await fixture.seedMessage("hi");
    const failingEventLog: SessionPurgeEventLog = {
      append: () => Promise.reject(new Error("the log is full")),
    };

    const result = await fixture.buildPurge({ eventLog: failingEventLog }).purge([SESSION]);

    expect(result.refusedReason).toContain("the log is full");
    expect(fixture.readDirectoryRows().sessions).toEqual([]);
    expect(fixture.sessionList.refreshedSessionIds).toEqual([SESSION]);
  });

  it("waits for the session lock, so no conversion copies out of a folder it removes", async () => {
    await fixture.seedSessionRow(SESSION);
    const message = await fixture.seedMessage("hi");
    const workspace = await fixture.managedWorkspaces.create({ sessionId: SESSION });
    const { promise: conversionDone, resolve: finishConversion } = Promise.withResolvers<void>();
    const conversion = fixture.sessionLock.run(SESSION, () => conversionDone);

    const purging = fixture.buildPurge().purge([SESSION]);
    // Far longer than a purge takes, were it not waiting.
    const settledFirst = await Promise.race([
      purging.then(() => "purge"),
      new Promise<string>((resolve) => setTimeout(() => resolve("wait"), 1_000)),
    ]);
    expect(settledFirst).toBe("wait");
    expect(existsSync(workspace.path)).toBe(true);
    expect(fixture.rowExists("session_events", message.id)).toBe(true);

    finishConversion();
    await conversion;
    expect(onlyOutcome(await purging).refusedReason).toBeUndefined();
    expect(existsSync(workspace.path)).toBe(false);
    expect(fixture.rowExists("session_events", message.id)).toBe(false);
  });
});

describe("SessionPurge — the provider's own conversations", () => {
  it("deletes each through its driver, newest first, before any row; a refusal keeps them", async () => {
    await fixture.seedSessionRow(SESSION);
    await fixture.seed({
      category: "run_lifecycle",
      type: "run.running",
      payload: { runId: "run-1" },
    });
    const later = "2026-10-09T13:00:00.000Z";
    await fixture.scratch.writer.write([
      {
        sql: `INSERT INTO runtime_bindings (id, run_id, driver_name, contract_version, resume_handle,
                                            spawn_config, created_at, updated_at)
              VALUES ('binding-claude', 'run-1', 'claude', '1.0', 'claude-conversation',
                      '{"providerAccountId":"account-claude"}', ?, ?),
                     ('binding-codex', 'run-1', 'codex', '1.0', 'thread-fork', '{}', ?, ?)`,
        bindings: [PURGE_INSTANT, PURGE_INSTANT, PURGE_INSTANT, later],
      },
      {
        sql: `INSERT INTO left_conversations (session_id, driver_name, provider_account_id,
                                              conversation_id, left_at)
              VALUES (?, 'codex', NULL, 'thread-base', ?), (?, 'codex', NULL, 'thread-middle', ?)`,
        bindings: [SESSION, PURGE_INSTANT, SESSION, later],
      },
    ]);
    const purged: { driverName: string; params: unknown }[] = [];
    let isCodexRefusing = true;
    fixture.providerDrivers.set("claude", {
      purgeSession: async (params) => {
        purged.push({ driverName: "claude", params });
      },
    });
    fixture.providerDrivers.set("codex", {
      purgeSession: async (params) => {
        if (isCodexRefusing) {
          throw new Error("thread/delete refused");
        }
        purged.push({ driverName: "codex", params });
      },
    });
    const leftConversationCount = (): number =>
      fixture.scratch.reader.prepare("SELECT 1 FROM left_conversations").all().length;

    const refused = onlyOutcome(await fixture.buildPurge().purge([SESSION]));

    expect(refused.refusedReason).toContain("thread/delete refused");
    expect(fixture.readDirectoryRows().sessions).toEqual([SESSION]);
    expect(fixture.readDirectoryRows().runtimeBindings).toEqual(["run-1", "run-1"]);
    expect(leftConversationCount()).toBe(2);

    isCodexRefusing = false;
    purged.length = 0;
    const retried = onlyOutcome(await fixture.buildPurge().purge([SESSION]));

    expect(retried.refusedReason).toBeUndefined();
    expect(purged).toEqual([
      {
        driverName: "codex",
        params: {
          sessionId: SESSION,
          conversations: [
            { resumeHandle: "thread-fork", providerAccountId: undefined },
            { resumeHandle: "thread-middle", providerAccountId: undefined },
            { resumeHandle: "thread-base", providerAccountId: undefined },
          ],
        },
      },
      {
        driverName: "claude",
        params: {
          sessionId: SESSION,
          conversations: [
            { resumeHandle: "claude-conversation", providerAccountId: "account-claude" },
          ],
        },
      },
    ]);
    expect(fixture.readDirectoryRows().runtimeBindings).toEqual([]);
    expect(leftConversationCount()).toBe(0);
  });
});

describe("SessionPurge — the worktrees the session made", () => {
  it("deletes the rows of those gone that nothing names, and touches no folder", async () => {
    await fixture.scratch.writer.write([
      {
        sql: `INSERT INTO projects (id, name, slug, folder_path, state, setup, created_at,
                                    updated_at)
              VALUES ('project-1', 'Project', 'project', '/repos/project', 'active', '{}', ?, ?)`,
        bindings: [PURGE_INSTANT, PURGE_INSTANT],
      },
      {
        sql: `INSERT INTO repo_mounts (id, node_id, local_path, canonical_root, project_id,
                                       attached_at, updated_at)
              VALUES ('project-1', 'node-1', '/repos/project', '/repos/project', 'project-1', ?, ?)`,
        bindings: [PURGE_INSTANT, PURGE_INSTANT],
      },
    ]);
    await fixture.seedSessionRow(SESSION);
    await fixture.seedSessionRow(SECOND_SESSION);
    await fixture.seedMessage("hi");
    const worktrees: ReadonlyArray<{
      readonly id: string;
      readonly createdBy: SessionId;
      readonly state: "ready" | "retired" | "failed";
      readonly isCleaned?: boolean;
      // A failed attempt's folder is gone unless said; every other folder is on disk.
      readonly isOnDisk?: boolean;
    }> = [
      { id: "wt-cleaned", createdBy: SESSION, state: "retired", isCleaned: true },
      { id: "wt-failed", createdBy: SESSION, state: "failed" },
      { id: "wt-failed-on-disk", createdBy: SESSION, state: "failed", isOnDisk: true },
      { id: "wt-on-disk", createdBy: SESSION, state: "ready" },
      { id: "wt-awaiting-cleanup", createdBy: SESSION, state: "retired" },
      { id: "wt-in-use", createdBy: SESSION, state: "retired", isCleaned: true },
      { id: "wt-run-root", createdBy: SESSION, state: "failed" },
      { id: "wt-pending-move", createdBy: SESSION, state: "failed" },
      { id: "wt-other", createdBy: SECOND_SESSION, state: "retired", isCleaned: true },
    ];
    const isOnDisk = (worktree: (typeof worktrees)[number]): boolean =>
      worktree.state !== "failed" || worktree.isOnDisk === true;
    for (const worktree of worktrees) {
      // A purge that removed a folder on disk would show.
      const folder = join(fixture.homeDirectory, "execution-roots", worktree.id);
      if (isOnDisk(worktree)) {
        mkdirSync(folder, { recursive: true });
      }
      await fixture.scratch.writer.write([
        {
          sql: `INSERT INTO worktrees (id, repo_mount_id, created_by_session_id, branch_name,
                                       base_ref, fs_root, state, created_at, updated_at, cleaned_at)
                VALUES (?, 'project-1', ?, ?, 'main', ?, ?, ?, ?, ?)`,
          bindings: [
            worktree.id,
            worktree.createdBy,
            `branch-${worktree.id}`,
            folder,
            worktree.state,
            PURGE_INSTANT,
            PURGE_INSTANT,
            worktree.isCleaned === true ? PURGE_INSTANT : null,
          ],
        },
      ]);
    }
    // Another session's branch context and run name two of them, and its pending move a third.
    await fixture.scratch.writer.write([
      {
        sql: `INSERT INTO workspaces (id, session_id, repo_mount_id, execution_mode, state,
                                      created_at, updated_at)
              VALUES ('workspace-other', ?, 'project-1', 'provisioned-worktree', 'ready', ?, ?)`,
        bindings: [SECOND_SESSION, PURGE_INSTANT, PURGE_INSTANT],
      },
      {
        sql: `INSERT INTO branch_contexts (id, workspace_id, worktree_id, base_branch, head_branch,
                                           created_at, updated_at)
              VALUES ('branch-other', 'workspace-other', 'wt-in-use', 'main', 'b', ?, ?)`,
        bindings: [PURGE_INSTANT, PURGE_INSTANT],
      },
      {
        sql: `INSERT INTO run_execution_contexts (run_id, session_id, workspace_id, execution_mode,
                                                  execution_root, checkout_root, git_common_dir,
                                                  worktree_id, branch_context_id, created_at)
              VALUES ('run-other', ?, 'workspace-other', 'provisioned-worktree', '/root', '/root',
                      '/root/.git', 'wt-run-root', 'branch-other', ?)`,
        bindings: [SECOND_SESSION, PURGE_INSTANT],
      },
      {
        // Spelled with a trailing separator, so only a resolved comparison matches it.
        sql: `UPDATE sessions SET pending_working_folder = ? WHERE id = ?`,
        bindings: [
          `${join(fixture.homeDirectory, "execution-roots", "wt-pending-move")}/`,
          SECOND_SESSION,
        ],
      },
    ]);

    const outcome = onlyOutcome(await fixture.buildPurge().purge([SESSION]));

    expect(outcome.refusedReason).toBeUndefined();
    expect(fixture.readDirectoryRows().worktrees).toEqual(
      [
        "wt-awaiting-cleanup",
        "wt-failed-on-disk",
        "wt-in-use",
        "wt-on-disk",
        "wt-other",
        "wt-pending-move",
        "wt-run-root",
      ].sort(),
    );
    for (const worktree of worktrees.filter(isOnDisk)) {
      expect(existsSync(join(fixture.homeDirectory, "execution-roots", worktree.id))).toBe(true);
    }
  });
});

describe("SessionPurge — one receipt per deletion", () => {
  it("rolls a refused session back whole and carries on with the next", async () => {
    await fixture.seedMessage("a");
    const refusedRow = await fixture.seedMessage("b", SECOND_SESSION);
    const refusedSnapshot = await fixture.seedSnapshot(SECOND_SESSION, refusedRow.sequence);
    await fixture.seedMessage("c", THIRD_SESSION);
    // The second session's event delete fails after its snapshot delete ran.
    await fixture.scratch.writer.write([
      {
        sql: `CREATE TRIGGER refuse_second BEFORE DELETE ON session_events
                WHEN OLD.session_id = '${SECOND_SESSION}'
                BEGIN SELECT RAISE(ABORT, 'refused for the test'); END`,
      },
    ]);
    const eventLog = new RecordingEventLog();

    const result = await fixture
      .buildPurge({ eventLog })
      .purge([SESSION, SECOND_SESSION, THIRD_SESSION]);

    expect(result.refusedReason).toBeUndefined();
    const [first, second, third] = result.outcomes;
    expect(first?.rowsDeleted).toBe(1);
    expect(second?.rowsDeleted).toBe(0);
    expect(second?.refusedReason).toContain("refused for the test");
    expect(third?.rowsDeleted).toBe(1);
    expect(fixture.rowExists("session_events", refusedRow.id)).toBe(true);
    expect(fixture.rowExists("session_snapshots", refusedSnapshot)).toBe(true);
    expect(eventLog.appended).toHaveLength(1);
    expect(eventLog.appended[0]?.payload.removedSessions).toEqual([
      { sessionId: SESSION, fromSeq: 0, toSeq: 0 },
      { sessionId: THIRD_SESSION, fromSeq: 0, toSeq: 0 },
    ]);
  });
});

describe("SessionPurge — a range the receipt could not name", () => {
  it("refuses the session and deletes none of its rows", async () => {
    // Past the safe integers, the read-back number would name a different row than the stored one.
    const unsafe = await fixture.seed({
      category: "session_lifecycle",
      type: "session.updated",
      payload: { text: "far" },
      sequence: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
    });
    const eventLog = new RecordingEventLog();

    const outcome = onlyOutcome(await fixture.buildPurge({ eventLog }).purge([SESSION]));

    expect(outcome.rowsDeleted).toBe(0);
    expect(outcome.refusedReason).toContain("not safe integers");
    expect(fixture.rowExists("session_events", unsafe.id)).toBe(true);
    expect(eventLog.appended).toEqual([]);
  });
});

describe("SessionPurge — no copy survives on disk", () => {
  it("leaves the content in neither the database file nor its write-ahead log", async () => {
    const marker = "purge-marker-7f3a9c";
    await fixture.seed({
      category: "assistant_output",
      type: "assistant.message",
      payload: { text: marker },
      contentPayload: `${marker} `.repeat(40),
    });
    // Move the row into the database file, so the delete has to clear it there too.
    await fixture.scratch.writer.checkpoint("TRUNCATE");

    const result = await fixture.buildPurge().purge([SESSION]);

    expect(result.refusedReason).toBeUndefined();
    expect(onlyOutcome(result).rowsDeleted).toBe(1);
    // Read while the connections are open: closing the writer would checkpoint the log on its own.
    const walPath = `${fixture.scratch.databasePath}-wal`;
    const onDisk = [fixture.scratch.databasePath, ...(existsSync(walPath) ? [walPath] : [])];
    for (const filePath of onDisk) {
      expect(readFileSync(filePath).includes(marker), filePath).toBe(false);
    }
  });

  it("truncates the write-ahead log even when it deleted nothing or had no session", async () => {
    await fixture.seedMessage("another session's", SECOND_SESSION);
    const walPath = `${fixture.scratch.databasePath}-wal`;
    expect(statSync(walPath).size).toBeGreaterThan(0);

    const result = await fixture.buildPurge().purge([SESSION]);

    expect(result.refusedReason).toBeUndefined();
    expect(onlyOutcome(result).rowsDeleted).toBe(0);
    expect(statSync(walPath).size).toBe(0);

    // A purge of no session is how a caller truncates a log an earlier purge left untruncated.
    await fixture.seedMessage("a third session's", THIRD_SESSION);
    expect(statSync(walPath).size).toBeGreaterThan(0);
    const noSession = await fixture.buildPurge().purge([]);
    expect(noSession.outcomes).toEqual([]);
    expect(noSession.refusedReason).toBeUndefined();
    expect(statSync(walPath).size).toBe(0);
  });

  it("truncates once the start's check has ended, trying a busy truncation again", async () => {
    const message = await fixture.seedMessage("hi");
    const writer = fixture.scratch.writer;
    let tries = 0;
    // The first try answers busy, as a reader holding an older snapshot makes it; later tries
    // truncate for real.
    const busyOnceWriter: Pick<DatabaseWriter, "write" | "checkpoint"> = {
      write: (statements) => writer.write(statements),
      checkpoint: (mode) => {
        tries += 1;
        return tries === 1
          ? Promise.resolve({ isBusy: true, logFrames: 1, checkpointedFrames: 0 })
          : writer.checkpoint(mode);
      },
    };
    const fileCheck = Promise.withResolvers<void>();
    const eventLog = new RecordingEventLog();

    const purging = fixture
      .buildPurge({
        eventLog,
        writer: busyOnceWriter,
        checkpointRetryDelaysMs: [1],
        whenFileCheckEnds: fileCheck.promise,
      })
      .purge([SESSION]);
    // The rows and the receipt go at once; the truncation waits for the check, whose snapshot
    // would keep it busy.
    await vi.waitFor(() => {
      expect(eventLog.appended).toHaveLength(1);
    });
    await delay(50);
    expect(fixture.rowExists("session_events", message.id)).toBe(false);
    expect(tries).toBe(0);
    fileCheck.resolve();
    const result = await purging;

    expect(result.refusedReason).toBeUndefined();
    expect(tries).toBe(2);
    expect(statSync(`${fixture.scratch.databasePath}-wal`).size).toBe(0);
  });

  it("gives up on a log a reader keeps busy past its last retry, saying what is left", async () => {
    await fixture.seedMessage("hi");
    const writer = fixture.scratch.writer;
    let tries = 0;
    // Every try answers busy, as a reader that never ends its snapshot makes it.
    const alwaysBusyWriter: Pick<DatabaseWriter, "write" | "checkpoint"> = {
      write: (statements) => writer.write(statements),
      checkpoint: () => {
        tries += 1;
        return Promise.resolve({ isBusy: true, logFrames: 7, checkpointedFrames: 0 });
      },
    };

    const result = await fixture
      .buildPurge({ writer: alwaysBusyWriter, checkpointRetryDelaysMs: [1, 2] })
      .purge([SESSION]);

    // The rows went; only the truncation is left, and the reason says so.
    expect(onlyOutcome(result).rowsDeleted).toBe(1);
    expect(tries).toBe(3);
    expect(result.refusedReason).toBe(
      "a reader kept the write-ahead log busy through 3 truncation tries over 3 ms of retry " +
        "waits, so it still holds 7 frames, the deleted rows' earlier pages among them; the rows " +
        "and the receipt are done, and a purge of no session truncates the log once the reader " +
        "ends",
    );
  });
});

// The arm below pins a purge that declined to run, so it is paired with a positive arm over the
// same seeds: without the pairing, "nothing was deleted" passes just as well against a purge that
// never deletes anything.

describe("SessionPurge — a purge entered inside an append-lock hold is refused", () => {
  it("refuses under a hold on any session, and purges outside it", async () => {
    // The lock is reentrant per owner, so a purge inside a hold on the session would acquire
    // nothing for its rows.
    const candidate = await fixture.seedMessage("destroyable");
    const purge = fixture.buildPurge();

    for (const heldSession of [SESSION, SECOND_SESSION]) {
      const insideHold = await sessionAppendLock.run(heldSession, () => purge.purge([SESSION]));
      expect(insideHold.outcomes).toEqual([]);
      expect(insideHold.refusedReason).toContain("append-lock hold");
      expect(fixture.rowExists("session_events", candidate.id)).toBe(true);
    }

    const outsideHold = await purge.purge([SESSION]).then(onlyOutcome);
    expect(outsideHold.refusedReason).toBeUndefined();
    expect(fixture.rowExists("session_events", candidate.id)).toBe(false);
  });
});
