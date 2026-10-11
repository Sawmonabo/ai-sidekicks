// `Allow once` hands the provider back its whole record of a block, even one past the bound that
// cuts the block's visible body short. A block that arrives before its call's row is recorded on
// that row once it commits, and refused when its run ends with no row for it.

import { afterEach, beforeEach, expect, it } from "vitest";

import type { EventEnvelope } from "@ai-sidekicks/contracts/event/envelope";

import type { ReviewerDenialId } from "@ai-sidekicks/contracts/approval";
import { CONTENT_PAYLOAD_PLAINTEXT_MAX } from "@ai-sidekicks/contracts/event/declared-variants";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import { openScratchDatabase, type ScratchDatabase } from "../../database/__fixtures__/scratch.js";
import { EventLogService } from "../../events/log-service.js";
import type { OverrideDenialParams } from "../../provider/driver/run-control.js";
import { mintUuidV7 } from "../../uuid-v7.js";
import { ReviewerDenials } from "../reviewer-denials.js";

const SESSION_ID = "00000000-0000-7000-8000-000000000001" as SessionId;
const RUN_ID = "00000000-0000-7000-8000-0000000000b1" as RunId;
const AGENT_ID = "00000000-0000-7000-8000-0000000000a1";
const TOOL_CALL_ID = "toolu_1";
const CREATED_AT = "2026-10-11T00:00:00.000Z";

let database: ScratchDatabase;

beforeEach(async () => {
  database = await openScratchDatabase();
  const seededEvent = (
    sequence: number,
    category: string,
    type: string,
    payload: object,
  ): unknown[] => [
    `evt-${String(sequence)}`,
    SESSION_ID,
    sequence,
    CREATED_AT,
    BigInt(sequence),
    category,
    type,
    JSON.stringify(payload),
  ];
  const insertEvent = `INSERT INTO session_events
      (id, session_id, sequence, occurred_at, monotonic_ns, category, type, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
  await database.writer.write([
    {
      sql: `INSERT INTO sessions (id, shape, state, created_at, updated_at, last_activity_at)
            VALUES (?, 'project', 'active', ?, ?, ?)`,
      bindings: [SESSION_ID, CREATED_AT, CREATED_AT, CREATED_AT],
    },
    {
      sql: `INSERT INTO runs (run_id, session_id, state, run_version) VALUES (?, ?, 'running', 1)`,
      bindings: [RUN_ID, SESSION_ID],
    },
    {
      sql: insertEvent,
      bindings: seededEvent(1, "run_lifecycle", "run.queued", { runId: RUN_ID, agentId: AGENT_ID }),
    },
    {
      sql: insertEvent,
      bindings: seededEvent(2, "tool_activity", "tool.invoked", {
        runId: RUN_ID,
        toolCallId: TOOL_CALL_ID,
      }),
    },
  ]);
});

afterEach(async () => {
  await database.close();
});

let sessionEvents: EventLogService;

function buildDenials(overrides: OverrideDenialParams[] = []): ReviewerDenials {
  sessionEvents = new EventLogService({
    writer: database.writer,
    reader: database.reader,
    writeServiceLog: (line) => {
      throw new Error(`unexpected service log line: ${line}`);
    },
  });
  return new ReviewerDenials({
    reader: database.reader,
    sessionEvents,
    followAll: sessionEvents.followAll.bind(sessionEvents),
    resolveDriver: () => ({
      overrideDenial: async (params) => {
        overrides.push(params);
      },
    }),
  });
}

async function appendEvent(
  category: EventEnvelope["category"],
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await sessionEvents.append({
    id: mintUuidV7(),
    sessionId: SESSION_ID,
    occurredAt: CREATED_AT,
    category,
    type,
    actor: null,
    payload: { sessionId: SESSION_ID, runId: RUN_ID, ...payload },
    version: "1.0",
  } as Parameters<EventLogService["append"]>[0]);
}

// The call row each recorded block names, in log order.
function readDeniedCallRows(): string[] {
  return database.reader
    .prepare<[], { event_id: string }>(
      `SELECT json_extract(payload, '$.eventId') AS event_id FROM session_events
        WHERE type = 'approval.reviewer_denied' ORDER BY sequence`,
    )
    .all()
    .map((row) => row.event_id);
}

function readDeniedReasons(): (string | null)[] {
  return database.reader
    .prepare<[], { reason: string | null }>(
      `SELECT json_extract(payload, '$.reason') AS reason FROM session_events
        WHERE type = 'approval.reviewer_denied' ORDER BY sequence`,
    )
    .all()
    .map((row) => row.reason);
}

function readCallRowId(toolCallId: string): string | undefined {
  return database.reader
    .prepare<[string], { id: string }>(
      `SELECT id FROM session_events
        WHERE type = 'tool.invoked' AND json_extract(payload, '$.toolCallId') = ?`,
    )
    .get(toolCallId)?.id;
}

it("hands back the whole record of a block whose visible body was cut short", async () => {
  const providerDenial = {
    tool_name: "Write",
    tool_input: { file_path: "notes.md", content: "x".repeat(CONTENT_PAYLOAD_PLAINTEXT_MAX) },
    tool_use_id: TOOL_CALL_ID,
  };
  const overrides: OverrideDenialParams[] = [];
  const denials = buildDenials(overrides);

  await denials.takeDenial({
    sessionId: SESSION_ID,
    runId: RUN_ID,
    toolCallId: TOOL_CALL_ID,
    reason: "[Data Exfiltration]",
    overridable: true,
    providerDenial,
  });
  const denied = database.reader
    .prepare<
      [],
      { payload: string }
    >("SELECT payload FROM session_events WHERE type = 'approval.reviewer_denied'")
    .get();
  const payload = JSON.parse(denied?.payload ?? "{}") as { denialId: ReviewerDenialId };
  await denials.overrideDenial({ sessionId: SESSION_ID, denialId: payload.denialId });

  expect(payload).toMatchObject({ contentTruncated: true });
  expect(overrides).toEqual([{ sessionId: SESSION_ID, providerDenial }]);
});

it("records a block that arrived before its call's row once the row commits, with no reason given", async () => {
  const denials = buildDenials();
  denials.start();

  const taking = denials.takeDenial({
    sessionId: SESSION_ID,
    runId: RUN_ID,
    toolCallId: "toolu_2",
    overridable: true,
    providerDenial: { tool_use_id: "toolu_2" },
  });
  await appendEvent("tool_activity", "tool.invoked", { toolName: "Bash", toolCallId: "toolu_2" });
  await taking;
  denials.stop();

  expect(readDeniedCallRows()).toEqual([readCallRowId("toolu_2")]);
  expect(readDeniedReasons()).toEqual([null]);
});

it("refuses a block still waiting at a stop, and one whose run ends with no row for it", async () => {
  const blockOf = (denials: ReviewerDenials, toolCallId: string): Promise<void> =>
    denials.takeDenial({
      sessionId: SESSION_ID,
      runId: RUN_ID,
      toolCallId,
      overridable: true,
      providerDenial: { tool_use_id: toolCallId },
    });
  const stopping = buildDenials();
  stopping.start();
  const stopped = blockOf(stopping, "toolu_3");
  stopping.stop();
  await expect(stopped).rejects.toThrow("the daemon stopped");

  const denials = buildDenials();
  denials.start();
  const endedRun = blockOf(denials, "toolu_4");
  await database.writer.write([
    { sql: "UPDATE runs SET state = 'failed' WHERE run_id = ?", bindings: [RUN_ID] },
  ]);
  await appendEvent("run_lifecycle", "run.failed", {
    runVersion: 3,
    previousState: "running",
    newState: "failed",
    failureCategory: "provider failure",
  });

  await expect(endedRun).rejects.toThrow("no row to carry its block");
  // A block arriving after its run ended is refused at once.
  await expect(blockOf(denials, "toolu_5")).rejects.toThrow("no row to carry its block");
  denials.stop();
  expect(readDeniedCallRows()).toEqual([]);
});
