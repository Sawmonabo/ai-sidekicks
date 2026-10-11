// How an ask holds its run, over a real run engine and approval service: the run waits from its
// first ask until no ask is left open, a second ask changes nothing, an ask raised while the run
// could not wait holds it once it runs, an answer never pulls a run out of a state it moved to
// meanwhile, an answer that races its ask's block still leaves the run running, and a run's end
// cancels the asks it still holds, leaving its answered ones and another run's alone.

import { afterEach, beforeEach, expect, it } from "vitest";

import type { ApprovalRequestId } from "@ai-sidekicks/contracts/approval";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { DeviceId } from "@ai-sidekicks/contracts/trust-statement";

import {
  openRunEngineFixture,
  type RunEngineFixture,
} from "../../session/run/__tests__/engine.test-support.js";
import type { RunTransitionRequest } from "../../session/run/engine.js";
import { ApprovalRunBlocking } from "../run-blocking.js";
import { ApprovalService } from "../service.js";

const LAPTOP = "device-laptop" as DeviceId;

let fixture: RunEngineFixture;
let service: ApprovalService;
let forgottenRuns: RunId[];
let stopHolding: (() => Promise<void>) | undefined;

beforeEach(async () => {
  fixture = await openRunEngineFixture();
  service = new ApprovalService({
    reader: fixture.database.reader,
    sessionEvents: fixture.sessionEvents,
    followAll: () => () => {},
    workingFolders: { raiseStaleness: async () => {} },
    writeServiceLog: (line) => {
      throw new Error(`unexpected service log line: ${line}`);
    },
  });
  forgottenRuns = [];
});

// Registers the run hold over `runEngine`, the fixture's own unless a test stands one in front.
function holdRuns(
  runEngine: Pick<RunEngineFixture["engine"], "applyProviderStateChange"> = fixture.engine,
): void {
  const blocking = new ApprovalRunBlocking({
    runEngine,
    approvals: service,
    forgetRun: (runId) => {
      forgottenRuns.push(runId);
    },
    followAll: (onCommitted, onGap) => fixture.sessionEvents.followAll(onCommitted, onGap),
    writeServiceLog: (line) => {
      throw new Error(`unexpected service log line: ${line}`);
    },
  });
  service.registerApprovalOutcomeListener(blocking);
  fixture.engine.registerSetupGate(blocking);
  blocking.start();
  stopHolding = () => blocking.stop();
}

afterEach(async () => {
  await stopHolding?.();
  stopHolding = undefined;
  await fixture.close();
});

async function raiseAsk(runId: RunId, subject: string): Promise<ApprovalRequestId> {
  const { approvalRequestId } = await service.create({
    sessionId: fixture.sessionId,
    runId,
    requestedBy: "agent-1",
    category: "tool_execution",
    scope: subject,
    resourceDescriptor: {
      subject,
      standingAllowOffered: false,
      projectScopeOffered: false,
      editable: false,
      toolName: "Bash",
    },
  });
  return approvalRequestId;
}

async function approve(approvalRequestId: ApprovalRequestId): Promise<void> {
  await service.resolve(
    { approvalRequestId, decision: "approved", clientResolutionId: approvalRequestId },
    LAPTOP,
  );
}

function stateOf(runId: RunId): string | undefined {
  return fixture.runs.getRun(runId)?.state;
}

it("holds the run from its first ask until no ask is left open", async () => {
  holdRuns();
  const runId = await fixture.runThrough(["starting", "running"]);

  const first = await raiseAsk(runId, "npm test");
  const second = await raiseAsk(runId, "npm run build");
  await approve(first);

  expect(stateOf(runId)).toBe("waiting_for_approval");

  await approve(second);

  expect(stateOf(runId)).toBe("running");
  expect(
    fixture
      .readRunEvents(runId)
      .map((row) => row.payload["newState"])
      .slice(3),
  ).toEqual(["waiting_for_approval", "running"]);
});

it("holds a run that could not wait when its ask came as soon as it runs", async () => {
  holdRuns();
  const runId = await fixture.runThrough(["starting"]);
  const ask = await raiseAsk(runId, "npm test");

  expect(stateOf(runId)).toBe("starting");

  await fixture.engine.transition({ runId, newState: "running" });

  await expect.poll(() => stateOf(runId)).toBe("waiting_for_approval");
  await approve(ask);
  expect(stateOf(runId)).toBe("running");
});

it("leaves a run that moved on meanwhile where it is when its ask is answered", async () => {
  holdRuns();
  const runId = await fixture.runThrough(["starting", "running"]);
  const ask = await raiseAsk(runId, "npm test");
  await fixture.engine.transition({ runId, newState: "waiting_for_input" });

  await approve(ask);

  expect(stateOf(runId)).toBe("waiting_for_input");
});

it("runs the run again when its ask is answered while its block is still being written", async () => {
  const runId = await fixture.runThrough(["starting", "running"]);
  // The block's move is held until the answer has asked for its own move.
  let releaseBlock = (): void => {};
  const blockHeld = new Promise<void>((resolve) => {
    releaseBlock = resolve;
  });
  let settleAsked = (): void => {};
  const settleAskedFor = new Promise<void>((resolve) => {
    settleAsked = resolve;
  });
  const engine = fixture.engine;
  const blocking = new ApprovalRunBlocking({
    runEngine: {
      applyProviderStateChange: async (change: RunTransitionRequest) => {
        if (change.newState === "waiting_for_approval") {
          await blockHeld;
        }
        return await engine.applyProviderStateChange(change);
      },
    },
    approvals: service,
    forgetRun: () => {},
    followAll: () => () => {},
    writeServiceLog: () => {},
  });
  service.registerApprovalOutcomeListener({
    onBlocking: async (blockedRunId, approvalRequestId) => {
      await blocking.onBlocking(blockedRunId, approvalRequestId);
    },
    onSettled: async (settledRunId, approvalRequestId) => {
      const settling = blocking.onSettled(settledRunId, approvalRequestId);
      settleAsked();
      await settling;
    },
  });

  const raising = raiseAsk(runId, "npm test");
  await expect.poll(() => service.hasPendingForRun(runId)).toBe(true);
  const [pending] = fixture.database.reader
    .prepare<[], { id: ApprovalRequestId }>("SELECT id FROM approval_requests")
    .all();
  const answering = approve(pending?.id ?? ("" as ApprovalRequestId));
  await settleAskedFor;
  releaseBlock();
  await Promise.all([raising, answering]);

  expect(stateOf(runId)).toBe("running");
});

it("cancels the asks a run still holds when it ends, leaving its answered ones and other runs alone", async () => {
  holdRuns();
  const runId = await fixture.runThrough(["starting", "running"]);
  const otherRunId = await fixture.runThrough(["starting", "running"]);
  const open = await raiseAsk(runId, "npm test");
  const answered = await raiseAsk(runId, "git fetch");
  const otherRunAsk = await raiseAsk(otherRunId, "git pull");
  await approve(answered);

  await fixture.engine.transition({ runId, newState: "interrupted" });

  expect(service.readRequest(open)?.state).toBe("canceled");
  expect(service.readRequest(answered)?.state).toBe("approved");
  expect(service.readRequest(otherRunAsk)?.state).toBe("pending");
  expect(forgottenRuns).toEqual([runId]);
  // A cancel settles the ask with its event and no answer row, so a late answer is refused.
  expect(
    fixture.database.reader
      .prepare<
        [string],
        { n: number }
      >(`SELECT (SELECT COUNT(*) FROM approval_resolutions WHERE request_id = ?) AS n`)
      .get(open)?.n,
  ).toBe(0);
  expect(
    fixture.database.reader
      .prepare<[], { id: string }>(
        `SELECT json_extract(payload, '$.approvalRequestId') AS id FROM session_events
          WHERE type = 'approval.canceled'`,
      )
      .all()
      .map((row) => row.id),
  ).toEqual([open]);
  await expect(approve(open)).rejects.toMatchObject({ code: "approval.request_canceled" });
});
