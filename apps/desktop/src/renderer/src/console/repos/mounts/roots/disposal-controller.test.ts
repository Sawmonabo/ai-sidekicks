// Retiring a worktree and disposing a clone: one act, two calls, and one settlement.
//
// THE REFUSALS ARE THE ORDINARY ANSWERS HERE, which is why the class publishes at all.
// A confirmation that closed on the press would report a retirement a live run blocked
// as one that happened.

import { describe, expect, it } from "vitest";

import { createFixtureBridge, type ConsoleBridge } from "../../../bridge/index.js";
import { withDaemonCall } from "../../../bridge/fixture/call-plane/bridge.test-support.js";
import { REPOS_SCENARIO } from "../../../bridge/scenario/repos/repos.js";
import {
  EPHEMERAL_CLONE_ID,
  IMPLEMENTER_WORKTREE_ID,
  RECLAIMED_CLONE_ID,
  REVIEWER_WORKTREE_ID,
} from "../../../bridge/scenario/repos/repos-fixture-data.js";
import {
  RootDisposalController,
  type DisposalReading,
  type RootDisposalHost,
} from "./disposal-controller.js";
import { disposalSubjectFor } from "./root-act-model.js";

/** A host that keeps every reading it was given, in order. */
class RecordingHost implements RootDisposalHost {
  public readonly readings: DisposalReading[] = [];

  public recordDisposal(reading: DisposalReading): void {
    this.readings.push(reading);
  }

  public get last(): DisposalReading | undefined {
    return this.readings.at(-1);
  }
}

function open(
  kind: "worktree" | "ephemeral-clone",
  rootId: string,
  bridge: ConsoleBridge = createFixtureBridge({ scenario: REPOS_SCENARIO }),
): { readonly controller: RootDisposalController; readonly host: RecordingHost } {
  const host = new RecordingHost();
  const controller = new RootDisposalController({
    bridge,
    subject: disposalSubjectFor(kind, rootId),
    host,
  });
  return { controller, host };
}

/**
 * The fixture bridge with the retire call answering the way a broken wire does.
 *
 * A THROW AND NOT A REFUSAL, which is the whole distinction these cases turn on: the
 * scenario answers every disposal with a typed reply, and the two failures a live
 * bridge adds over a fixture one — a call that rejects, and a reply the response
 * schema will not read — reach the console as a rejected promise instead.
 */
function bridgeFailingRetire(answer: () => unknown): {
  readonly bridge: ConsoleBridge;
  readonly retireCallCount: () => number;
} {
  let retireCalls = 0;
  const held = withDaemonCall(
    createFixtureBridge({ scenario: REPOS_SCENARIO }),
    async (call, passThrough) => {
      if (call.method !== "repo.worktreeRetire") {
        return await passThrough();
      }
      retireCalls += 1;
      return answer();
    },
  );
  return { bridge: held.bridge, retireCallCount: () => retireCalls };
}

describe("RootDisposalController — the worktree arm", () => {
  it("records the retirement the daemon performed", async () => {
    const { controller, host } = open("worktree", REVIEWER_WORKTREE_ID);
    await controller.send();
    expect(host.last?.status).toBe("settled");
    expect(host.last?.status === "settled" && host.last.state).toBe("retired");
  });

  it("records the conflict a live run's root takes, rather than swallowing it", async () => {
    const { controller, host } = open("worktree", IMPLEMENTER_WORKTREE_ID);
    await controller.send();
    expect(host.last?.status).toBe("refused");
    expect(host.last?.status === "refused" && host.last.refusal.code).toBe(
      "worktree.retire_conflict",
    );
  });

  it("reports the send before it reports the answer", async () => {
    // Both moments reach the host: a confirmation with no in-flight state would look
    // unresponsive for the length of the call.
    const { controller, host } = open("worktree", REVIEWER_WORKTREE_ID);
    await controller.send();
    expect(host.readings.map((reading) => reading.status)).toStrictEqual(["sending", "settled"]);
  });
});

describe("RootDisposalController — the clone arm", () => {
  it("disposes a live clone through the clone call", async () => {
    const { controller, host } = open("ephemeral-clone", EPHEMERAL_CLONE_ID);
    await controller.send();
    expect(host.last?.status).toBe("settled");
  });

  it("records the race a swept clone loses", async () => {
    // The deadline sweep took it between the read that drew the card and the press.
    const { controller, host } = open("ephemeral-clone", RECLAIMED_CLONE_ID);
    await controller.send();
    expect(host.last?.status === "refused" && host.last.refusal.code).toBe("clone.not_found");
  });
});

describe("RootDisposalController — the guards", () => {
  it("refuses to put a second disposal on the wire for one press", async () => {
    const { controller, host } = open("worktree", REVIEWER_WORKTREE_ID);
    const first = controller.send();
    await controller.send();
    await first;
    expect(host.readings.filter((reading) => reading.status === "sending")).toHaveLength(1);
  });

  it("releases the guard on a refused send, which is what a person retries from", async () => {
    const { controller, host } = open("worktree", IMPLEMENTER_WORKTREE_ID);
    await controller.send();
    await controller.send();
    expect(host.readings.filter((reading) => reading.status === "sending")).toHaveLength(2);
  });

  it("negative control: a disposed controller reports nothing more", async () => {
    const { controller, host } = open("worktree", REVIEWER_WORKTREE_ID);
    const inFlight = controller.send();
    controller.dispose();
    await inFlight;
    expect(host.last?.status).toBe("sending");
    expect(controller.isDisposed).toBe(true);
  });
});

describe("RootDisposalController — a wire that rejects is still an answer", () => {
  // THE CONFIRMATION IS THE ONLY THING ON SCREEN WHEN THIS HAPPENS. The hook voids the
  // promise, so a `send` that rejected would leave the card reporting `sending` for as
  // long as it stayed open and would put the failure nowhere a person could read it.
  // What makes that unreachable is that the call door is total — every repos call goes
  // through `callDaemon`, which answers a refusal for a rejection rather than
  // re-throwing it — and these cases are what hold this site to that door.

  it("records the code a rejected retire carried, and settles rather than rejecting", async () => {
    const { bridge } = bridgeFailingRetire(() => {
      // The shape an IPC disconnect reaches the renderer as: a rejection carrying the
      // daemon's own envelope rather than a reply the console can read.
      throw { code: "daemon.unavailable", message: "The daemon is not reachable." };
    });
    const { controller, host } = open("worktree", REVIEWER_WORKTREE_ID, bridge);
    await expect(controller.send()).resolves.toBeUndefined();
    expect(host.last?.status).toBe("refused");
    expect(host.last?.status === "refused" && host.last.refusal.code).toBe("daemon.unavailable");
  });

  it("names a rejection that carries no code of its own", async () => {
    const { bridge } = bridgeFailingRetire(() => {
      throw new Error("The message port closed.");
    });
    const { controller, host } = open("worktree", REVIEWER_WORKTREE_ID, bridge);
    await controller.send();
    expect(host.last?.status === "refused" && host.last.refusal.code).toBe("call-rejected");
  });

  it("records a refusal for a reply the contract will not read", async () => {
    // The second cause a live bridge adds: the call resolves, and what it resolved
    // with is not the shape this build registers for the method.
    const { bridge } = bridgeFailingRetire(() => ({ state: "vaporised" }));
    const { controller, host } = open("worktree", REVIEWER_WORKTREE_ID, bridge);
    await controller.send();
    expect(host.last?.status === "refused" && host.last.refusal.code).toBe("reply-unreadable");
  });

  it("gives the guard back on the rejected arm, so the retry reaches the wire", async () => {
    const { bridge, retireCallCount } = bridgeFailingRetire(() => {
      throw new Error("The message port closed.");
    });
    const { controller, host } = open("worktree", REVIEWER_WORKTREE_ID, bridge);
    await controller.send();
    await controller.send();
    expect(host.readings.filter((reading) => reading.status === "sending")).toHaveLength(2);
    expect(retireCallCount()).toBe(2);
  });

  it("negative control: the same bridge answering normally settles rather than refusing", async () => {
    const { controller, host } = open("worktree", REVIEWER_WORKTREE_ID);
    await controller.send();
    expect(host.last?.status).toBe("settled");
  });
});
