// Each act from its own answer, one act at a time, and what a refusal leaves standing.
//
// THE ACT HALF ONLY. Which arm a read publishes is `proposal-gate-reader.test.ts`,
// beside the module that owns it; the scripted port both files drive is
// `proposal-gate-scripted-port.ts`, which is where the fixture choice and the drain
// discipline are recorded.
//
// DRIVEN THROUGH `ProposalGateReader.requestAction`, which is the one seam a surface
// has: the acts are constructed by the reader and handed its host, so a case that
// built a `ProposalGateActions` over a hand-written host would be asserting against a
// host the console never composes.

import { afterEach, describe, expect, it } from "vitest";

import { ManualClock } from "../core/index.js";
import type { ConsoleBridge } from "../bridge/index.js";
import type { ProposalGateReader } from "./proposal-gate-reader.js";
import { offeredProposalActions, type ProposalAction } from "./proposal-actions.js";
import {
  ACCEPTED_ACTION,
  type MovingPort,
  OpenReaders,
  REPLY_ABANDONED,
  SERVED_CONTEXT,
  SERVED_PREPARATION,
  WIRE_UNREGISTERED,
  bridgeAnswering,
  bridgeWithMovingAnswers,
  publishedProposalOf,
  settle,
  settleAct,
} from "./proposal-gate-scripted-port.js";

const readers = new OpenReaders();

afterEach(() => {
  readers.disposeAll();
});

describe("ProposalGateActions — the acts", () => {
  it("prepares against the context's own id and base branch, and folds the reply into the arm", async () => {
    const clock = new ManualClock();
    const reader = readers.open(
      bridgeAnswering({
        branchContext: SERVED_CONTEXT,
        prepare: {
          status: "served",
          value: {
            prPreparationId: "019b7b30-0280-7c11-8420-b1a5c0de2401",
            state: "ready",
            proposalBlob: { summary: "the rate limiter" },
          },
        },
      }),
      clock,
    );
    reader.start();
    await settle(clock, reader);

    await reader.requestAction("prepare-proposal");
    await settleAct(clock, reader);

    const { state } = reader.snapshot;
    if (state.kind !== "prepared") {
      throw new Error("a served preparation leaves the gate on the `prepared` arm");
    }
    // The branches are the CONTEXT's, never the reply's — the reply carries none.
    expect(state.proposal).toStrictEqual({
      baseBranch: "develop",
      headBranch: "feat/rate-limit-wiring",
      state: "ready",
      blob: { summary: "the rate limiter" },
    });
    // The preparation re-read rather than publishing beside a stale context.
    expect(reader.performCount).toBe(2);
  });

  it("renders a refused act beside the control pressed and changes no arm", async () => {
    const clock = new ManualClock();
    const reader = readers.open(
      bridgeAnswering({ branchContext: SERVED_CONTEXT, gitAction: WIRE_UNREGISTERED }),
      clock,
    );
    reader.start();
    await settle(clock, reader);
    const armBefore = reader.snapshot.state;

    await reader.requestAction("push");
    await settleAct(clock, reader);

    expect(reader.snapshot.actionRefusals.get("push")?.code).toBe("wire-unregistered");
    // The act did not happen, so the gate still reports what it last read.
    expect(reader.snapshot.state).toStrictEqual(armBefore);
    expect(reader.snapshot.actionRefusals.has("commit")).toBe(false);
  });

  it("records a served act the daemon did not accept rather than treating it as done", async () => {
    const clock = new ManualClock();
    const reader = readers.open(
      bridgeAnswering({
        branchContext: SERVED_CONTEXT,
        gitAction: { status: "served", value: { accepted: false } },
      }),
      clock,
    );
    reader.start();
    await settle(clock, reader);

    await reader.requestAction("commit");
    await settleAct(clock, reader);

    expect(reader.snapshot.actionRefusals.get("commit")?.code).toBe("action-not-accepted");
    // Negative control for the case below: an unaccepted act does not re-read.
    expect(reader.performCount).toBe(1);
  });

  it("re-reads the context after an act the daemon accepted", async () => {
    const clock = new ManualClock();
    const reader = readers.open(
      bridgeAnswering({ branchContext: SERVED_CONTEXT, gitAction: ACCEPTED_ACTION }),
      clock,
    );
    reader.start();
    await settle(clock, reader);

    await reader.requestAction("commit");
    await settleAct(clock, reader);

    expect(reader.performCount).toBe(2);
    expect(reader.snapshot.actionRefusals.size).toBe(0);
  });
});

describe("ProposalGateActions — what a refused act leaves standing", () => {
  /** Start a gate on the served context, with the acts answering `WIRE_UNREGISTERED`. */
  async function openOnServedContext(): Promise<{
    reader: ProposalGateReader;
    clock: ManualClock;
    port: MovingPort;
  }> {
    const clock = new ManualClock();
    const port = bridgeWithMovingAnswers();
    const reader = readers.open(port.bridge, clock);
    reader.start();
    await settle(clock, reader);
    return { reader, clock, port };
  }

  it("clears the standing refusal when the same act is accepted", async () => {
    const { reader, clock, port } = await openOnServedContext();
    await reader.requestAction("push");
    await settleAct(clock, reader);
    expect(reader.snapshot.actionRefusals.get("push")?.code).toBe("wire-unregistered");

    port.serveGitAction(ACCEPTED_ACTION);
    await reader.requestAction("push");
    await settleAct(clock, reader);

    // Nothing is refusing this act any more, so nothing renders beside its control.
    expect(reader.snapshot.actionRefusals.has("push")).toBe(false);
  });

  it("renders the newer refusal when a retry is refused for a different reason", async () => {
    const { reader, clock, port } = await openOnServedContext();
    await reader.requestAction("push");
    await settleAct(clock, reader);

    port.serveGitAction(REPLY_ABANDONED);
    await reader.requestAction("push");
    await settleAct(clock, reader);

    expect(reader.snapshot.actionRefusals.get("push")?.code).toBe("reply-abandoned");
  });

  it("negative control: another act's refusal survives a successful one", async () => {
    // The clear is per-action on purpose. Without this case the two above would pass
    // against a holder that emptied the whole map on any press, which would erase a
    // failed commit the moment a push worked.
    const { reader, clock, port } = await openOnServedContext();
    await reader.requestAction("commit");
    await settleAct(clock, reader);
    expect(reader.snapshot.actionRefusals.get("commit")?.code).toBe("wire-unregistered");

    port.serveGitAction(ACCEPTED_ACTION);
    await reader.requestAction("push");
    await settleAct(clock, reader);

    expect(reader.snapshot.actionRefusals.get("commit")?.code).toBe("wire-unregistered");
    expect(reader.snapshot.actionRefusals.has("push")).toBe(false);
  });
});

describe("ProposalGateActions — what an accepted act leaves of the proposal", () => {
  /** Prepare a proposal, then send `action` against an accepting daemon. */
  async function prepareThenAct(action: ProposalAction): Promise<ProposalGateReader> {
    const clock = new ManualClock();
    const port = bridgeWithMovingAnswers();
    const reader = readers.open(port.bridge, clock);
    reader.start();
    await settle(clock, reader);

    await reader.requestAction("prepare-proposal");
    await settleAct(clock, reader);
    if (publishedProposalOf(reader) === undefined) {
      throw new Error("the preparation has to land before the act that follows it");
    }

    port.serveGitAction(ACCEPTED_ACTION);
    await reader.requestAction(action);
    await settleAct(clock, reader);
    return reader;
  }

  it("discards the proposal an accepted commit made obsolete, and withdraws the send", async () => {
    // The context the re-read serves back is byte-identical — a commit moves neither
    // the context id nor either branch name — so the pairing check cannot see it and
    // the proposal has to be dropped by the act itself.
    const reader = await prepareThenAct("commit");

    expect(reader.snapshot.state.kind).toBe("prepared");
    expect(publishedProposalOf(reader)).toBeUndefined();
    // The claim: a payload that no longer describes the head cannot be sent.
    expect(offeredProposalActions(reader.snapshot.state)).not.toContain("push");
    expect(reader.snapshot.settlement).toBe(
      "A branch context was read. No proposal has been prepared yet.",
    );
  });

  it("negative control: an accepted push leaves the proposal it sent on screen", async () => {
    // Without this the case above would pass against a holder that dropped the
    // proposal on any accepted act, which would erase the summary of what was just
    // sent the moment it was sent.
    const reader = await prepareThenAct("push");

    expect(publishedProposalOf(reader)).toBeDefined();
    expect(offeredProposalActions(reader.snapshot.state)).toContain("push");
  });
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
