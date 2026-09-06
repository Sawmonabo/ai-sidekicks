// Retiring a worktree and disposing a clone: one act, two calls, and one settlement.
//
// THE REFUSALS ARE THE ORDINARY ANSWERS HERE, which is why the class publishes at all.
// A confirmation that closed on the press would report a retirement a live run blocked
// as one that happened.

import { describe, expect, it } from "vitest";

import { createFixtureBridge } from "../../../bridge/index.js";
import { REPOS_SCENARIO } from "../../../bridge/scenarios/repos.js";
import {
  EPHEMERAL_CLONE_ID,
  IMPLEMENTER_WORKTREE_ID,
  RECLAIMED_CLONE_ID,
  REVIEWER_WORKTREE_ID,
} from "../../../bridge/scenarios/repos-fixture-data.js";
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
): { readonly controller: RootDisposalController; readonly host: RecordingHost } {
  const host = new RecordingHost();
  const controller = new RootDisposalController({
    bridge: createFixtureBridge({ scenario: REPOS_SCENARIO }),
    subject: disposalSubjectFor(kind, rootId),
    host,
  });
  return { controller, host };
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
