// `lifecycle.ts` runs: the spawn-bound sandbox and schema guard, the one turn a session holds,
// interrupts that can only reach their own turn, text sent as typed, the words the daemon answers
// itself with no run, and the run a rewind supersedes.

import { Writable } from "node:stream";

import type { ExecutionPosture } from "@ai-sidekicks/contracts/provider/driver/capabilities";
import { describe, expect, it, vi } from "vitest";

import type { CreateSessionParams, StartRunParams } from "../../contract.js";
import type { SessionCommandAnswer } from "../../session-control.js";
import { ClaudeRequestTimeoutError, ClaudeSessionUnavailableError } from "../session/errors.js";
import { writeStdinLine } from "../session/stdin-write.js";
import {
  ClaudeControlRequestRefusedError,
  composeClaudeUserFrame,
  type ClaudeUserFrame,
} from "../session/transport.js";
import {
  buildStartRunParams,
  type FakeClaudeProviderProcess,
  TEST_BINDING_ID,
  TEST_RUN_ID,
  TEST_SECOND_RUN_ID,
  TEST_SESSION_ID,
} from "../__fixtures__/transport-doubles.js";
import {
  armRunDispatch,
  buildHarness,
  createLiveSession,
  rewindTestSession,
  spawnedChannel,
  startLiveRun,
  TEST_MESSAGE_ID,
  type LifecycleHarness,
} from "./lifecycle.test-support.js";

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

  // A run is admitted only into a process spawned with the same roots and credential list and the
  // same schema by canonical digest (key order is not semantic in JSON, array order is). The
  // admitted rows catch a guard that refuses too much, which would refuse every real run.
  const SPAWN_BOUND_RUNS: ReadonlyArray<{
    readonly label: string;
    readonly spawn: Partial<CreateSessionParams>;
    readonly run: Partial<StartRunParams>;
    readonly refusal: string | null;
  }> = [
    {
      // A live level move changes the level in the running process, so no relaunch is owed.
      label: "a run at another level",
      spawn: { executionPosture: SPAWN_POSTURE },
      run: { executionPosture: { ...SPAWN_POSTURE, mode: "yolo" } },
      refusal: null,
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
      expect(channel.sentTexts).toStrictEqual(["review the diff"]);
    } else {
      await expect(starting).rejects.toMatchObject({
        code: "driver.unavailable",
        fields: { reason: refusal },
      });
      expect(channel.sentTexts).toStrictEqual([]);
    }
  });
});

describe("ClaudeSessionLifecycle run dispatch and interrupt", () => {
  it("refuses a second dispatch until the opening turn settles, then admits it", async () => {
    // Claude Code takes one turn at a time and its terminal names no run, so a second turn on the
    // session could not be told from the first. A refused run gets no route either: the interrupt
    // is channel-scoped, so a route left for it would stop the older turn.
    const harness = buildHarness();
    const channel = await startLiveRun(harness);

    await expect(startTestRun(harness)).rejects.toMatchObject({
      code: "driver.unavailable",
      fields: { reason: "run_already_dispatched" },
    });
    await expect(startSecondRun(harness, "one more")).rejects.toMatchObject({
      code: "driver.unavailable",
      fields: { reason: "session_turn_in_flight" },
    });
    expect(channel.sentTexts).toStrictEqual(["review the diff"]);
    await expect(
      harness.lifecycle.interruptRun({ runId: TEST_SECOND_RUN_ID, reason: "user_stop" }),
    ).rejects.toThrow(ClaudeSessionUnavailableError);
    expect(channel.controlRequests).toStrictEqual([]);

    channel.emitStreamFrame("result/success");
    await startSecondRun(harness, "one more");
    expect(channel.sentTexts).toStrictEqual(["review the diff", "one more"]);
  });

  it("sends the person's words as typed and marks only daemon-composed text", async () => {
    // `client_composed` stops a command from running and an `@path` from expanding, so it rides
    // only text the daemon wrote itself; a leading `/` the person typed goes to Claude Code as is.
    const harness = buildHarness();
    const channel = await startLiveRun(harness, "/status please");

    // Stamped with the person's message id, so a later cut can name it.
    const typed: ClaudeUserFrame = {
      type: "user",
      uuid: TEST_MESSAGE_ID,
      message: { role: "user", content: "/status please" },
    };
    expect(channel.sentUserFrames).toStrictEqual([typed]);
    expect(
      composeClaudeUserFrame({ text: "/goal ship it", origin: "driver_command" }, "goal-id"),
    ).toStrictEqual({
      type: "user",
      uuid: "goal-id",
      message: { role: "user", content: "/goal ship it" },
    });
    expect(
      composeClaudeUserFrame(
        { text: "/earlier conversation", origin: "system_narration" },
        "narration-id",
      ),
    ).toStrictEqual({
      type: "user",
      uuid: "narration-id",
      message: { role: "user", content: "/earlier conversation" },
      client_composed: true,
    });
  });

  it("answers `/output-style` and `/advisor` with no message and no run", async () => {
    // Claude Code's own commands would save the choice in the project or for the whole machine.
    const harness = buildHarness();
    harness.transport.initializeOutputStyles = ["default", "Explanatory"];
    harness.transport.initializeModels = [
      { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5" },
    ];
    const channel = await createLiveSession(harness);
    const answer = async (text: string): Promise<SessionCommandAnswer> =>
      await harness.lifecycle.answerSessionCommand({ sessionId: TEST_SESSION_ID, text });

    // Claude Code shows the style in effect, and takes the advisor but says none attaches, as on a
    // model it cannot advise.
    channel.controlResponseBySubtype.set("get_settings", {
      subtype: "success",
      response: { effective: { outputStyle: "Explanatory" }, applied: { advisor: null } },
    });

    expect(await answer("/output-style explanatory")).toStrictEqual({
      answered: true,
      line: "Output style set to Explanatory.",
    });
    expect(await answer("/advisor opus")).toStrictEqual({ answered: true, line: null });
    expect(await answer("/advisor")).toStrictEqual({
      answered: true,
      line: "Advisor: off\nUsage: /advisor <fable|opus|sonnet|off>",
    });
    // Once Claude Code names that advisor as the one it attaches, the line says it is set.
    channel.controlResponseBySubtype.set("get_settings", {
      subtype: "success",
      response: { applied: { advisor: "claude-opus-5-5" } },
    });
    expect(await answer("/advisor opus")).toStrictEqual({
      answered: true,
      line: "Advisor set to Opus 5.5.",
    });
    // An argument the session cannot take is answered with the listing and never sent as typed,
    // where Claude Code's own command would save it for the machine or the project.
    expect(await answer("/advisor haiku")).toStrictEqual({
      answered: true,
      line: "Advisor: Opus 5.5\nUsage: /advisor <fable|opus|sonnet|off>",
    });
    expect(await answer("/output-style nonexistent")).toStrictEqual({
      answered: true,
      line: [
        "Output style: Explanatory",
        "",
        "Available styles:",
        "- default",
        "- Explanatory (current)",
        "",
        "Usage: /output-style <style>",
      ].join("\n"),
    });
    expect(await answer("/status")).toStrictEqual({ answered: false });

    expect(channel.sentUserFrames).toStrictEqual([]);
    expect(harness.daemonTurnRuns).toStrictEqual([]);
    expect(harness.runMoves).toStrictEqual([]);
    expect(channel.controlRequests).toContainEqual({
      subtype: "apply_flag_settings",
      settings: { outputStyle: "Explanatory" },
    });
    expect(channel.controlRequests).toContainEqual({
      subtype: "apply_flag_settings",
      settings: { advisorModel: "opus" },
    });
  });

  it("turns the advisor off with Claude Code's empty advisor, never `null`", async () => {
    // `null` removes the session's own value and lets the person's machine-wide advisor through.
    const harness = buildHarness();
    const channel = await createLiveSession(harness);

    expect(
      await harness.lifecycle.answerSessionCommand({
        sessionId: TEST_SESSION_ID,
        text: "/advisor off",
      }),
    ).toStrictEqual({ answered: true, line: null });
    expect(channel.controlRequests).toContainEqual({
      subtype: "apply_flag_settings",
      settings: { advisorModel: "" },
    });
    expect(harness.deliveries).toContainEqual({
      kind: "session_event",
      row: {
        type: "session.advisor_changed",
        payload: { sessionId: TEST_SESSION_ID, advisorModel: null, at: expect.any(String) },
      },
    });
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
    // The refused interrupt stopped nothing: the turn's end goes as Claude Code sends it.
    channel.emitStreamFrame("result/success", undefined, { type: "result", subtype: "success" });
    expect(harness.runMoves.filter((change) => change.runId === TEST_RUN_ID)).toStrictEqual([
      { runId: TEST_RUN_ID, newState: "completed", completionKind: "turn" },
    ]);
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

describe("ClaudeSessionLifecycle failed opening writes", () => {
  // A failed write is never re-sent. Bytes that may have been taken can still start a turn, so
  // the run keeps the session's turn and its interrupt route until that turn's terminal; a write
  // that provably never left, or a channel that can deliver no terminal, frees both at once. A
  // transport that rejects instead of reporting makes no claim about bytes, so it holds too.
  const WRITE_FAILURES: ReadonlyArray<{
    readonly label: string;
    readonly breakWrite: (channel: FakeClaudeProviderProcess) => void;
    readonly holdsTurn: boolean;
  }> = [
    {
      label: "holds the turn after an indeterminate write on a live channel",
      breakWrite: (channel) => {
        channel.sendUserTextFailure = new Error("the provider stream is closed");
        channel.sendUserTextDelivery = "indeterminate";
      },
      holdsTurn: true,
    },
    {
      label: "holds the turn after a write the transport rejected",
      breakWrite: (channel) => {
        channel.sendUserTextRejection = new Error("the transport threw instead of reporting");
      },
      holdsTurn: true,
    },
    {
      label: "frees the turn after a write that provably never left",
      breakWrite: (channel) => {
        channel.sendUserTextFailure = new Error("the provider stream is closed");
        channel.sendUserTextDelivery = "unsent";
      },
      holdsTurn: false,
    },
    {
      label: "frees the turn after an indeterminate write on a channel past its last terminal",
      breakWrite: (channel) => {
        channel.sendUserTextFailure = new Error("the provider stream is closed");
        channel.sendUserTextDelivery = "indeterminate";
        channel.isClosed = true;
      },
      holdsTurn: false,
    },
  ];

  it.each(WRITE_FAILURES)("$label", async ({ breakWrite, holdsTurn }) => {
    const harness = buildHarness();
    const channel = await createLiveSession(harness);
    breakWrite(channel);
    armRunDispatch(harness);

    await expect(startTestRun(harness)).rejects.toThrow();
    expect(channel.sendUserTextAttempts).toBe(1);
    channel.sendUserTextFailure = undefined;
    channel.sendUserTextRejection = undefined;

    expect(harness.lifecycle.findProcessForRun(TEST_RUN_ID)).toBe(holdsTurn ? channel : undefined);
    if (holdsTurn) {
      await expect(startSecondRun(harness, "second turn")).rejects.toMatchObject({
        fields: { reason: "session_turn_in_flight" },
      });
      channel.emitStreamFrame("result/success");
    }
    await startSecondRun(harness, "second turn");
    expect(channel.sentTexts).toStrictEqual(["second turn"]);
  });

  it("fails the start when its stdin write outlasts the request deadline or the process exits under it", async () => {
    // A stdin that takes one chunk and never drains, as a process that stopped reading.
    const stalledStdin = (): Writable => new Writable({ highWaterMark: 1, write: () => undefined });
    const frameLine = (text: Parameters<typeof composeClaudeUserFrame>[0], uuid: string): string =>
      `${JSON.stringify(composeClaudeUserFrame(text, uuid))}\n`;

    const stalledHarness = buildHarness();
    const stalledChannel = await createLiveSession(stalledHarness);
    const stalled = stalledStdin();
    stalledChannel.sendUserText = (text, uuid) =>
      writeStdinLine(stalled, frameLine(text, uuid), 20);
    armRunDispatch(stalledHarness, TEST_RUN_ID, "/status please");
    await expect(startTestRun(stalledHarness)).rejects.toThrow(ClaudeRequestTimeoutError);

    const exitingHarness = buildHarness();
    const exitingChannel = await createLiveSession(exitingHarness);
    const exiting = stalledStdin();
    exitingChannel.sendUserText = (text, uuid) => {
      const attempt = writeStdinLine(exiting, frameLine(text, uuid));
      exiting.destroy();
      return attempt;
    };
    armRunDispatch(exitingHarness, TEST_RUN_ID, "/status please");
    await expect(startTestRun(exitingHarness)).rejects.toThrow("stdin closed");
  });
});

// A run whose turn a rewind took is owed a visible failure, since no terminal can end it any more;
// a daemon-initiated close owes none because the daemon asked for it.
describe("ClaudeSessionLifecycle runs a rewind supersedes", () => {
  const TRANSITIONS: ReadonlyArray<{
    readonly label: string;
    readonly turn: "in-flight" | "settled" | "none";
    readonly transition: "rewind" | "close";
    readonly isRunFailed: boolean;
  }> = [
    {
      label: "fails the run on a rewind that supersedes its turn in flight",
      turn: "in-flight",
      transition: "rewind",
      isRunFailed: true,
    },
    {
      label: "reports nothing on a daemon-initiated close",
      turn: "in-flight",
      transition: "close",
      isRunFailed: false,
    },
    {
      label: "reports nothing on a rewind of an idle session",
      turn: "none",
      transition: "rewind",
      isRunFailed: false,
    },
    {
      label: "reports nothing on a rewind after the turn's own terminal",
      turn: "settled",
      transition: "rewind",
      isRunFailed: false,
    },
  ];

  it.each(TRANSITIONS)("$label", async ({ turn, transition, isRunFailed }) => {
    const harness = buildHarness();
    if (turn === "none") {
      await createLiveSession(harness);
    } else {
      const channel = await startLiveRun(harness, "/compact the thread please");
      if (turn === "settled") {
        channel.emitStreamFrame("result/success");
      }
    }

    await (transition === "rewind"
      ? rewindTestSession(harness)
      : harness.lifecycle.closeSession({ sessionId: TEST_SESSION_ID }));

    expect(harness.supersededRunFailures).toMatchObject(
      isRunFailed
        ? [
            {
              runId: TEST_RUN_ID,
              providerFailureDetail: expect.stringContaining("superseded by a rewind"),
            },
          ]
        : [],
    );
  });

  it("frees the session's turn on a rewind, so the next run starts on the fork", async () => {
    const harness = buildHarness();
    await startLiveRun(harness, "/compact the thread please");
    await rewindTestSession(harness);

    expect(harness.lifecycle.findProcessForRun(TEST_RUN_ID)).toBeUndefined();
    await startSecondRun(harness, "carry on from the fork");
    expect(harness.lifecycle.findProcessForRun(TEST_SECOND_RUN_ID)).toBe(
      spawnedChannel(harness, 1),
    );
  });

  it("fails no run when a rewind's adoption fails, leaving the predecessor's turn running", async () => {
    // The restored predecessor is still mid-turn, so its own terminal still ends the run.
    const harness = buildHarness();
    const predecessorChannel = await startLiveRun(harness, "/status please");
    harness.transport.onTurnTerminalFailure = new Error("the transport refused the terminal hook");

    const rollback = await rewindTestSession(harness);

    expect(rollback.status).toBe("degraded");
    expect(spawnedChannel(harness, 1).disposals).toStrictEqual(["establishment_failed"]);
    expect(harness.supersededRunFailures).toStrictEqual([]);
    expect(harness.lifecycle.findProcessForRun(TEST_RUN_ID)).toBe(predecessorChannel);
    predecessorChannel.emitStreamFrame("result/success");
    expect(harness.lifecycle.findProcessForRun(TEST_RUN_ID)).toBeUndefined();
  });

  it("records the refusal and still applies the rewind when the run engine refuses the end", async () => {
    const harness = buildHarness();
    await startLiveRun(harness, "/status please");
    harness.answerDelivery = async () => {
      await Promise.resolve();
      throw new Error("the emission pipeline is unavailable");
    };

    expect((await rewindTestSession(harness)).status).toBe("applied");
    await vi.waitFor(() => {
      expect(harness.diagnostics.recentRecordsOfKind("delivery_dispatch_failed")).toContainEqual(
        expect.objectContaining({
          details: { deliveryKind: "run_lifecycle", sessionId: null, bindingId: TEST_BINDING_ID },
        }),
      );
    });
  });
});
