// `Allow once` hands the provider back its whole record of a block, even one past the bound that
// cuts the block's visible body short.

import { afterEach, beforeEach, expect, it } from "vitest";

import type { ReviewerDenialId } from "@ai-sidekicks/contracts/approval";
import { CONTENT_PAYLOAD_PLAINTEXT_MAX } from "@ai-sidekicks/contracts/event/declared-variants";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import { openScratchDatabase, type ScratchDatabase } from "../../database/__fixtures__/scratch.js";
import { EventLogService } from "../../events/log-service.js";
import type { OverrideDenialParams } from "../../provider/driver/run-control.js";
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

it("hands back the whole record of a block whose visible body was cut short", async () => {
  const providerDenial = {
    tool_name: "Write",
    tool_input: { file_path: "notes.md", content: "x".repeat(CONTENT_PAYLOAD_PLAINTEXT_MAX) },
    tool_use_id: TOOL_CALL_ID,
  };
  const overrides: OverrideDenialParams[] = [];
  const denials = new ReviewerDenials({
    reader: database.reader,
    sessionEvents: new EventLogService({
      writer: database.writer,
      reader: database.reader,
      writeServiceLog: (line) => {
        throw new Error(`unexpected service log line: ${line}`);
      },
    }),
    resolveDriver: () => ({
      overrideDenial: async (params) => {
        overrides.push(params);
      },
    }),
  });

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
