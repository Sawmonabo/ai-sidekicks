// The session directory's provider port over a real database: a resume a driver started on its
// own is recorded, so the daemon's next restart of the session resumes the conversation that
// resume opened, and the one it left is recorded for the purge; a restart resumes in the mode the
// session was last moved to, at the posture of the level it stands at, its repository's git folder
// writable at Sandboxed; the folder a session's runs work in reads before its first run.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import { readLeftConversations } from "../../../provider/left-conversations.js";
import { sessionModeChangeStatement } from "../../console-state.js";
import { permissionLevelChangeStatement } from "../../permission-level.js";
import { RuntimeBindingStore } from "../../../provider/runtime-binding-store.js";
import { openSessionLog, type SessionLog } from "../__fixtures__/event-log.js";
import { SessionDirectoryProviderPort } from "../provider-port.js";

const SESSION_ID = "0190fa10-2b3c-7d4e-8f5a-6b7c8d9e0a01" as SessionId;
const RUN_ID = "0190fa10-2b3c-7d4e-8f5a-6b7c8d9e0b01";

let log: SessionLog;

beforeEach(async () => {
  log = await openSessionLog();
});

afterEach(async () => {
  await log.scratch.close();
});

const RUN_FOLDER = "/work/repo";

// A port as one daemon start builds it, whose git reads every folder's repository as one.
function openPort(): SessionDirectoryProviderPort {
  return new SessionDirectoryProviderPort({
    reader: log.scratch.reader,
    runtimeBindings: new RuntimeBindingStore(log.scratch),
    git: () => Promise.resolve({ stdout: Buffer.from(`${RUN_FOLDER}/.git\n`), stderr: "" }),
    settingsFile: { read: () => Promise.reject(new Error("no settings read is expected")) },
    projectRecords: {
      readEnvironmentRowsOfSession: () => {
        throw new Error("no project read is expected");
      },
    },
    writeServiceLog: log.writeServiceLog,
  });
}

// Gives the session a workspace whose root its runs work in.
async function seedRunFolder(): Promise<void> {
  await log.bindToProject(SESSION_ID);
  await log.scratch.writer.write([
    {
      sql: "UPDATE workspaces SET fs_root = ? WHERE session_id = ?",
      bindings: [RUN_FOLDER, SESSION_ID],
    },
  ]);
}

describe("a resume the driver started on its own", () => {
  it("is what the next daemon's restart resumes, the conversation it left recorded", async () => {
    await log.createSession(SESSION_ID, "chat");
    await log.append(SESSION_ID, "run.starting", "run_lifecycle", {
      sessionId: SESSION_ID,
      runId: RUN_ID,
      runVersion: 1,
      previousState: "queued",
      newState: "starting",
    });
    await new RuntimeBindingStore(log.scratch).create({
      runId: RUN_ID,
      driverName: "claude",
      contractVersion: "1.0.0",
      resumeHandle: "conversation-before",
      spawnConfig: { providerAccountId: "account-1" },
    });

    openPort().onSessionRelaunched(SESSION_ID, {
      status: "resumed",
      bindingId: "binding-relaunched",
      sessionPosition: 3,
      resumeHandle: "conversation-after",
    });

    await seedRunFolder();
    const restarted = openPort();
    await vi.waitFor(async () => {
      expect((await restarted.resolveRestartTarget(SESSION_ID))?.params.resumeHandle).toBe(
        "conversation-after",
      );
    });
    expect(await restarted.resolveRestartTarget(SESSION_ID)).toMatchObject({
      driverName: "claude",
      params: { sessionId: SESSION_ID, model: "claude-sonnet-5", providerAccountId: "account-1" },
    });
    expect(readLeftConversations(log.scratch.reader, SESSION_ID)).toMatchObject([
      {
        driverName: "claude",
        providerAccountId: "account-1",
        conversationId: "conversation-before",
      },
    ]);
    expect(log.serviceLogLines).toEqual([]);
  });
});

describe("a restart of a session left in Plan at Sandboxed", () => {
  it("resumes in Plan, its git folder writable", async () => {
    await log.createSession(SESSION_ID, "chat");
    await log.append(SESSION_ID, "run.starting", "run_lifecycle", {
      sessionId: SESSION_ID,
      runId: RUN_ID,
      runVersion: 1,
      previousState: "queued",
      newState: "starting",
    });
    await new RuntimeBindingStore(log.scratch).create({
      runId: RUN_ID,
      driverName: "claude",
      contractVersion: "1.0.0",
      resumeHandle: "conversation",
      spawnConfig: {},
    });
    await seedRunFolder();
    // What `session.modeUpdate` and a level move commit once the provider took them.
    await log.scratch.writer.write([
      sessionModeChangeStatement(SESSION_ID, "plan", "2026-10-09T12:00:00.000Z"),
      permissionLevelChangeStatement(SESSION_ID, "sandboxed"),
    ]);

    expect((await openPort().resolveRestartTarget(SESSION_ID))?.params).toMatchObject({
      mode: "plan",
      executionPosture: { mode: "sandboxed", writableRoots: [`${RUN_FOLDER}/.git`] },
    });
  });
});

describe("the folder a session's runs work in", () => {
  it("is the folder its workspace was bound to until a run prepares its root", async () => {
    await log.createSession(SESSION_ID, "chat");
    const now = "2026-10-11T12:00:00.000Z";
    const database = log.scratch.writer;
    await database.write([
      {
        sql: `INSERT INTO projects (id, name, slug, folder_path, state, setup, created_at, updated_at)
              VALUES ('project-1', 'repo', 'repo', '/repo', 'active', '{}', ?, ?)`,
        bindings: [now, now],
      },
      {
        sql: `INSERT INTO repo_mounts
                (id, node_id, local_path, canonical_root, project_id, attached_at, updated_at)
              VALUES ('mount-1', 'node-1', '/repo', '/repo', 'project-1', ?, ?)`,
        bindings: [now, now],
      },
      // As a bind writes it: no root yet, the bound folder and its checkout in the metadata.
      {
        sql: `INSERT INTO workspaces (id, session_id, repo_mount_id, execution_mode, fs_root, state,
                                      metadata, created_at, updated_at)
              VALUES ('workspace-1', ?, 'mount-1', 'bound-root', NULL, 'preparing',
                      json_object('boundRoot', '/repo/app', 'checkoutRoot', '/repo'), ?, ?)`,
        bindings: [SESSION_ID, now, now],
      },
    ]);
    const port = openPort();

    expect(port.requireRunFolder(SESSION_ID)).toBe("/repo/app");

    // A worktree the run prepared is where it works from then on.
    await database.write([
      { sql: `UPDATE workspaces SET fs_root = '/worktrees/app', state = 'ready'`, bindings: [] },
    ]);
    expect(port.requireRunFolder(SESSION_ID)).toBe("/worktrees/app");
  });
});
