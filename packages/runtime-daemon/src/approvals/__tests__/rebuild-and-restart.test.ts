// The approval record across a rebuild and a restart, over a real run engine and log:
//
//   * A rebuild from the log writes the approval rows the live writes wrote, so each provider ask
//     still finds its own card by the daemon's ask id with several open on one run, and the answer
//     that made a rule still carries it. A rebuild cut before an event leaves no row it wrote.
//   * A restart ends the run that was waiting on an ask, and its ask settles canceled with it, so a
//     late answer is refused and no card waits on a run that is gone.

import { afterEach, beforeEach, expect, it } from "vitest";

import { RememberedRuleIdSchema, type ApprovalRequestId } from "@ai-sidekicks/contracts/approval";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { NodeId } from "@ai-sidekicks/contracts/runtime-node/id";
import type { DeviceId } from "@ai-sidekicks/contracts/trust-statement";

import { ProjectionRebuildService } from "../../recovery/projection-rebuild.js";
import {
  openRunEngineFixture,
  type RunEngineFixture,
} from "../../session/run/__tests__/engine.test-support.js";
import type { RunEngine } from "../../session/run/engine.js";
import { SessionService } from "../../session/service.js";
import { ApprovalEventEmitter } from "../event-emitter.js";
import { APPROVALS_PROJECTION } from "../projection.js";
import { ApprovalRunBlocking } from "../run-blocking.js";
import { ApprovalService } from "../service.js";
import { rememberedScopeStatement } from "../store.js";

const LAPTOP = "device-laptop" as DeviceId;
const NODE_ID = "00000000-0000-7000-8000-0000000000e1" as NodeId;
const RESTART_DETAIL = "The background service restarted.";

let fixture: RunEngineFixture;
let stops: (() => Promise<void>)[];

beforeEach(async () => {
  fixture = await openRunEngineFixture();
  stops = [];
});

afterEach(async () => {
  for (const stop of stops) {
    await stop();
  }
  await fixture.close();
});

// The approval service and the run hold as one start of the daemon builds them over `engine`.
function startApprovals(engine: RunEngine): ApprovalService {
  const service = new ApprovalService({
    reader: fixture.database.reader,
    sessionEvents: fixture.sessionEvents,
    followAll: () => () => {},
    workingFolders: { raiseStaleness: async () => {} },
    writeServiceLog: (line) => {
      throw new Error(`unexpected service log line: ${line}`);
    },
  });
  const blocking = new ApprovalRunBlocking({
    runEngine: engine,
    approvals: service,
    forgetRun: () => {},
    followAll: (onCommitted, onGap) => fixture.sessionEvents.followAll(onCommitted, onGap),
    writeServiceLog: (line) => {
      throw new Error(`unexpected service log line: ${line}`);
    },
  });
  service.registerApprovalOutcomeListener(blocking);
  engine.registerSetupGate(blocking);
  blocking.start();
  stops.push(() => blocking.stop());
  return service;
}

async function raiseAsk(
  service: ApprovalService,
  runId: RunId,
  askId: string,
  command: string,
): Promise<ApprovalRequestId> {
  const { approvalRequestId } = await service.create(
    {
      sessionId: fixture.sessionId,
      runId,
      requestedBy: "agent-1",
      category: "tool_execution",
      scope: command,
      resourceDescriptor: {
        subject: command,
        standingAllowOffered: true,
        projectScopeOffered: false,
        editable: true,
        action: { kind: "command", command },
        toolName: "Bash",
      },
    },
    { askId, toolCallId: `call-${askId}` },
  );
  return approvalRequestId;
}

function readApprovalRows(): { requests: unknown[]; resolutions: unknown[] } {
  const { reader } = fixture.database;
  return {
    requests: reader.prepare("SELECT * FROM approval_requests ORDER BY id").all(),
    resolutions: reader.prepare("SELECT * FROM approval_resolutions ORDER BY request_id").all(),
  };
}

function sequenceOf(type: string, approvalRequestId: ApprovalRequestId): number {
  const row = fixture.database.reader
    .prepare<[string, string], { sequence: number }>(
      `SELECT sequence FROM session_events
        WHERE type = ? AND json_extract(payload, '$.approvalRequestId') = ?`,
    )
    .get(type, approvalRequestId);
  if (row === undefined) {
    throw new Error(`No ${type} for ${approvalRequestId}`);
  }
  return row.sequence;
}

it("rebuilds the approval rows the live writes wrote, each ask still routed to its own card", async () => {
  const service = startApprovals(fixture.engine);
  const runId = await fixture.runThrough(["starting", "running"]);
  const answered = await raiseAsk(service, runId, "ask-a", "npm test");
  const open = await raiseAsk(service, runId, "ask-b", "npm run build");
  await service.resolve(
    { approvalRequestId: answered, decision: "approved", clientResolutionId: answered },
    LAPTOP,
  );
  // The rule the answer made, recorded once its provider kept it, as the rules record one.
  const rememberedScope = { kind: "session", sense: "allow", pattern: "npm test" } as const;
  await new ApprovalEventEmitter(fixture.sessionEvents).remembered(
    {
      sessionId: fixture.sessionId,
      runId,
      approvalRequestId: answered,
      category: "tool_execution",
      scope: "npm test",
      nodeId: NODE_ID,
      ruleId: RememberedRuleIdSchema.parse(answered),
      rememberedScope,
    },
    {
      occurredAt: new Date().toISOString(),
      statements: [rememberedScopeStatement(answered, rememberedScope)],
    },
  );
  const liveRows = readApprovalRows();
  // The rebuild must write every row itself, so none is left from the live writes.
  await fixture.database.writer.write([
    { sql: "DELETE FROM approval_resolutions" },
    { sql: "DELETE FROM approval_requests" },
  ]);
  const rebuild = new ProjectionRebuildService({
    reader: fixture.database.reader,
    writer: fixture.database.writer,
    sessionEvents: new SessionService(fixture.database.reader),
    projections: [APPROVALS_PROJECTION],
  });

  await rebuild.rebuild({ sessionId: fixture.sessionId, force: true });

  expect(readApprovalRows()).toStrictEqual(liveRows);
  expect(service.readAskRequest(runId, "ask-b")).toMatchObject({
    approvalRequestId: open,
    state: "pending",
  });
  expect(service.readAskRequest(runId, "ask-a")).toMatchObject({
    approvalRequestId: answered,
    state: "approved",
    resolution: { deviceId: LAPTOP, rememberedScope },
  });

  // Cut before the answer: the answer and its rule are gone, and both asks wait again.
  await rebuild.rebuild({
    sessionId: fixture.sessionId,
    force: true,
    beforeSequence: sequenceOf("approval.approved", answered),
  });

  expect(readApprovalRows().resolutions).toEqual([]);
  expect(
    [answered, open].map((approvalRequestId) => service.readRequest(approvalRequestId)?.state),
  ).toEqual(["pending", "pending"]);
});

it("cancels the ask of a run a restart ended, so a late answer is refused", async () => {
  const before = startApprovals(fixture.engine);
  const runId = await fixture.runThrough(["starting", "running"]);
  const open = await raiseAsk(before, runId, "ask-a", "npm test");
  expect(fixture.runs.getRun(runId)?.state).toBe("waiting_for_approval");

  // The daemon starts again: a fresh engine and pipeline, then the recovery pass ends live runs.
  const engine = fixture.restartEngine();
  const after = startApprovals(engine);
  for (const run of fixture.runs.listLiveRuns()) {
    await engine.settleRunAfterRestart(run, RESTART_DETAIL);
  }

  expect(fixture.runs.getRun(runId)?.state).toBe("failed");
  expect(after.readRequest(open)?.state).toBe("canceled");
  await expect(
    after.resolve(
      { approvalRequestId: open, decision: "approved", clientResolutionId: open },
      LAPTOP,
    ),
  ).rejects.toMatchObject({ code: "approval.request_canceled" });
});
