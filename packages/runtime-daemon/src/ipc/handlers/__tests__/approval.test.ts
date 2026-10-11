// The `approval.*` methods as the client receives them, through the real method registry over a
// real log: a session's cards come back with the device that answered each, the scope it granted
// and the rule it made, in a reply the contract's schema accepts; each refusal reaches the wire as
// its own type and number; and an answer the log could not keep is refused with no part of it
// written, so the ask still waits for an answer.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ApprovalRequestId, RememberedRuleId } from "@ai-sidekicks/contracts/approval";
import { JsonRpcErrorCode } from "@ai-sidekicks/contracts/jsonrpc/error-code";
import type { HandlerContext } from "@ai-sidekicks/contracts/jsonrpc/registry";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { NodeId } from "@ai-sidekicks/contracts/runtime-node/id";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { DeviceId } from "@ai-sidekicks/contracts/trust-statement";

import { captureRejection } from "../../../__fixtures__/capture-failure.js";
import { PermissionAsks } from "../../../approvals/permission-asks.js";
import { ApprovalProjectionService } from "../../../approvals/projection-service.js";
import { ApprovalRules } from "../../../approvals/rules.js";
import { ApprovalService } from "../../../approvals/service.js";
import {
  openScratchDatabase,
  type ScratchDatabase,
} from "../../../database/__fixtures__/scratch.js";
import { EventLogService } from "../../../events/log-service.js";
import { mapJsonRpcError } from "../../jsonrpc-error-mapping.js";
import { MethodRegistryImpl } from "../../registry.js";
import { registerApprovalMethods } from "../approval.js";

const SESSION_ID = "00000000-0000-7000-8000-000000000001" as SessionId;
const RUN_ID = "00000000-0000-7000-8000-0000000000b1" as RunId;
const UNKNOWN_ID = "00000000-0000-7000-8000-0000000000ff";
const LAPTOP: HandlerContext = { deviceId: "device-laptop" as DeviceId };
const PHONE: HandlerContext = { deviceId: "device-phone" as DeviceId };
const CREATED_AT = "2026-10-11T00:00:00.000Z";
// The client resolution ids of four separate presses.
const RESOLUTION_IDS = [
  "00000000-0000-4000-8000-0000000000d1",
  "00000000-0000-4000-8000-0000000000d2",
  "00000000-0000-4000-8000-0000000000d3",
  "00000000-0000-4000-8000-0000000000d4",
] as const;

// No ask is taken here, so no check is made.
function refuseCheck(): Promise<never> {
  return Promise.reject(new Error("no ask is taken here"));
}

let database: ScratchDatabase;
let service: ApprovalService;
let rules: ApprovalRules;
let registry: MethodRegistryImpl;

beforeEach(async () => {
  database = await openScratchDatabase();
  await database.writer.write([
    {
      sql: `INSERT INTO sessions (id, shape, state, created_at, updated_at, last_activity_at)
            VALUES (?, 'project', 'active', ?, ?, ?)`,
      bindings: [SESSION_ID, CREATED_AT, CREATED_AT, CREATED_AT],
    },
    {
      sql: "INSERT INTO runs (run_id, session_id, state, run_version) VALUES (?, ?, 'running', 1)",
      bindings: [RUN_ID, SESSION_ID],
    },
  ]);
  const sessionEvents = new EventLogService({
    writer: database.writer,
    reader: database.reader,
    writeServiceLog: (line) => {
      throw new Error(`unexpected service log line: ${line}`);
    },
  });
  service = new ApprovalService({
    reader: database.reader,
    sessionEvents,
    followAll: () => () => {},
    workingFolders: { raiseStaleness: async () => {} },
    writeServiceLog: (line) => {
      throw new Error(`unexpected service log line: ${line}`);
    },
  });
  rules = new ApprovalRules({
    reader: database.reader,
    sessionEvents,
    nodeId: "node-local" as NodeId,
    followAll: () => () => {},
    revokeAtProvider: async () => {},
    writeServiceLog: (line) => {
      throw new Error(`unexpected service log line: ${line}`);
    },
  });
  registry = new MethodRegistryImpl();
  registerApprovalMethods(registry, {
    asks: new PermissionAsks({
      approvals: service,
      permissionCheck: { check: refuseCheck },
      rules,
      respondToRequest: () => Promise.reject(new Error("no card here belongs to a provider")),
    }),
    projection: new ApprovalProjectionService(database.reader),
    rules,
    reviewerDenials: {
      overrideDenial: () => Promise.reject(new Error("no reviewer block is overruled here")),
    },
  });
});

afterEach(async () => {
  await database.close();
});

async function raiseAsk(subject: string): Promise<ApprovalRequestId> {
  const { approvalRequestId } = await service.create({
    sessionId: SESSION_ID,
    runId: RUN_ID,
    requestedBy: "agent-1",
    category: "tool_execution",
    scope: subject,
    resourceDescriptor: {
      subject,
      standingAllowOffered: true,
      projectScopeOffered: false,
      editable: true,
      action: { kind: "command", command: subject },
      toolName: "Bash",
    },
  });
  return approvalRequestId;
}

function resolveOver(
  context: HandlerContext,
  approvalRequestId: string,
  clientResolutionId: string,
): Promise<unknown> {
  return registry.dispatch(
    "approval.resolve",
    { approvalRequestId, decision: "approved", clientResolutionId },
    context,
  );
}

// The numeric code and `data.type` a call's refusal carries on the wire.
async function refusalOver(pending: Promise<unknown>): Promise<{ code: number; type: unknown }> {
  const { error } = mapJsonRpcError(await captureRejection(pending), 1);
  return { code: error.code, type: error.data?.type };
}

// Records the session allow over `subject` that the answer to `approvalRequestId` made.
async function rememberAllow(approvalRequestId: ApprovalRequestId, subject: string): Promise<void> {
  const stored = service.readRequest(approvalRequestId);
  if (stored === undefined) {
    throw new Error(`no request ${approvalRequestId}`);
  }
  await rules.record(stored, {
    rule: { kind: "session", sense: "allow", action: "command", subject },
    projectFolders: [],
  });
}

function readRows(approvalRequestId: ApprovalRequestId): { state: string; devices: string[] } {
  const { reader } = database;
  return {
    state:
      reader
        .prepare<[string], { state: string }>("SELECT state FROM approval_requests WHERE id = ?")
        .get(approvalRequestId)?.state ?? "missing",
    devices: reader
      .prepare<[string], { device_id: string }>(
        "SELECT device_id FROM approval_resolutions WHERE request_id = ?",
      )
      .all(approvalRequestId)
      .map((row) => row.device_id),
  };
}

describe("approval.* on the wire", () => {
  it("reads back each card with the device that answered it, its scope and its rule", async () => {
    const answered = await raiseAsk("npm test");
    await resolveOver(LAPTOP, answered, RESOLUTION_IDS[0]);
    await rememberAllow(answered, "npm test");
    const withdrawn = await raiseAsk("npm run build");
    await service.withdraw(withdrawn);
    const open = await raiseAsk("npm run lint");

    expect(
      await registry.dispatch("approval.projectionRead", { sessionId: SESSION_ID }, LAPTOP),
    ).toMatchObject({
      approvals: [
        {
          id: answered,
          state: "approved",
          decision: "approved",
          deviceId: "device-laptop",
          effectiveScope: "npm test",
          rememberedScope: { kind: "session", sense: "allow", pattern: "npm test" },
        },
        { id: withdrawn, state: "canceled" },
        { id: open, state: "pending" },
      ],
    });
    expect(
      await registry.dispatch(
        "approval.projectionRead",
        { sessionId: SESSION_ID, state: "pending" },
        LAPTOP,
      ),
    ).toMatchObject({ approvals: [{ id: open }] });
  });

  it("carries each answer and revoke refusal to the client as its type and number", async () => {
    const answered = await raiseAsk("npm test");
    await resolveOver(LAPTOP, answered, RESOLUTION_IDS[0]);
    const withdrawn = await raiseAsk("npm run build");
    await service.withdraw(withdrawn);

    expect(await refusalOver(resolveOver(PHONE, answered, RESOLUTION_IDS[1]))).toEqual({
      code: JsonRpcErrorCode.InvalidRequest,
      type: "approval.already_resolved",
    });
    expect(readRows(answered)).toEqual({ state: "approved", devices: ["device-laptop"] });
    expect(await refusalOver(resolveOver(LAPTOP, withdrawn, RESOLUTION_IDS[2]))).toEqual({
      code: JsonRpcErrorCode.InvalidRequest,
      type: "approval.request_canceled",
    });
    expect(await refusalOver(resolveOver(LAPTOP, UNKNOWN_ID, RESOLUTION_IDS[3]))).toEqual({
      code: JsonRpcErrorCode.InvalidParams,
      type: "approval.not_found",
    });

    await rememberAllow(answered, "npm test");
    const ruleId = answered as unknown as RememberedRuleId;
    await registry.dispatch("approval.ruleRevoke", { ruleId }, LAPTOP);

    expect(await refusalOver(registry.dispatch("approval.ruleRevoke", { ruleId }, LAPTOP))).toEqual(
      { code: JsonRpcErrorCode.InvalidRequest, type: "approval.rule_already_revoked" },
    );
    expect(
      await refusalOver(registry.dispatch("approval.ruleRevoke", { ruleId: UNKNOWN_ID }, LAPTOP)),
    ).toEqual({ code: JsonRpcErrorCode.InvalidParams, type: "approval.rule_not_found" });
  });

  it("refuses an answer the log could not keep, writing no part of it", async () => {
    const approvalRequestId = await raiseAsk("npm test");
    // The log's own write fails after the answer's rows went into the same write.
    await database.writer.write([
      {
        sql: `CREATE TRIGGER refuse_answers BEFORE INSERT ON session_events
                WHEN NEW.type = 'approval.approved'
                BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END`,
      },
    ]);

    expect(await refusalOver(resolveOver(LAPTOP, approvalRequestId, RESOLUTION_IDS[0]))).toEqual({
      code: JsonRpcErrorCode.InternalError,
      type: "approval.persistence_unavailable",
    });
    expect(readRows(approvalRequestId)).toEqual({ state: "pending", devices: [] });

    await database.writer.write([{ sql: "DROP TRIGGER refuse_answers" }]);
    await resolveOver(LAPTOP, approvalRequestId, RESOLUTION_IDS[0]);
    expect(readRows(approvalRequestId)).toEqual({ state: "approved", devices: ["device-laptop"] });
  });
});
