// `lifecycle.ts` restarts: a Claude Code process that stops answering an interrupt is stopped,
// its run ends on the exit, and the session's process starts again on its restart wait, on the
// output style the person chose for the session; restarts stop once crashes fill the window and
// when the daemon stops, and a new build moves a busy session once its turn ends.

import { describe, expect, it, vi } from "vitest";

import { ClaudeRequestTimeoutError } from "../session/errors.js";
import { composeClaudeSpawnSettings } from "../spawn/settings.js";
import { TEST_RUN_ID, TEST_SESSION_ID } from "../__fixtures__/transport-doubles.js";
import {
  buildHarness,
  createLiveSession,
  spawnedChannel,
  startLiveRun,
  type LifecycleHarness,
} from "./lifecycle.test-support.js";

// How a process that crashed on its own exits.
const CRASH_EXIT = { exitCode: 1, outputTail: "segmentation fault" };

describe("ClaudeSessionLifecycle restart", () => {
  it("stops a process whose interrupt expired, ends its run and starts it again", async () => {
    const harness = buildHarness();
    const channel = await startLiveRun(harness);
    channel.controlRequestFailure = new ClaudeRequestTimeoutError("no answer", 60_000);

    await harness.lifecycle.interruptRun({ runId: TEST_RUN_ID });

    expect(channel.terminations).toBe(1);
    await vi.waitFor(() => {
      expect(harness.processExitRunEnds).toStrictEqual([
        { runId: TEST_RUN_ID, processExit: { signal: "SIGTERM", outputTail: "(no output)" } },
      ]);
    });
    await vi.waitFor(() => {
      expect(harness.runScheduledRestarts()).toBe(1);
    });
    await vi.waitFor(() => {
      expect(harness.sessionNotices).toContainEqual({
        sessionId: TEST_SESSION_ID,
        kind: "provider_restarted",
        provider: "claude",
      });
    });
    expect(harness.transport.resumeRequests).toHaveLength(1);
    expect(harness.relaunches.map((relaunch) => relaunch.sessionId)).toStrictEqual([
      TEST_SESSION_ID,
    ]);
    // The ended run no longer reaches the session's new process.
    expect(harness.lifecycle.findProcessForRun(TEST_RUN_ID)).toBeUndefined();
  });

  it("starts the relaunched process on the output style the person chose", async () => {
    // Every launch reads the session's style back from its stored change, as the daemon does.
    const harness: LifecycleHarness = buildHarness({
      spawnContext: {
        resolveSpawnContext: async () => {
          await Promise.resolve();
          const chosen = harness.deliveries.flatMap((delivery) =>
            delivery.kind === "session_event" &&
            delivery.row.type === "session.output_style_changed"
              ? [delivery.row.payload.outputStyle]
              : [],
          );
          return {
            workingDirectory: "/workspace",
            environmentRows: undefined,
            accountFolders: undefined,
            memoryFolders: [],
            advisorModel: null,
            outputStyle: chosen.at(-1) ?? null,
          };
        },
      },
    });
    harness.transport.initializeOutputStyles = ["default", "Explanatory"];
    const channel = await startLiveRun(harness);
    await harness.lifecycle.answerSessionCommand({
      sessionId: TEST_SESSION_ID,
      text: "/output-style Explanatory",
    });
    channel.controlRequestFailure = new ClaudeRequestTimeoutError("no answer", 60_000);

    await harness.lifecycle.interruptRun({ runId: TEST_RUN_ID });
    await vi.waitFor(() => {
      expect(harness.runScheduledRestarts()).toBe(1);
    });
    await vi.waitFor(() => {
      expect(harness.transport.resumeRequests).toHaveLength(1);
    });

    const [first] = harness.transport.spawnRequests;
    const [relaunch] = harness.transport.resumeRequests;
    expect(first === undefined ? undefined : composeClaudeSpawnSettings(first).outputStyle).toBe(
      undefined,
    );
    expect(
      relaunch === undefined ? undefined : composeClaudeSpawnSettings(relaunch).outputStyle,
    ).toBe("Explanatory");
  });

  it("stops restarting once crashes fill the window and tells the person once", async () => {
    const harness = buildHarness();
    await createLiveSession(harness);

    // Each crash in the window restarts after its own wait, until one wait per crash is spent.
    for (let restart = 1; restart <= 4; restart += 1) {
      spawnedChannel(harness, -1).emitExit(CRASH_EXIT);
      await vi.waitFor(() => {
        expect(harness.runScheduledRestarts()).toBe(1);
      });
      await vi.waitFor(() => {
        expect(harness.transport.resumeRequests).toHaveLength(restart);
      });
    }
    spawnedChannel(harness, -1).emitExit(CRASH_EXIT);

    await vi.waitFor(() => {
      expect(harness.sessionNotices).toContainEqual({
        sessionId: TEST_SESSION_ID,
        kind: "provider_crash_loop",
        provider: "claude",
        exitCode: 1,
      });
    });
    expect(harness.runScheduledRestarts()).toBe(0);
    expect(harness.transport.resumeRequests).toHaveLength(4);
  });

  it("drops a waiting restart and starts none once the daemon stops", async () => {
    const harness = buildHarness();
    const channel = await startLiveRun(harness);
    channel.emitExit(CRASH_EXIT);
    // The run's end is the last step before the restart is put on its wait.
    await vi.waitFor(() => {
      expect(harness.processExitRunEnds).toHaveLength(1);
    });
    await Promise.resolve();

    await harness.lifecycle.shutdown();

    expect(harness.runScheduledRestarts()).toBe(0);
    expect(harness.transport.resumeRequests).toStrictEqual([]);
  });

  it("moves a busy session to a new build once its turn ends, telling the person once", async () => {
    const harness = buildHarness();
    const channel = await startLiveRun(harness);

    await harness.lifecycle.moveToProviderBuild({ fromVersion: "2.1.292", toVersion: "2.1.293" });
    // The running reply is never cut short by the move.
    expect(harness.transport.resumeRequests).toStrictEqual([]);
    expect(channel.disposals).toStrictEqual([]);

    channel.emitStreamFrame("result/success", undefined, { type: "result", subtype: "success" });

    await vi.waitFor(() => {
      expect(harness.transport.resumeRequests).toHaveLength(1);
    });
    await vi.waitFor(() => {
      expect(
        harness.sessionNotices.filter((notice) => notice.kind === "provider_updated"),
      ).toStrictEqual([
        {
          sessionId: TEST_SESSION_ID,
          kind: "provider_updated",
          provider: "claude",
          fromVersion: "2.1.292",
          toVersion: "2.1.293",
        },
      ]);
    });
    expect(channel.disposals).toStrictEqual(["session_closed"]);
  });
});
