// The Claude leg of the output-speed axis: every new process is told the level before any turn,
// a run that changes it sends `apply_flag_settings` once, nothing the provider refuses or the
// driver's table lacks is recorded as applied, a close or rewind while that request is in flight
// leaves the run unwritten, and each run reports the state it runs at.

import type { RunId } from "@ai-sidekicks/contracts/provider/driver/intervention";
import type { ProviderOutputSpeedState } from "@ai-sidekicks/contracts/provider/driver/transcript";
import { describe, expect, it, vi } from "vitest";

import type { ClaudeHandshakeDeclaration } from "../session/transport.js";
import {
  buildStartRunParams,
  type FakeClaudeProviderProcess,
  TEST_RUN_ID,
  TEST_SECOND_RUN_ID,
  TEST_SESSION_ID,
} from "../__fixtures__/transport-doubles.js";
import {
  armRunDispatch,
  buildHarness,
  createLiveSession,
  type LifecycleHarness,
  resumeTestSession,
  rewindTestSession,
  spawnedChannel,
} from "./lifecycle.test-support.js";

const FAST_MODE_ON = { subtype: "apply_flag_settings", settings: { fastMode: true } };
const FAST_MODE_OFF = { subtype: "apply_flag_settings", settings: { fastMode: false } };
const THIRD_RUN_ID = "run-3" as RunId;
const OPT_IN_REQUIRED = { fastModeState: "off", fastModeDisabledReason: "sdk_opt_in_required" };

interface SettledReport {
  readonly runId: RunId;
  readonly state: ProviderOutputSpeedState;
}

function settledHarness(): { harness: LifecycleHarness; settled: SettledReport[] } {
  const settled: SettledReport[] = [];
  const harness = buildHarness({
    onRunOutputSpeedSettled: (sessionId, runId, state) => {
      expect(sessionId).toBe(TEST_SESSION_ID);
      settled.push({ runId, state });
    },
  });
  return { harness, settled };
}

async function startRunAt(
  harness: LifecycleHarness,
  runId: RunId,
  outputSpeed?: string,
): Promise<void> {
  armRunDispatch(harness, runId);
  await harness.lifecycle.startRun({
    ...buildStartRunParams(),
    runId,
    ...(outputSpeed === undefined ? {} : { outputSpeed }),
  });
}

function publishHandshake(
  channel: FakeClaudeProviderProcess,
  fastMode: Pick<ClaudeHandshakeDeclaration, "fastModeState" | "fastModeDisabledReason">,
): void {
  channel.emitStreamFrame("system/init", {
    handshake: { slashCommands: [], skills: [], terminalSlashCommands: [], ...fastMode },
  });
}

describe("Claude output speed carriers", () => {
  it("tells every new process its level before any turn, at standard for one off the table", async () => {
    const harness = buildHarness();
    const created = await createLiveSession(harness, { outputSpeed: "on" });
    expect(created.controlRequests).toEqual([FAST_MODE_ON]);
    expect(created.sentTextFrames).toHaveLength(0);

    // The forked process holds no flag setting until it is told the level the session runs at.
    await rewindTestSession(harness);
    expect(spawnedChannel(harness, 1).controlRequests).toEqual([FAST_MODE_ON]);

    await harness.lifecycle.closeSession({ sessionId: TEST_SESSION_ID });
    expect((await resumeTestSession(harness, { outputSpeed: "turbo" })).status).toBe("resumed");
    const resumed = spawnedChannel(harness, 2);
    expect(resumed.controlRequests).toEqual([FAST_MODE_OFF]);
    // Recorded as standard, not as the unlisted level, so asking for either again sends nothing.
    await startRunAt(harness, TEST_RUN_ID, "turbo");
    resumed.emitStreamFrame("result/success");
    await startRunAt(harness, TEST_SECOND_RUN_ID, "off");
    expect(resumed.controlRequests).toEqual([FAST_MODE_OFF]);
  });

  it("reads the spawn's own state with no request and no turn", async () => {
    const harness = buildHarness();
    harness.transport.initializeFastMode = OPT_IN_REQUIRED;
    const channel = await createLiveSession(harness);

    expect(channel.controlRequests).toEqual([]);
    expect(channel.sentTextFrames).toEqual([]);
    expect(harness.lifecycle.observedOutputSpeedFor(TEST_SESSION_ID)).toStrictEqual({
      declared: "off",
      reason: "sdk_opt_in_required",
    });
  });

  it("applies a changed level once before its run's turn and nothing for the level held", async () => {
    const harness = buildHarness();
    const channel = await createLiveSession(harness, { outputSpeed: "off" });
    expect(channel.controlRequests).toEqual([FAST_MODE_OFF]);

    await startRunAt(harness, TEST_RUN_ID, "off");
    channel.emitStreamFrame("result/success");
    await startRunAt(harness, TEST_SECOND_RUN_ID, "on");
    channel.emitStreamFrame("result/success");
    await startRunAt(harness, THIRD_RUN_ID, "on");

    expect(channel.controlRequests).toEqual([FAST_MODE_OFF, FAST_MODE_ON]);
    expect(channel.sentTextFrames).toHaveLength(3);
  });

  it("runs on the held level when the provider refuses one, and asks again next run", async () => {
    const { harness, settled } = settledHarness();
    harness.transport.controlResponse = { subtype: "error", error: "fast mode is not available" };
    const channel = await createLiveSession(harness, { outputSpeed: "on" });

    await startRunAt(harness, TEST_RUN_ID, "on");
    // The turn still runs, and its handshake says what it runs at.
    expect(channel.sentTextFrames).toHaveLength(1);
    publishHandshake(channel, OPT_IN_REQUIRED);
    expect(settled).toStrictEqual([
      { runId: TEST_RUN_ID, state: { declared: "off", reason: "sdk_opt_in_required" } },
    ]);
    expect(harness.diagnostics.recentRecordsOfKind("output_speed_apply_refused")).toHaveLength(2);
    channel.emitStreamFrame("result/success");

    // Nothing was recorded as applied, so the level is asked for again until the provider takes it.
    channel.controlResponse = { subtype: "success" };
    await startRunAt(harness, TEST_SECOND_RUN_ID, "on");
    channel.emitStreamFrame("result/success");
    await startRunAt(harness, THIRD_RUN_ID, "on");
    expect(channel.controlRequests).toEqual([FAST_MODE_ON, FAST_MODE_ON, FAST_MODE_ON]);
  });
});

describe("Claude output speed per run", () => {
  it("reports each run's state once, at its handshake or else at its end", async () => {
    const { harness, settled } = settledHarness();
    const channel = await createLiveSession(harness, { outputSpeed: "on" });

    // The provider took the request and declared the mode off: the report is the declaration.
    await startRunAt(harness, TEST_RUN_ID, "on");
    publishHandshake(channel, OPT_IN_REQUIRED);
    publishHandshake(channel, { fastModeState: "on", fastModeDisabledReason: null });
    channel.emitStreamFrame("result/success");
    expect(settled).toStrictEqual([
      { runId: TEST_RUN_ID, state: { declared: "off", reason: "sdk_opt_in_required" } },
    ]);

    // A turn that ends with no handshake settles on the state the process holds.
    await startRunAt(harness, TEST_SECOND_RUN_ID);
    channel.emitStreamFrame("result/success");
    expect(settled.at(-1)).toStrictEqual({ runId: TEST_SECOND_RUN_ID, state: { declared: "on" } });

    // A turn never written reports nothing.
    channel.sendUserTextFailure = new Error("pipe closed");
    channel.sendUserTextDelivery = "unsent";
    await expect(startRunAt(harness, THIRD_RUN_ID)).rejects.toThrow("pipe closed");
    publishHandshake(channel, OPT_IN_REQUIRED);
    expect(settled).toHaveLength(2);
  });
});

describe("Claude output speed while the session changes", () => {
  // Starts a run that changes the level and parks its `apply_flag_settings` answer.
  async function startRunHeldAtApply(harness: LifecycleHarness): Promise<{
    readonly channel: FakeClaudeProviderProcess;
    readonly started: Promise<void>;
    readonly releaseApply: () => void;
  }> {
    const channel = await createLiveSession(harness, { outputSpeed: "off" });
    let releaseApply = (): void => {};
    channel.controlResponseGate = new Promise<void>((resolve) => {
      releaseApply = resolve;
    });
    const started = startRunAt(harness, TEST_RUN_ID, "on");
    await vi.waitFor(() => {
      expect(channel.controlRequests).toEqual([FAST_MODE_OFF, FAST_MODE_ON]);
    });
    return { channel, started, releaseApply };
  }

  it("writes nothing when the session closes while the level is being applied", async () => {
    const harness = buildHarness();
    const { channel, started, releaseApply } = await startRunHeldAtApply(harness);

    const closed = harness.lifecycle.closeSession({ sessionId: TEST_SESSION_ID });
    releaseApply();

    await expect(started).rejects.toMatchObject({ fields: { reason: "no_live_session" } });
    await closed;
    expect(channel.sendUserTextAttempts).toBe(0);
    expect(harness.textNeutralizationFailures).toStrictEqual([]);
  });

  it("writes nothing and fails the run once when a rewind lands while the level is applied", async () => {
    const harness = buildHarness();
    const { channel, started, releaseApply } = await startRunHeldAtApply(harness);

    await rewindTestSession(harness);
    releaseApply();

    await expect(started).rejects.toMatchObject({ fields: { reason: "no_live_session" } });
    expect(channel.sendUserTextAttempts).toBe(0);
    expect(spawnedChannel(harness, 1).sendUserTextAttempts).toBe(0);
    expect(harness.textNeutralizationFailures.map(({ runId }) => runId)).toStrictEqual([
      TEST_RUN_ID,
    ]);
  });
});
