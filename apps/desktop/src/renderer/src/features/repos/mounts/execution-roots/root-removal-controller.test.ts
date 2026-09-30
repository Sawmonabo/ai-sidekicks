// Removing a worktree: one act, one call, and one settlement.

import { describe, expect, it } from "vitest";

import type { WorktreeRetireRequest } from "@ai-sidekicks/contracts";

import {
  RootRemovalController,
  type RootRemovalOperations,
  type RootRemovalReading,
  type RootRemovalRecorder,
} from "./root-removal-controller.js";

/** The roots the scripted daemon answers for. */
const WORKTREE_ID = "worktree-reviewer";

/** The daemon: the call records the transition and answers `retired`. */
const SCRIPTED_DAEMON: RootRemovalOperations = {
  retireWorktree: ({ worktreeId }) => Promise.resolve({ worktreeId, state: "retired" }),
};

/** A recorder that keeps every reading it was given, in order. */
class ReadingLog implements RootRemovalRecorder {
  public readonly readings: RootRemovalReading[] = [];

  public recordRemoval(reading: RootRemovalReading): void {
    this.readings.push(reading);
  }

  public get last(): RootRemovalReading | undefined {
    return this.readings.at(-1);
  }
}

function open(
  rootId: string,
  operations: RootRemovalOperations = SCRIPTED_DAEMON,
): { readonly controller: RootRemovalController; readonly log: ReadingLog } {
  const log = new ReadingLog();
  const controller = new RootRemovalController({ operations, rootId, recorder: log });
  return { controller, log };
}

describe("RootRemovalController — the removal", () => {
  it("records the removal the daemon performed", async () => {
    const { controller, log } = open(WORKTREE_ID);
    await controller.send();
    expect(log.last?.status).toBe("settled");
    expect(log.last?.status === "settled" && log.last.state).toBe("retired");
  });

  it("asks for the ordinary removal, never the discard", async () => {
    // The discard belongs to its own confirm. This one sends the ordinary removal, which
    // the daemon refuses when the tree changed since its risks were read.
    const requests: WorktreeRetireRequest[] = [];
    const { controller } = open(WORKTREE_ID, {
      retireWorktree: (request) => {
        requests.push(request);
        return Promise.resolve({ worktreeId: request.worktreeId, state: "retired" });
      },
    });
    await controller.send();
    expect(requests).toStrictEqual([{ worktreeId: WORKTREE_ID, discard: false }]);
  });

  it("reports the send before it reports the answer", async () => {
    // Both moments reach the recorder: a confirmation with no in-flight state would look
    // unresponsive for the length of the call.
    const { controller, log } = open(WORKTREE_ID);
    await controller.send();
    expect(log.readings.map((reading) => reading.status)).toStrictEqual(["sending", "settled"]);
  });
});

describe("RootRemovalController — the guards", () => {
  it("refuses to put a second removal on the wire for one press", async () => {
    const { controller, log } = open(WORKTREE_ID);
    const first = controller.send();
    await controller.send();
    await first;
    expect(log.readings.filter((reading) => reading.status === "sending")).toHaveLength(1);
  });

  it("releases the guard when the send rejects, which is what a person retries from", async () => {
    let calls = 0;
    const { controller, log } = open(WORKTREE_ID, {
      ...SCRIPTED_DAEMON,
      retireWorktree: ({ worktreeId }) => {
        calls += 1;
        return calls === 1
          ? Promise.reject(new Error("The daemon could not be reached."))
          : Promise.resolve({ worktreeId, state: "retired" });
      },
    });

    await expect(controller.send()).rejects.toThrow("The daemon could not be reached.");
    await controller.send();

    expect(log.readings.map((reading) => reading.status)).toStrictEqual([
      "sending",
      "sending",
      "settled",
    ]);
  });

  it("negative control: a disposed controller reports nothing more", async () => {
    const { controller, log } = open(WORKTREE_ID);
    const inFlight = controller.send();
    controller.dispose();
    await inFlight;
    expect(log.last?.status).toBe("sending");
    expect(controller.isDisposed).toBe(true);
  });
});
