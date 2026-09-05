// Which acts are admitted at all: one at a time, against the context they were read
// under, attributed to the caller who pressed them.
//
// A SUITE OF ITS OWN BECAUSE ADMISSION IS DECIDED BEFORE ANY REQUEST IS COMPOSED. What
// an act SENDS and what its answer writes are `proposal-gate-actions.test.ts`; every
// case here is about a press that never reaches the wire, or reaches it carrying an
// identity a second read established.
//
// DRIVEN THROUGH `ProposalGateReader.requestAction` for the same reason its sibling
// is: the acts are constructed by the reader and handed its host, so a case that built
// a `ProposalGateActions` over a hand-written host would be asserting against a host
// the console never composes.

import { afterEach, describe, expect, it } from "vitest";

import type { ConsoleBridge } from "../../bridge/index.js";
import { PARTICIPANT_YOU } from "../../bridge/scenarios/repos-fixture-data.js";
import { ManualClock } from "../../core/index.js";
import type { ProposalGateReader } from "./proposal-gate-reader.js";
import {
  ACCEPTED_ACTION,
  OpenReaders,
  SERVED_CALLER_PARTICIPANT,
  SERVED_CONTEXT,
  SERVED_PREPARATION,
  WIRE_UNREGISTERED,
  servedContext,
  settleAct,
  settle,
} from "./proposal-gate-scripted-port.test-support.js";

const readers = new OpenReaders();

afterEach(() => {
  readers.disposeAll();
});

describe("ProposalGateActions — one act at a time", () => {
  /** A port whose preparation the case releases by hand, so a press can be caught mid-call. */
  interface HeldPreparation {
    readonly bridge: ConsoleBridge;
    readonly prepareCallCount: () => number;
    readonly answer: () => void;
  }

  function bridgeHoldingPreparation(): HeldPreparation {
    let calls = 0;
    let release = (): void => {};
    const held = new Promise<void>((settleHeld) => {
      release = (): void => {
        settleHeld();
      };
    });
    return {
      bridge: {
        growth: {
          gitflowBranchContextRead: async () => SERVED_CONTEXT,
          gitflowPrPrepare: async () => {
            calls += 1;
            await held;
            return SERVED_PREPARATION;
          },
          gitActionExecute: async () => ACCEPTED_ACTION,
        },
      } as unknown as ConsoleBridge,
      prepareCallCount: () => calls,
      answer: release,
    };
  }

  /** A gate on the served context with one preparation held open on the wire. */
  async function openWithHeldPreparation(): Promise<{
    reader: ProposalGateReader;
    clock: ManualClock;
    port: HeldPreparation;
  }> {
    const clock = new ManualClock();
    const port = bridgeHoldingPreparation();
    const reader = readers.open(port.bridge, clock);
    reader.start();
    await settle(clock, reader);
    void reader.requestAction("prepare-proposal");
    await Promise.resolve();
    return { reader, clock, port };
  }

  it("names the act it is waiting on while the bridge has not answered", async () => {
    const { reader } = await openWithHeldPreparation();
    expect(reader.snapshot.inFlightAction).toBe("prepare-proposal");
  });

  it("refuses a second act while one is unanswered, and issues no second call", async () => {
    // Two preparations can settle out of order and the older proposal then overwrites
    // the newer one; two commits confirmed against one payload are two commits.
    const { reader, clock, port } = await openWithHeldPreparation();

    await reader.requestAction("commit");

    expect(reader.snapshot.actionRefusals.get("commit")?.code).toBe("action-in-flight");
    // The refusal names the act actually being waited on, not the one pressed.
    expect(reader.snapshot.actionRefusals.get("commit")?.detail).toContain("Prepare proposal");
    expect(port.prepareCallCount()).toBe(1);

    port.answer();
    await settleAct(clock, reader);
    expect(reader.snapshot.inFlightAction).toBeUndefined();
  });

  it("negative control: the same act pressed after the first settles is admitted", async () => {
    // Without this the rule above would pass against a holder that refused every act
    // after the first one, which would make the gate single-use.
    const { reader, clock, port } = await openWithHeldPreparation();
    port.answer();
    await settleAct(clock, reader);

    await reader.requestAction("prepare-proposal");
    await settleAct(clock, reader);

    expect(reader.snapshot.actionRefusals.has("prepare-proposal")).toBe(false);
    expect(port.prepareCallCount()).toBe(2);
  });

  it("drops a settlement for a request the register has moved past", async () => {
    // A disposal moves the register out from under a call still on the wire. A
    // continuation that wrote anyway would publish onto a gate that has unmounted.
    const { reader, clock, port } = await openWithHeldPreparation();
    const readingBeforeDisposal = reader.snapshot;

    reader.dispose();
    port.answer();
    await settleAct(clock, reader);

    expect(reader.snapshot).toStrictEqual(readingBeforeDisposal);
  });
});

describe("ProposalGateActions — the context an act was admitted against", () => {
  /**
   * A port that holds the caller-identity read open, which is the window a refresh
   * lands in.
   *
   * The identity read is what every git action awaits before it sends, so it is the
   * one place a refresh can replace the served context under an act that has already
   * been admitted. Held by hand here rather than raced, so the case states the
   * interleaving instead of hoping for it.
   */
  interface HeldIdentityPort {
    readonly bridge: ConsoleBridge;
    readonly serveContext: (answer: unknown) => void;
    readonly answerIdentity: () => void;
    readonly gitActionCallCount: () => number;
  }

  function bridgeHoldingIdentity(): HeldIdentityPort {
    let branchContext: unknown = SERVED_CONTEXT;
    let gitActionCalls = 0;
    let release = (): void => {};
    const held = new Promise<void>((settleHeld) => {
      release = (): void => {
        settleHeld();
      };
    });
    return {
      bridge: {
        growth: {
          gitflowBranchContextRead: async () => branchContext,
          gitflowPrPrepare: async () => SERVED_PREPARATION,
          gitActionExecute: async () => {
            gitActionCalls += 1;
            return ACCEPTED_ACTION;
          },
          callerParticipantRead: async () => {
            await held;
            return SERVED_CALLER_PARTICIPANT;
          },
        },
      } as unknown as ConsoleBridge,
      serveContext: (answer: unknown) => {
        branchContext = answer;
      },
      answerIdentity: release,
      gitActionCallCount: () => gitActionCalls,
    };
  }

  /** Press Commit against the served context, caught inside the identity await. */
  async function pressCommitMidIdentityRead(): Promise<{
    reader: ProposalGateReader;
    clock: ManualClock;
    port: HeldIdentityPort;
  }> {
    const clock = new ManualClock();
    const port = bridgeHoldingIdentity();
    const reader = readers.open(port.bridge, clock);
    reader.start();
    await settle(clock, reader);

    void reader.requestAction("commit");
    await Promise.resolve();
    return { reader, clock, port };
  }

  /** Serve `next` and let a focus refresh land while the act is still waiting. */
  async function refreshTo(
    port: HeldIdentityPort,
    clock: ManualClock,
    reader: ProposalGateReader,
    next: unknown,
  ): Promise<void> {
    port.serveContext(next);
    window.dispatchEvent(new Event("focus"));
    await settle(clock, reader);
  }

  it("sends nothing when the refreshed context is a different root", async () => {
    // The whole defect: the continuation checked only that no LATER ACT had taken the
    // register, then sent the context it captured — mutating a branch context the gate
    // had already stopped showing.
    const { reader, clock, port } = await pressCommitMidIdentityRead();
    await refreshTo(port, clock, reader, servedContext({ headBranch: "feat/something-else" }));

    port.answerIdentity();
    await settleAct(clock, reader);

    expect(port.gitActionCallCount()).toBe(0);
    expect(reader.snapshot.actionRefusals.get("commit")?.code).toBe("context-superseded");
    expect(reader.snapshot.actionRefusals.get("commit")?.detail).toContain("Commit");
  });

  it("sends nothing when the refresh left the gate with no context at all", async () => {
    // The other half of what a refresh can do: the read can be REFUSED, which leaves
    // the gate showing no root — and an act sent then would name one nothing read.
    const { reader, clock, port } = await pressCommitMidIdentityRead();
    await refreshTo(port, clock, reader, WIRE_UNREGISTERED);

    port.answerIdentity();
    await settleAct(clock, reader);

    expect(port.gitActionCallCount()).toBe(0);
    expect(reader.snapshot.actionRefusals.get("commit")?.code).toBe("context-superseded");
  });

  it("negative control: a refresh serving the same context still sends the act", async () => {
    // Without this the two cases above would pass against a sender that refused every
    // act that outlived a refresh — which is every act on a gate that re-reads on
    // focus, a reconnect, and every repo frame the daemon sends.
    const { reader, clock, port } = await pressCommitMidIdentityRead();
    await refreshTo(port, clock, reader, SERVED_CONTEXT);

    port.answerIdentity();
    await settleAct(clock, reader);

    expect(port.gitActionCallCount()).toBe(1);
    expect(reader.snapshot.actionRefusals.has("commit")).toBe(false);
  });
});

describe("ProposalGateActions — the identity an act attributes to", () => {
  /** A port whose identity answer a case moves, counting the times it was asked. */
  interface IdentityPort {
    readonly bridge: ConsoleBridge;
    readonly answerIdentityWith: (answer: () => Promise<unknown>) => void;
    readonly identityReadCount: () => number;
    readonly gitActionRequests: () => readonly unknown[];
  }

  function bridgeWithMovingIdentity(): IdentityPort {
    let answerIdentity: () => Promise<unknown> = async () => WIRE_UNREGISTERED;
    let identityReads = 0;
    const gitActionRequests: unknown[] = [];
    return {
      bridge: {
        growth: {
          gitflowBranchContextRead: async () => SERVED_CONTEXT,
          gitflowPrPrepare: async () => SERVED_PREPARATION,
          gitActionExecute: async (request: unknown) => {
            gitActionRequests.push(request);
            return ACCEPTED_ACTION;
          },
          callerParticipantRead: async () => {
            identityReads += 1;
            return await answerIdentity();
          },
        },
      } as unknown as ConsoleBridge,
      answerIdentityWith: (answer: () => Promise<unknown>) => {
        answerIdentity = answer;
      },
      identityReadCount: () => identityReads,
      gitActionRequests: () => gitActionRequests,
    };
  }

  /** The causation one recorded request carried, or `undefined` where it carried none. */
  function causationOf(request: unknown): unknown {
    return (request as { readonly causationParticipantId?: unknown }).causationParticipantId;
  }

  /** A gate on the served context, over a port whose identity answer moves. */
  async function openOnMovingIdentity(): Promise<{
    reader: ProposalGateReader;
    clock: ManualClock;
    port: IdentityPort;
  }> {
    const clock = new ManualClock();
    const port = bridgeWithMovingIdentity();
    const reader = readers.open(port.bridge, clock);
    reader.start();
    await settle(clock, reader);
    return { reader, clock, port };
  }

  it("asks again after a refused identity read, so a later act carries the id", async () => {
    // The whole defect: a refusal during a transient disconnect was cached for the
    // gate's whole life, so every later act omitted its causation long after the read
    // would have been answered.
    const { reader, clock, port } = await openOnMovingIdentity();
    await reader.requestAction("commit");
    await settleAct(clock, reader);

    port.answerIdentityWith(async () => SERVED_CALLER_PARTICIPANT);
    await reader.requestAction("push");
    await settleAct(clock, reader);

    const [firstRequest, secondRequest] = port.gitActionRequests();
    expect(causationOf(firstRequest)).toBeUndefined();
    expect(causationOf(secondRequest)).toBe(PARTICIPANT_YOU);
    expect(port.identityReadCount()).toBe(2);
  });

  it("asks again after an identity read that rejected rather than answering", async () => {
    // The other way the wire fails to answer: a live bridge whose IPC never reaches
    // the daemon throws, which is not an identity either.
    const { reader, clock, port } = await openOnMovingIdentity();
    port.answerIdentityWith(async () => {
      throw new Error("the bridge went away mid-call");
    });
    await reader.requestAction("commit");
    await settleAct(clock, reader);

    port.answerIdentityWith(async () => SERVED_CALLER_PARTICIPANT);
    await reader.requestAction("push");
    await settleAct(clock, reader);

    const [, secondRequest] = port.gitActionRequests();
    expect(causationOf(secondRequest)).toBe(PARTICIPANT_YOU);
  });

  it("negative control: a served identity is read once however many acts follow", async () => {
    // Without this the two cases above would pass against a reader that asked on every
    // press, which is the same question on the wire once per act for an answer that
    // cannot change while the gate is mounted.
    const { reader, clock, port } = await openOnMovingIdentity();
    port.answerIdentityWith(async () => SERVED_CALLER_PARTICIPANT);

    await reader.requestAction("commit");
    await settleAct(clock, reader);
    await reader.requestAction("push");
    await settleAct(clock, reader);

    expect(port.identityReadCount()).toBe(1);
    for (const request of port.gitActionRequests()) {
      expect(causationOf(request)).toBe(PARTICIPANT_YOU);
    }
  });
});
