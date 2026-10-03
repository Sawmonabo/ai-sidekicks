// Removing a worktree: one act, one call, and one settlement.

import { describe, expect, it } from "vitest";

import type { WorktreeRetireRequest } from "@ai-sidekicks/contracts";

import {
  RootRemovalController,
  type RootRemovalOperations,
  type RootRemovalReading,
  type RootRemovalRecorder,
} from "./root-removal-controller.js";

const WORKTREE_ID = "worktree-reviewer";

const SCRIPTED_DAEMON: RootRemovalOperations = {
  retireWorktree: ({ worktreeId }) => Promise.resolve({ worktreeId, state: "retired" }),
};

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
    // The discard has its own confirm. The ordinary removal is refused by the daemon when the
    // tree changed since its risks were read.
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

    await controller.send();
    const refused = log.last;
    expect(refused?.status === "refused" && refused.refusal.detail).toBe(
      "The daemon could not be reached.",
    );
    await controller.send();

    expect(log.readings.map((reading) => reading.status)).toStrictEqual([
      "sending",
      "refused",
      "sending",
      "settled",
    ]);
  });
});
