// `lifecycle.ts` runs: the spawn-bound sandbox and schema guard, interrupts that can only reach
// their own turn, and the tripwire that fails a run whose command-shaped text the provider
// swallowed.

import type { ExecutionPosture } from "@ai-sidekicks/contracts/provider/driver/driver";
import { describe, expect, it } from "vitest";

import { TextNeutralizationRefusedError } from "../../../../outbound-frame.js";
import type { CreateSessionParams, StartRunParams } from "../../../provider-driver.js";
import { drainMicrotasks } from "../../../../__fixtures__/drain-microtasks.js";
import {
  CLAUDE_ORDINARY_TURN_RESULT_FRAME,
  CLAUDE_ZERO_TURN_RESULT_FRAME,
} from "../__fixtures__/turn-evidence-transcripts.js";
import { ClaudeSessionUnavailableError } from "../session/errors.js";
import { ClaudeControlRequestRefusedError, type ClaudeRunDispatch } from "../session/transport.js";
import {
  buildStartRunParams,
  type FakeClaudeProviderProcess,
  TEST_RUN_ID,
  TEST_SECOND_RUN_ID,
  TEST_SESSION_ID,
} from "./test-doubles.js";
import {
  armRunDispatch,
  buildHarness,
  createLiveSession,
  rewindTestSession,
  spawnedChannel,
  startLiveRun,
  type LifecycleHarness,
} from "./lifecycle.test-support.js";

const SWALLOWED_RUN_FAILURE = {
  sessionId: TEST_SESSION_ID,
  runId: TEST_RUN_ID,
  providerFailureDetail: "driver.text_neutralization_failed origin=human_text",
};

async function startSecondRun(harness: LifecycleHarness, openingText: string): Promise<void> {
  armRunDispatch(harness, TEST_SECOND_RUN_ID, openingText);
  await harness.lifecycle.startRun({ ...buildStartRunParams(), runId: TEST_SECOND_RUN_ID });
}

async function startTestRun(harness: LifecycleHarness): Promise<void> {
  await harness.lifecycle.startRun(buildStartRunParams());
}

describe("ClaudeSessionLifecycle.startRun spawn-bound guard", () => {
  const SPAWN_POSTURE: ExecutionPosture = {
    mode: "sandboxed",
    credentialPolicyRef: "policy://default",
    writableRoots: ["/workspace", "/tmp/scratch"],
  };
  const SPAWN_SCHEMA: Record<string, unknown> = {
    type: "object",
    properties: { verdict: { type: "string" }, score: { type: "number" } },
    required: ["verdict", "score"],
  };

  // A run is admitted only into a process spawned with the same sandbox on every axis and the
  // same schema by canonical digest (key order is not semantic in JSON, array order is). The
  // admitted rows catch a guard that refuses too much, which would refuse every real run.
  const SPAWN_BOUND_RUNS: ReadonlyArray<{
    readonly label: string;
    readonly spawn: Partial<CreateSessionParams>;
    readonly run: Partial<StartRunParams>;
    readonly refusal: string | null;
  }> = [
    {
      label: "a run whose sandbox level differs",
      spawn: { executionPosture: SPAWN_POSTURE },
      run: { executionPosture: { ...SPAWN_POSTURE, mode: "yolo" } },
      refusal: "execution_posture_mismatch",
    },
    {
      label: "a run that adds a writable root",
      spawn: { executionPosture: SPAWN_POSTURE },
      run: {
        executionPosture: {
          ...SPAWN_POSTURE,
          writableRoots: ["/workspace", "/tmp/scratch", "/etc"],
        },
      },
      refusal: "execution_posture_mismatch",
    },
    {
      label: "a run whose roots repeat one root",
      spawn: { executionPosture: SPAWN_POSTURE },
      run: { executionPosture: { ...SPAWN_POSTURE, writableRoots: ["/workspace", "/workspace"] } },
      refusal: "execution_posture_mismatch",
    },
    {
      label: "a run under another credential policy",
      spawn: { executionPosture: SPAWN_POSTURE },
      run: { executionPosture: { ...SPAWN_POSTURE, credentialPolicyRef: "policy://elevated" } },
      refusal: "execution_posture_mismatch",
    },
    {
      label: "a posture-declaring run in a session spawned with none",
      spawn: {},
      run: { executionPosture: SPAWN_POSTURE },
      refusal: "execution_posture_mismatch",
    },
    {
      // A fresh object, as the daemon re-materializes the posture per call, with its roots in
      // another order.
      label: "an equal posture with its roots reordered",
      spawn: { executionPosture: SPAWN_POSTURE },
      run: {
        executionPosture: { ...SPAWN_POSTURE, writableRoots: ["/tmp/scratch", "/workspace"] },
      },
      refusal: null,
    },
    {
      label: "a run carrying a different schema",
      spawn: { outputSchema: SPAWN_SCHEMA },
      run: {
        outputSchema: {
          type: "object",
          properties: { verdict: { type: "string" } },
          required: ["verdict"],
        },
      },
      refusal: "output_schema_mismatch",
    },
    {
      label: "a schema differing only in array order",
      spawn: { outputSchema: SPAWN_SCHEMA },
      run: { outputSchema: { ...SPAWN_SCHEMA, required: ["score", "verdict"] } },
      refusal: "output_schema_mismatch",
    },
    {
      label: "a schema-constrained run in a session spawned without one",
      spawn: {},
      run: { outputSchema: { type: "object" } },
      refusal: "output_schema_unbound",
    },
    {
      label: "the same schema with its keys reordered",
      spawn: { outputSchema: SPAWN_SCHEMA },
      run: {
        outputSchema: {
          required: ["verdict", "score"],
          properties: { score: { type: "number" }, verdict: { type: "string" } },
          type: "object",
        },
      },
      refusal: null,
    },
  ];

  it.each(SPAWN_BOUND_RUNS)("decides $label", async ({ spawn, run, refusal }) => {
    const harness = buildHarness();
    const channel = await createLiveSession(harness, spawn);
    armRunDispatch(harness);

    const starting = harness.lifecycle.startRun({ ...buildStartRunParams(), ...run });

    if (refusal === null) {
      await starting;
      expect(channel.sentWireTexts).toStrictEqual(["review the diff"]);
    } else {
      await expect(starting).rejects.toMatchObject({
        code: "driver.unavailable",
        fields: { reason: refusal },
      });
      expect(channel.sentWireTexts).toStrictEqual([]);
    }
  });
});

describe("ClaudeSessionLifecycle run dispatch and interrupt", () => {
  it("refuses a second dispatch until the opening frame settles, then admits it", async () => {
    // The tripwire attributes one frame per run key, so a duplicate dispatch would quarantine
    // the session.
    const harness = buildHarness();
    const channel = await startLiveRun(harness);

    await expect(startTestRun(harness)).rejects.toMatchObject({
      code: "driver.unavailable",
      fields: { reason: "run_already_dispatched" },
    });
    expect(channel.sentWireTexts).toStrictEqual(["review the diff"]);
    channel.emitStreamFrame("result/success");
    expect(harness.textNeutralizationFailures).toStrictEqual([]);

    await startTestRun(harness);
    expect(channel.sentWireTexts).toStrictEqual(["review the diff", "review the diff"]);
  });

  it("throws rather than reporting success when the CLI refuses the interrupt", async () => {
    const harness = buildHarness();
    const channel = await startLiveRun(harness);
    channel.controlResponse = {
      subtype: "error",
      error: "Unsupported control request subtype: interrupt",
    };

    await expect(harness.lifecycle.interruptRun({ runId: TEST_RUN_ID })).rejects.toBeInstanceOf(
      ClaudeControlRequestRefusedError,
    );
  });

  // Claude's interrupt is channel-level, so a route outliving its turn would aim a late
  // interrupt at whatever turn the channel runs next.
  it.each(["result/success", "result/error_max_turns"])(
    "retires the run's route on a %s terminal and keeps it until then",
    async (terminalFrameKind) => {
      const harness = buildHarness();
      const channel = await startLiveRun(harness);

      expect(channel.emitStreamFrame("system/task_progress")).toStrictEqual({
        decision: "project",
      });
      expect(harness.lifecycle.findProcessForRun(TEST_RUN_ID)).toBe(channel);
      channel.emitStreamFrame(terminalFrameKind);

      await expect(harness.lifecycle.interruptRun({ runId: TEST_RUN_ID })).rejects.toMatchObject({
        code: "driver.unavailable",
        fields: { reason: "no_live_run" },
      });
      expect(channel.controlRequests).toStrictEqual([]);
    },
  );

  it("ignores a terminal from a channel that is no longer the live one", async () => {
    const harness = buildHarness();
    const staleChannel = await startLiveRun(harness);
    staleChannel.disposeFailure = new Error("the provider process would not exit");
    await expect(harness.lifecycle.closeSession({ sessionId: TEST_SESSION_ID })).rejects.toThrow();
    staleChannel.disposeFailure = undefined;
    await harness.lifecycle.closeSession({ sessionId: TEST_SESSION_ID });
    const liveChannel = await createLiveSession(harness);
    await startSecondRun(harness, "now the next task");

    // The driver holds no kill, so the old process can still emit after the daemon stopped
    // listening; its terminal must not retire the live run's route.
    staleChannel.emitStreamFrame("result/success");

    expect(harness.lifecycle.findProcessForRun(TEST_SECOND_RUN_ID)).toBe(liveChannel);
  });
});

describe("ClaudeSessionLifecycle provider-bound text tripwire", () => {
  it("neutralizes command-shaped text on the wire only, not in the daemon's record", async () => {
    const harness = buildHarness();
    const channel = await startLiveRun(harness, "/status please");

    expect(channel.sentWireTexts).toStrictEqual(["\n/status please"]);
    expect(channel.sentAuthoredTexts).toStrictEqual(["/status please"]);
    // The dispatch record feeds the persisted event row and any rollback target.
    expect(harness.runDispatchResolver.dispatchByRunId.get(TEST_RUN_ID)?.openingText).toBe(
      "/status please",
    );
  });

  it("ignores an exempt origin smuggled onto the dispatch record", async () => {
    // `driver_command` delivers bytes verbatim and excuses the turn from the tripwire, so a
    // dispatch record carrying it would run the person's words as a provider command.
    const harness = buildHarness();
    const channel = await createLiveSession(harness);
    harness.runDispatchResolver.dispatchByRunId.set(TEST_RUN_ID, {
      sessionId: TEST_SESSION_ID,
      openingText: "/compact",
      frameOrigin: "driver_command",
    } as ClaudeRunDispatch);
    await startTestRun(harness);

    expect(channel.sentWireTexts).toStrictEqual(["\n/compact"]);
    channel.terminalFrameBody = CLAUDE_ZERO_TURN_RESULT_FRAME;
    channel.emitStreamFrame("result/success");
    expect(harness.textNeutralizationFailures).toStrictEqual([SWALLOWED_RUN_FAILURE]);
  });

  it("fails a swallowed turn, tears down and quarantines its session; a new one runs", async () => {
    const harness = buildHarness();
    const channel = await startLiveRun(harness, "/status please");

    channel.terminalFrameBody = CLAUDE_ZERO_TURN_RESULT_FRAME;
    channel.emitStreamFrame("result/success");
    await drainMicrotasks();

    expect(harness.textNeutralizationFailures).toStrictEqual([SWALLOWED_RUN_FAILURE]);
    // Refused rather than `undefined`, which would read as "no channel" and invite a retry into
    // the same swallow.
    expect(() => harness.lifecycle.findProcessForRun(TEST_RUN_ID)).toThrow(
      TextNeutralizationRefusedError,
    );
    expect(channel.disposals).toStrictEqual(["session_closed"]);
    await expect(startSecondRun(harness, "carry on")).rejects.toThrow(
      TextNeutralizationRefusedError,
    );
    expect(channel.sentWireTexts).toStrictEqual(["\n/status please"]);

    // The quarantine names a binding, not the session id, so recovery is a fresh session.
    await createLiveSession(harness);
    await expect(startSecondRun(harness, "carry on")).resolves.toBeUndefined();
  });

  it("still fails a swallowed turn that was interrupted before its terminal arrived", async () => {
    const harness = buildHarness();
    const channel = await startLiveRun(harness, "/status please");

    await harness.lifecycle.interruptRun({ runId: TEST_RUN_ID, reason: "user_stop" });
    channel.terminalFrameBody = CLAUDE_ZERO_TURN_RESULT_FRAME;
    channel.emitStreamFrame("result/success");
    await drainMicrotasks();

    expect(harness.textNeutralizationFailures).toStrictEqual([SWALLOWED_RUN_FAILURE]);
    await expect(startSecondRun(harness, "carry on")).rejects.toThrow(
      TextNeutralizationRefusedError,
    );
  });

  it("refuses a busy session's second run before writing; it gets no interrupt route", async () => {
    // The interrupt is channel-scoped, so a route left for the refused run would stop the older
    // turn still running on the session.
    const harness = buildHarness();
    const channel = await startLiveRun(harness, "first turn");

    await expect(startSecondRun(harness, "one more")).rejects.toMatchObject({
      code: "driver.unavailable",
      fields: { reason: "session_turn_in_flight" },
    });

    expect(channel.sentWireTexts).toHaveLength(1);
    await expect(
      harness.lifecycle.interruptRun({ runId: TEST_SECOND_RUN_ID, reason: "user_stop" }),
    ).rejects.toThrow(ClaudeSessionUnavailableError);
    expect(channel.controlRequests).toStrictEqual([]);
    channel.terminalFrameBody = CLAUDE_ORDINARY_TURN_RESULT_FRAME;
    channel.emitStreamFrame("result/success");
    expect(harness.textNeutralizationFailures).toStrictEqual([]);
  });

  // An ambiguous write is retained for the turn's own terminal to rule, never retried (the bytes
  // may have reached the provider) and never assumed sent cleanly. A transport that rejects
  // instead of reporting makes no claim about bytes, so it lands on the same arm.
  const WRITE_OUTCOMES: ReadonlyArray<{
    readonly label: string;
    readonly breakWrite: (channel: FakeClaudeProviderProcess) => void;
    readonly writeFails: boolean;
    readonly terminalFrameBody: Readonly<Record<string, unknown>>;
    readonly trips: boolean;
  }> = [
    {
      label: "a clean write followed by a genuine model turn",
      breakWrite: () => undefined,
      writeFails: false,
      terminalFrameBody: CLAUDE_ORDINARY_TURN_RESULT_FRAME,
      trips: false,
    },
    {
      label: "an indeterminate write followed by a zero-turn terminal",
      breakWrite: (channel) => {
        channel.sendUserTextFailure = new Error("the provider stream is closed");
        channel.sendUserTextDelivery = "indeterminate";
      },
      writeFails: true,
      terminalFrameBody: CLAUDE_ZERO_TURN_RESULT_FRAME,
      trips: true,
    },
    {
      label: "an indeterminate write followed by a genuine model turn",
      breakWrite: (channel) => {
        channel.sendUserTextFailure = new Error("the provider stream is closed");
        channel.sendUserTextDelivery = "indeterminate";
      },
      writeFails: true,
      terminalFrameBody: CLAUDE_ORDINARY_TURN_RESULT_FRAME,
      trips: false,
    },
    {
      label: "a rejected write followed by a zero-turn terminal",
      breakWrite: (channel) => {
        channel.sendUserTextRejection = new Error("the transport threw instead of reporting");
      },
      writeFails: true,
      terminalFrameBody: CLAUDE_ZERO_TURN_RESULT_FRAME,
      trips: true,
    },
  ];

  it.each(WRITE_OUTCOMES)("rules $label", async (row) => {
    const harness = buildHarness();
    const channel = await createLiveSession(harness);
    row.breakWrite(channel);
    armRunDispatch(harness, TEST_RUN_ID, "/status please");

    const starting = startTestRun(harness);
    await (row.writeFails ? expect(starting).rejects.toThrow() : starting);
    expect(channel.sendUserTextAttempts).toBe(1);
    channel.terminalFrameBody = row.terminalFrameBody;
    channel.emitStreamFrame("result/success");
    await drainMicrotasks();

    if (row.trips) {
      expect(harness.textNeutralizationFailures).toStrictEqual([SWALLOWED_RUN_FAILURE]);
      expect(() => harness.lifecycle.findProcessForRun(TEST_RUN_ID)).toThrow(
        TextNeutralizationRefusedError,
      );
    } else {
      expect(harness.textNeutralizationFailures).toStrictEqual([]);
      expect(() => harness.lifecycle.findProcessForRun(TEST_RUN_ID)).not.toThrow();
    }
  });

  it("rules an ambiguous write now when the channel can no longer deliver a terminal", async () => {
    const harness = buildHarness();
    const channel = await createLiveSession(harness);
    channel.sendUserTextFailure = new Error("the provider stream is closed");
    channel.sendUserTextDelivery = "indeterminate";
    channel.isClosed = true;
    armRunDispatch(harness, TEST_RUN_ID, "/status please");

    await expect(startTestRun(harness)).rejects.toThrow("the provider stream is closed");
    await drainMicrotasks();

    expect(harness.textNeutralizationFailures).toStrictEqual([SWALLOWED_RUN_FAILURE]);
    expect(() => harness.lifecycle.findProcessForRun(TEST_RUN_ID)).toThrow(
      TextNeutralizationRefusedError,
    );
    expect(channel.disposals).toStrictEqual(["session_closed"]);
    await expect(startSecondRun(harness, "carry on")).rejects.toThrow(
      TextNeutralizationRefusedError,
    );
  });

  it("drops a provably unsent frame and its route, so neither reaches a later run", async () => {
    const harness = buildHarness();
    const channel = await createLiveSession(harness);
    channel.sendUserTextFailure = new Error("the provider stream is closed");
    channel.sendUserTextDelivery = "unsent";
    armRunDispatch(harness, TEST_RUN_ID, "/status please");
    await expect(startTestRun(harness)).rejects.toThrow("the provider stream is closed");

    await expect(
      harness.lifecycle.interruptRun({ runId: TEST_RUN_ID, reason: "user_stop" }),
    ).rejects.toThrow(ClaudeSessionUnavailableError);
    expect(channel.controlRequests).toStrictEqual([]);

    // A stale registration would consume this run's evidence and fail it.
    channel.sendUserTextFailure = undefined;
    await startSecondRun(harness, "second turn");
    channel.terminalFrameBody = CLAUDE_ORDINARY_TURN_RESULT_FRAME;
    channel.emitStreamFrame("result/success");
    expect(harness.textNeutralizationFailures).toStrictEqual([]);
  });

  it("keeps the predecessor's pending frame ruled when a rewind's adoption fails", async () => {
    // The restored predecessor is still mid-turn; dropping its correlation would let its
    // evidence-free terminal pass as a completed turn.
    const harness = buildHarness();
    const predecessorChannel = await startLiveRun(harness, "/status please");
    harness.transport.onTurnTerminalFailure = new Error("the transport refused the terminal hook");

    const rollback = await rewindTestSession(harness);

    expect(rollback.status).toBe("degraded");
    expect(harness.lifecycle.findProcessForRun(TEST_RUN_ID)).toBe(predecessorChannel);
    expect(spawnedChannel(harness, 1).disposals).toStrictEqual(["establishment_failed"]);
    predecessorChannel.terminalFrameBody = CLAUDE_ZERO_TURN_RESULT_FRAME;
    predecessorChannel.emitStreamFrame("result/success");
    expect(harness.textNeutralizationFailures).toStrictEqual([SWALLOWED_RUN_FAILURE]);
  });

  it("quarantines the run and records the throw even if the failure consumer throws", async () => {
    const harness = buildHarness({
      onTextNeutralizationFailure: () => {
        throw new Error("the emission pipeline is unavailable");
      },
    });
    const channel = await startLiveRun(harness, "/status please");

    channel.terminalFrameBody = CLAUDE_ZERO_TURN_RESULT_FRAME;
    expect(() => channel.emitStreamFrame("result/success")).not.toThrow();
    expect(() => harness.lifecycle.findProcessForRun(TEST_RUN_ID)).toThrow(
      TextNeutralizationRefusedError,
    );
    expect(
      harness.diagnostics.recentRecordsOfKind("text_neutralization_trip_report_failed"),
    ).toMatchObject([{ details: { sessionId: TEST_SESSION_ID, runId: TEST_RUN_ID } }]);
  });
});

// A pending opening frame is ruled on every transition that takes its binding: a rewind owes the
// run a visible failure, a daemon-initiated close owes none because the daemon asked for it.
describe("ClaudeSessionLifecycle pending frames across rewind and close", () => {
  const TRANSITIONS: ReadonlyArray<{
    readonly label: string;
    readonly frame: "pending" | "settled" | "none";
    readonly transition: "rewind" | "close";
    readonly reportedDetail: string | null;
  }> = [
    {
      label: "fails the run on a rewind that supersedes its pending frame",
      frame: "pending",
      transition: "rewind",
      reportedDetail: "was superseded by a fresh spawn",
    },
    {
      label: "reports nothing on a daemon-initiated close",
      frame: "pending",
      transition: "close",
      reportedDetail: null,
    },
    {
      label: "reports nothing on a rewind of an idle session",
      frame: "none",
      transition: "rewind",
      reportedDetail: null,
    },
    {
      label: "reports nothing on a rewind after the turn's own terminal settled the frame",
      frame: "settled",
      transition: "rewind",
      reportedDetail: null,
    },
  ];

  it.each(TRANSITIONS)("$label", async ({ frame, transition, reportedDetail }) => {
    const harness = buildHarness();
    if (frame === "none") {
      await createLiveSession(harness);
    } else {
      const channel = await startLiveRun(harness, "/compact the thread please");
      if (frame === "settled") {
        channel.emitStreamFrame("result/success");
      }
    }

    await (transition === "rewind"
      ? rewindTestSession(harness)
      : harness.lifecycle.closeSession({ sessionId: TEST_SESSION_ID }));

    expect(harness.textNeutralizationFailures).toMatchObject(
      reportedDetail === null
        ? []
        : [
            {
              sessionId: TEST_SESSION_ID,
              runId: TEST_RUN_ID,
              providerFailureDetail: expect.stringContaining(reportedDetail),
            },
          ],
    );
  });

  it("leaves a superseded run attachable and the rewound session startable", async () => {
    // A quarantine condemns a binding, and the superseded one is already gone; refusing the run
    // would strip its interrupt and intervention controls.
    const harness = buildHarness();
    await startLiveRun(harness, "/compact the thread please");
    await rewindTestSession(harness);

    expect(() => harness.lifecycle.findProcessForRun(TEST_RUN_ID)).not.toThrow();
    await startSecondRun(harness, "carry on from the fork");
    expect(harness.lifecycle.findProcessForRun(TEST_SECOND_RUN_ID)).toBe(
      spawnedChannel(harness, 1),
    );
  });
});
