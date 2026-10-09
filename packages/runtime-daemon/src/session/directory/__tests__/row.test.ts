// The sessions list and the session read answer from the `sessions` row, and a client that
// reconnects rebuilds from the log; if the two disagree, a device shows a session wrongly. Each
// event here is written the way the daemon writes it, its directory statements committed in the
// same write just before its row, and after every event the stored row must equal a rebuild over
// the stored log, and at the end both must equal the row the events say.

import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import {
  openScratchDatabase,
  type ScratchDatabase,
} from "../../../database/__fixtures__/scratch.js";
import { WriteRefusedError } from "../../../database/writer.js";
import type { SessionDirectoryRow } from "../../records.js";
import { SessionService } from "../../service.js";
import { directoryStatementsFor } from "../row.js";

const SESSION_ID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f10" as SessionId;
const PARENT_SESSION_ID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f11";
const SCRATCH_DEFINITION_ID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f12";
const RUN_A = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8fa1";
const RUN_B = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8fb2";
const REPO_MOUNT_ID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8fc3";

// Minute `minute` of one fixed hour, in the stored RFC 3339 form.
function at(minute: number): string {
  return new Date(Date.UTC(2026, 9, 6, 12, minute)).toISOString();
}

let scratch: ScratchDatabase;
let sessions: SessionService;

beforeEach(async () => {
  scratch = await openScratchDatabase();
  sessions = new SessionService(scratch.reader);
});

afterEach(async () => {
  await scratch.close();
});

async function append(
  type: string,
  category: string,
  payload: Record<string, unknown>,
  occurredAt: string,
  sessionId: string = SESSION_ID,
): Promise<void> {
  const envelope = { sessionId, occurredAt, category, type, payload };
  await scratch.writer.appendEvents(
    [
      {
        id: randomUUID(),
        session_id: sessionId,
        occurred_at: occurredAt,
        monotonic_ns: 1n,
        category,
        type,
        actor: null,
        payload: JSON.stringify(payload),
        correlation_id: null,
        causation_id: null,
        version: "1.0",
        content_payload: null,
      },
    ],
    directoryStatementsFor(envelope),
  );
}

function runChange(
  runId: string,
  runVersion: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { sessionId: SESSION_ID, runId, runVersion, ...extra };
}

interface StoredSessionRow {
  readonly id: string;
  readonly shape: SessionDirectoryRow["shape"];
  readonly state: SessionDirectoryRow["state"];
  readonly name: string | null;
  readonly first_message_preview: string | null;
  readonly branch: string | null;
  readonly pinned_at: string | null;
  readonly muted_at: string | null;
  readonly scratch_for_definition_id: string | null;
  readonly parent_session_id: string | null;
  readonly last_run_outcome: SessionDirectoryRow["lastRunOutcome"];
  readonly created_at: string;
  readonly updated_at: string;
  readonly last_activity_at: string;
}

function readStoredRow(sessionId: string): SessionDirectoryRow {
  const row = scratch.reader
    .prepare(
      `SELECT id, shape, state, name, first_message_preview, branch, pinned_at, muted_at,
              scratch_for_definition_id, parent_session_id, last_run_outcome,
              created_at, updated_at, last_activity_at
         FROM sessions WHERE id = ?`,
    )
    .get(sessionId) as StoredSessionRow;
  return {
    sessionId: row.id,
    shape: row.shape,
    state: row.state,
    name: row.name,
    firstMessagePreview: row.first_message_preview,
    branch: row.branch,
    pinnedAt: row.pinned_at,
    mutedAt: row.muted_at,
    scratchForDefinitionId: row.scratch_for_definition_id,
    parentSessionId: row.parent_session_id,
    lastRunOutcome: row.last_run_outcome,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastActivityAt: row.last_activity_at,
  };
}

// The stored row, checked against a rebuild over the stored log.
function expectRowToMatchRebuild(): void {
  const record = sessions.rebuildSession(SESSION_ID);
  if (record === null) throw new Error("the session has no events");
  const { asOfSequence: _asOfSequence, ownerActor: _ownerActor, ...rebuilt } = record;
  expect(readStoredRow(SESSION_ID)).toEqual(rebuilt);
}

describe("the session directory row against a rebuild from the log", () => {
  it("holds the same row as the rebuild after every event", async () => {
    const script: ReadonlyArray<() => Promise<void>> = [
      () =>
        append(
          "session.created",
          "session_lifecycle",
          {
            sessionId: SESSION_ID,
            shape: "chat",
            mainAgent: { agentId: randomUUID(), name: "Implementer" },
            parent: { sessionId: PARENT_SESSION_ID, anchorCursor: "cursor-1" },
            scratchForDefinitionId: SCRATCH_DEFINITION_ID,
          },
          at(0),
        ),
      () =>
        append(
          "session.activated",
          "session_lifecycle",
          { sessionId: SESSION_ID, previousState: "provisioning", newState: "active" },
          at(1),
        ),
      // A message of only whitespace gives no preview, so the next message's opening does.
      () =>
        append(
          "user.message",
          "interactive_request",
          { sessionId: SESSION_ID, actor: "user-1", message: " \n\t " },
          at(2),
        ),
      // The bound falls inside the emoji's surrogate pair, so the cut stops before it.
      () =>
        append(
          "user.message",
          "interactive_request",
          { sessionId: SESSION_ID, actor: "user-1", message: `  ${"a".repeat(255)}😀 and more` },
          at(2),
        ),
      () =>
        append(
          "user.message",
          "interactive_request",
          { sessionId: SESSION_ID, actor: "user-1", message: "a second message" },
          at(3),
        ),
      () =>
        append(
          "session.renamed",
          "session_lifecycle",
          { sessionId: SESSION_ID, name: "Login fix", origin: "user" },
          at(4),
        ),
      () => append("run.starting", "run_lifecycle", runChange(RUN_A, 1), at(5)),
      () => append("run.running", "run_lifecycle", runChange(RUN_A, 2), at(6)),
      () => append("run.starting", "run_lifecycle", runChange(RUN_B, 1), at(7)),
      () => append("run.waiting_for_approval", "run_lifecycle", runChange(RUN_B, 2), at(8)),
      () =>
        append(
          "run.completed",
          "run_lifecycle",
          runChange(RUN_A, 3, { completionKind: "turn" }),
          at(9),
        ),
    ];
    for (const step of script) {
      await step();
      expectRowToMatchRebuild();
    }

    expect(readStoredRow(SESSION_ID).lastRunOutcome).toBe("done");

    const rest: ReadonlyArray<() => Promise<void>> = [
      () =>
        append("session.muted", "session_lifecycle", { sessionId: SESSION_ID, at: at(10) }, at(10)),
      // A second mute keeps the first one's time.
      () =>
        append("session.muted", "session_lifecycle", { sessionId: SESSION_ID, at: at(11) }, at(11)),
      () =>
        append(
          "session.pinned",
          "session_lifecycle",
          { sessionId: SESSION_ID, at: at(12) },
          at(12),
        ),
      () =>
        append(
          "session.branch_changed",
          "session_lifecycle",
          {
            sessionId: SESSION_ID,
            repoMountId: REPO_MOUNT_ID,
            worktreeId: null,
            branch: "fix/login",
            previousBranch: null,
          },
          at(13),
        ),
      // Stamped earlier than the newest event: the times stay where they are.
      () =>
        append(
          "session.renamed",
          "session_lifecycle",
          { sessionId: SESSION_ID, name: null, previousName: "Login fix", origin: "user" },
          at(11),
        ),
      () =>
        append(
          "run.failed",
          "run_lifecycle",
          runChange(RUN_B, 3, { failureCategory: "provider failure" }),
          at(15),
        ),
      () =>
        append(
          "session.converted",
          "session_lifecycle",
          {
            sessionId: SESSION_ID,
            repoMountId: REPO_MOUNT_ID,
            copiedCount: 2,
            skippedCount: 0,
          },
          at(16),
        ),
      () =>
        append(
          "session.archived",
          "session_lifecycle",
          { sessionId: SESSION_ID, previousState: "active", newState: "archived" },
          at(17),
        ),
      // The log's own bookkeeping says nothing about when the session was last active.
      () =>
        append(
          "backup.completed",
          "event_maintenance",
          { backupId: randomUUID(), totalBytes: 1024 },
          at(18),
        ),
    ];
    for (const step of rest) {
      await step();
      expectRowToMatchRebuild();
    }

    expect(readStoredRow(SESSION_ID)).toEqual({
      sessionId: SESSION_ID,
      shape: "project",
      state: "archived",
      name: null,
      firstMessagePreview: "a".repeat(255),
      branch: "fix/login",
      pinnedAt: at(12),
      mutedAt: at(10),
      scratchForDefinitionId: SCRATCH_DEFINITION_ID,
      parentSessionId: PARENT_SESSION_ID,
      lastRunOutcome: "failed",
      createdAt: at(0),
      updatedAt: at(17),
      lastActivityAt: at(17),
    } satisfies SessionDirectoryRow);
  });

  it("refuses an event for a session that has no row, and stores nothing of it", async () => {
    await expect(
      append(
        "session.renamed",
        "session_lifecycle",
        { sessionId: SESSION_ID, name: "Orphan", origin: "user" },
        at(0),
      ),
    ).rejects.toBeInstanceOf(WriteRefusedError);
    expect(sessions.rebuildSession(SESSION_ID)).toBeNull();
  });
});
