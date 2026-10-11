// The approval service records an ask's answer once, stamped with the device whose connection
// carried it, and answers the same answer sent again with what was saved; it refuses a block on an ask that is not a
// network request, and a correction where the ask offers none or beside a rule; a run's end
// cancels each ask the run still holds, leaving an answered one and another run's alone; an ask
// its provider took back is canceled unless it was answered first; and an ask on a run that ended
// or in a session that closed is refused, naming which.

import { afterEach, beforeEach, expect, it } from "vitest";

import type {
  ApprovalCategory,
  ApprovalRequestId,
  ApprovalResolveRequest,
} from "@ai-sidekicks/contracts/approval";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { DeviceId } from "@ai-sidekicks/contracts/trust-statement";

import { openScratchDatabase, type ScratchDatabase } from "../../database/__fixtures__/scratch.js";
import { EventLogService } from "../../events/log-service.js";
import { ApprovalService } from "../service.js";

const SESSION_ID = "00000000-0000-7000-8000-000000000001" as SessionId;
const RUN_ID = "00000000-0000-7000-8000-0000000000b1" as RunId;
const OTHER_RUN_ID = "00000000-0000-7000-8000-0000000000b2" as RunId;
const LAPTOP = "device-laptop" as DeviceId;
const PHONE = "device-phone" as DeviceId;
const FIRST_RESOLUTION_ID = "00000000-0000-4000-8000-0000000000d1";
const SECOND_RESOLUTION_ID = "00000000-0000-4000-8000-0000000000d2";
const CREATED_AT = "2026-10-11T00:00:00.000Z";

let database: ScratchDatabase;
let service: ApprovalService;
let staleSessions: SessionId[];

beforeEach(async () => {
  database = await openScratchDatabase();
  await database.writer.write([
    {
      sql: `INSERT INTO sessions (id, shape, state, created_at, updated_at, last_activity_at)
            VALUES (?, 'project', 'active', ?, ?, ?)`,
      bindings: [SESSION_ID, CREATED_AT, CREATED_AT, CREATED_AT],
    },
    {
      sql: `INSERT INTO runs (run_id, session_id, state, run_version)
            VALUES (?, ?, 'running', 1), (?, ?, 'running', 1)`,
      bindings: [RUN_ID, SESSION_ID, OTHER_RUN_ID, SESSION_ID],
    },
  ]);
  staleSessions = [];
  service = new ApprovalService({
    reader: database.reader,
    sessionEvents: new EventLogService({
      writer: database.writer,
      reader: database.reader,
      writeServiceLog: (line) => {
        throw new Error(`unexpected service log line: ${line}`);
      },
    }),
    followAll: () => () => {},
    workingFolders: {
      raiseStaleness: async (sessionId) => {
        staleSessions.push(sessionId);
      },
    },
    writeServiceLog: (line) => {
      throw new Error(`unexpected service log line: ${line}`);
    },
  });
});

afterEach(async () => {
  await database.close();
});

// Raises one ask on `runId` whose card names `subject`.
async function raiseAsk(
  category: ApprovalCategory,
  subject: string,
  runId: RunId = RUN_ID,
): Promise<ApprovalRequestId> {
  const { approvalRequestId } = await service.create({
    sessionId: SESSION_ID,
    runId,
    requestedBy: "agent-1",
    category,
    scope: subject,
    resourceDescriptor: {
      subject,
      standingAllowOffered: true,
      projectScopeOffered: true,
      editable: true,
      toolName: "Bash",
    },
  });
  return approvalRequestId;
}

function approval(
  approvalRequestId: ApprovalRequestId,
  clientResolutionId: string,
): ApprovalResolveRequest {
  return { approvalRequestId, decision: "approved", clientResolutionId };
}

function readRequestState(approvalRequestId: ApprovalRequestId): string | undefined {
  return database.reader
    .prepare<[string], { state: string }>("SELECT state FROM approval_requests WHERE id = ?")
    .get(approvalRequestId)?.state;
}

function readResolutionDevices(approvalRequestId: ApprovalRequestId): string[] {
  return database.reader
    .prepare<[string], { device_id: string }>(
      "SELECT device_id FROM approval_resolutions WHERE request_id = ?",
    )
    .all(approvalRequestId)
    .map((row) => row.device_id);
}

// The payloads of every `type` event in the log, in log order.
function readEventPayloads(type: string): Record<string, unknown>[] {
  return database.reader
    .prepare<[string], { payload: string }>(
      "SELECT payload FROM session_events WHERE type = ? ORDER BY sequence",
    )
    .all(type)
    .map((row) => JSON.parse(row.payload) as Record<string, unknown>);
}

it("stamps the answering device on the answer's row, its event and its reply", async () => {
  const approvalRequestId = await raiseAsk("tool_execution", "git push");

  const answer = await service.resolve(approval(approvalRequestId, FIRST_RESOLUTION_ID), LAPTOP);

  expect(answer.deviceId).toBe(LAPTOP);
  expect(readResolutionDevices(approvalRequestId)).toEqual([LAPTOP]);
  expect(readEventPayloads("approval.approved")).toMatchObject([
    { approvalRequestId, deviceId: LAPTOP, clientResolutionId: FIRST_RESOLUTION_ID },
  ]);
});

it("records an answer once and answers the same answer sent again with what was saved", async () => {
  const approvalRequestId = await raiseAsk("tool_execution", "git push");
  const first = await service.resolve(approval(approvalRequestId, FIRST_RESOLUTION_ID), LAPTOP);

  // The same press arriving again, relayed by another device, reads back the saved answer.
  const repeated = await service.resolve(approval(approvalRequestId, FIRST_RESOLUTION_ID), PHONE);
  await expect(
    service.resolve(approval(approvalRequestId, SECOND_RESOLUTION_ID), PHONE),
  ).rejects.toMatchObject({ code: "approval.already_resolved" });

  expect(repeated).toEqual(first);
  expect(readResolutionDevices(approvalRequestId)).toEqual([LAPTOP]);
  expect(readEventPayloads("approval.approved")).toHaveLength(1);
  expect(staleSessions).toEqual([SESSION_ID]);
});

it("refuses a block on an ask that is not a network request, and takes one on a network request", async () => {
  const fileWrite = await raiseAsk("file_write", "notes.md");
  const networkRequest = await raiseAsk("network_access", "example.com");
  const blockOf = (
    approvalRequestId: ApprovalRequestId,
    subject: string,
  ): ApprovalResolveRequest => ({
    approvalRequestId,
    decision: "rejected",
    clientResolutionId: FIRST_RESOLUTION_ID,
    rememberedScope: { kind: "session", pattern: subject, sense: "block" },
  });

  await expect(service.resolve(blockOf(fileWrite, "notes.md"), LAPTOP)).rejects.toMatchObject({
    code: "approval.resolution_invalid",
    detail: { reason: "block_outside_network_access" },
  });
  await service.resolve(blockOf(networkRequest, "example.com"), LAPTOP);

  expect(readRequestState(fileWrite)).toBe("pending");
  expect(readResolutionDevices(fileWrite)).toEqual([]);
  expect(readRequestState(networkRequest)).toBe("rejected");
  expect(readEventPayloads("approval.rejected")).toMatchObject([
    { approvalRequestId: networkRequest },
  ]);
});

it("cancels each ask a run still holds when it ends, leaving answered asks and other runs alone", async () => {
  const pending = await raiseAsk("tool_execution", "git push");
  const answered = await raiseAsk("tool_execution", "git fetch");
  const otherRun = await raiseAsk("tool_execution", "git pull", OTHER_RUN_ID);
  await service.resolve(
    { approvalRequestId: answered, decision: "rejected", clientResolutionId: FIRST_RESOLUTION_ID },
    LAPTOP,
  );

  await service.cancelPendingForRun(RUN_ID);

  expect(readRequestState(pending)).toBe("canceled");
  expect(readRequestState(answered)).toBe("rejected");
  expect(readRequestState(otherRun)).toBe("pending");
  expect(readResolutionDevices(pending)).toEqual([]);
  expect(readEventPayloads("approval.canceled")).toMatchObject([{ approvalRequestId: pending }]);
  await expect(
    service.resolve(approval(pending, SECOND_RESOLUTION_ID), LAPTOP),
  ).rejects.toMatchObject({ code: "approval.request_canceled" });
});

it("cancels an ask its provider took back and tells the run, and keeps an answered one", async () => {
  const settled: ApprovalRequestId[] = [];
  service.registerApprovalOutcomeListener({
    onBlocking: async () => {},
    onSettled: async (_runId, approvalRequestId) => {
      settled.push(approvalRequestId);
    },
  });
  const takenBack = await raiseAsk("tool_execution", "git push");
  const answered = await raiseAsk("tool_execution", "git fetch");
  await service.resolve(approval(answered, FIRST_RESOLUTION_ID), LAPTOP);

  await service.withdraw(takenBack);
  await service.withdraw(answered);
  await service.withdraw(takenBack);

  expect(readRequestState(takenBack)).toBe("canceled");
  expect(readRequestState(answered)).toBe("approved");
  expect(settled).toEqual([answered, takenBack]);
});

it("refuses a correction on an ask that offers none, and one beside a rule", async () => {
  const { approvalRequestId: uneditable } = await service.create({
    sessionId: SESSION_ID,
    runId: RUN_ID,
    requestedBy: "agent-1",
    category: "file_write",
    scope: "a.ts\nb.ts",
    resourceDescriptor: {
      subject: "a.ts\nb.ts",
      standingAllowOffered: false,
      projectScopeOffered: false,
      editable: false,
      toolName: "apply_patch",
    },
  });
  const editable = await raiseAsk("tool_execution", "git push");
  const corrected = (approvalRequestId: ApprovalRequestId): ApprovalResolveRequest => ({
    ...approval(approvalRequestId, FIRST_RESOLUTION_ID),
    editedAction: "git push origin main",
  });

  await expect(service.resolve(corrected(uneditable), LAPTOP)).rejects.toMatchObject({
    detail: { reason: "edit_not_offered" },
  });
  await expect(
    service.resolve(
      {
        ...corrected(editable),
        rememberedScope: { kind: "session", pattern: "git push", sense: "allow" },
      },
      LAPTOP,
    ),
  ).rejects.toMatchObject({ detail: { reason: "edit_with_rule" } });
  await service.resolve(corrected(editable), LAPTOP);

  expect(readRequestState(uneditable)).toBe("pending");
  expect(readRequestState(editable)).toBe("approved");
});

it("raises no ask on a run that ended or in a session that closed, and names which", async () => {
  await database.writer.write([
    { sql: "UPDATE runs SET state = 'completed' WHERE run_id = ?", bindings: [OTHER_RUN_ID] },
  ]);
  await expect(raiseAsk("tool_execution", "git push", OTHER_RUN_ID)).rejects.toMatchObject({
    code: "approval.request_canceled",
    detail: { reason: "run_ended" },
  });

  await database.writer.write([
    { sql: "UPDATE sessions SET state = 'closed' WHERE id = ?", bindings: [SESSION_ID] },
  ]);
  await expect(raiseAsk("tool_execution", "git push")).rejects.toMatchObject({
    code: "approval.request_canceled",
    detail: { reason: "session_closed" },
  });
  expect(readEventPayloads("approval.requested")).toEqual([]);
});
