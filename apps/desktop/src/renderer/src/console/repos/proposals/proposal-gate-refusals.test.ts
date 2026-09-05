// What a refused act leaves standing, and which sentence a participant reads.
//
// THE MODULE THIS DRIVES IS `proposal-gate-refusals.ts` — the four sentences and the
// two writes that put one on a control or take it off. Every case reaches them
// through a real act, because a refusal that is never recorded against the control
// pressed is a sentence nobody sees.
//
// THREE SOURCES, ONE ARM. A refusal can come from the console (a second act while one
// is unanswered), from the daemon's own answer, or from a call that rejected instead
// of answering — and all three land on the same per-act arm, which is why the three
// blocks are one suite: a fix that served one source by clobbering another would pass
// its own block and fail the next.

import { afterEach, describe, expect, it } from "vitest";

import { ManualClock } from "../../core/index.js";
import { PROPOSAL_ACTIONS, type ProposalAction } from "./proposal-actions.js";
import type { ProposalGateReader } from "./proposal-gate-reader.js";
import {
  ACCEPTED_ACTION,
  type MovingPort,
  OpenReaders,
  REPLY_ABANDONED,
  SERVED_CONTEXT,
  WIRE_UNREGISTERED,
  bridgeAnswering,
  bridgeWithMovingAnswers,
  rejectsWith,
  settleAct,
  settle,
} from "./proposal-gate-scripted-port.test-support.js";

const readers = new OpenReaders();

afterEach(() => {
  readers.disposeAll();
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

describe("ProposalGateActions — a served act the daemon did not take", () => {
  /** Send one act against a port answering `gitAction`, and give back its refusal text. */
  async function refusalTextFor(gitAction: unknown): Promise<string | undefined> {
    const clock = new ManualClock();
    const reader = readers.open(
      bridgeAnswering({ branchContext: SERVED_CONTEXT, gitAction }),
      clock,
    );
    reader.start();
    await settle(clock, reader);

    await reader.requestAction("push");
    await settleAct(clock, reader);
    return reader.snapshot.actionRefusals.get("push")?.detail;
  }

  it("renders the reply's own error verbatim", async () => {
    // Rule 9: the console never paraphrases a refusal it did not author. The reply
    // carries an `error` member, and that sentence is what stands beside the control.
    const error =
      "! [rejected] feat/rate-limit-wiring -> feat/rate-limit-wiring (non-fast-forward)";

    expect(await refusalTextFor({ status: "served", value: { success: false, error } })).toBe(
      error,
    );
  });

  it("negative control: a failure that named no reason gets the console's own sentence", async () => {
    // Without this the case above would pass against a sender that rendered whatever
    // `error` held — including `undefined` — leaving a refused act with no sentence at
    // all beside its control, which is the silent no-op rule 8 forbids.
    const detail = await refusalTextFor({ status: "served", value: { success: false } });

    expect(detail).toBe(
      "The daemon answered this action without taking it, and named no reason. Nothing was sent.",
    );
  });
});

describe("ProposalGateActions — a call that rejected rather than answering", () => {
  /** What an IPC disconnect leaves in the caller's hands: a rejection, not an answer. */
  const DISCONNECTED = new Error("the bridge went away mid-call");

  /** The growth operation each act is sent on, so a case can read the wire it names. */
  const WIRE_FOR_ACTION: Readonly<Record<ProposalAction, string>> = {
    "prepare-proposal": "gitflowPrPrepare",
    commit: "gitActionExecute",
    push: "gitActionExecute",
  };

  /** Press one act against a gate whose act wires reject instead of answering. */
  async function pressAgainstRejectingWire(action: ProposalAction): Promise<ProposalGateReader> {
    const clock = new ManualClock();
    const reader = readers.open(
      bridgeAnswering({
        branchContext: SERVED_CONTEXT,
        prepare: rejectsWith(DISCONNECTED),
        gitAction: rejectsWith(DISCONNECTED),
      }),
      clock,
    );
    reader.start();
    await settle(clock, reader);

    await reader.requestAction(action);
    await settleAct(clock, reader);
    return reader;
  }

  it("publishes the rejection beside the control pressed, for every act there is", async () => {
    // Over the closed set rather than three hand-written cases: prepare and the two
    // git actions rejected identically and all three re-enabled their controls with
    // nothing written anywhere, so a fourth act must not be able to join them quietly.
    for (const action of PROPOSAL_ACTIONS) {
      const reader = await pressAgainstRejectingWire(action);
      const refusal = reader.snapshot.actionRefusals.get(action);

      expect(refusal?.code).toBe("call-rejected");
      // The sentence names the wire that rejected, so a participant can say which
      // call did not come back rather than only that something did not.
      expect(refusal?.detail).toContain(WIRE_FOR_ACTION[action]);
      // And it does NOT quote the rejected value. A rejection off the wire can carry
      // participant content as readily as a schema failure can, which is why the
      // console's normalizer composes its own sentence from the leg alone.
      expect(refusal?.detail).not.toContain(DISCONNECTED.message);
      // The register is given back, which is what re-enables the controls — and the
      // whole defect was that this happened while nothing was written beside them.
      expect(reader.snapshot.inFlightAction).toBeUndefined();
    }
  });

  it("leaves the arm the last read published, because the act did not happen", async () => {
    const clock = new ManualClock();
    const reader = readers.open(
      bridgeAnswering({ branchContext: SERVED_CONTEXT, gitAction: rejectsWith(DISCONNECTED) }),
      clock,
    );
    reader.start();
    await settle(clock, reader);
    const armBefore = reader.snapshot.state;

    await reader.requestAction("commit");
    await settleAct(clock, reader);

    expect(reader.snapshot.state).toStrictEqual(armBefore);
  });

  it("settles rather than rejecting, which the binding that voids the promise assumes", async () => {
    const clock = new ManualClock();
    const reader = readers.open(
      bridgeAnswering({ branchContext: SERVED_CONTEXT, gitAction: rejectsWith(DISCONNECTED) }),
      clock,
    );
    reader.start();
    await settle(clock, reader);

    // `useProposalGate` discards this promise, so a rejection escaping here reaches
    // nobody but the browser's unhandled-rejection report.
    await expect(reader.requestAction("push")).resolves.toBeUndefined();
  });

  it("negative control: a refused ANSWER still carries the port's own code", async () => {
    // Without this the cases above would pass against a catch that relabelled every
    // unanswered act `call-rejected`, which would bury the refusal naming the wire
    // this build does not carry — the ordinary V1 answer, and not a rejection at all.
    const clock = new ManualClock();
    const reader = readers.open(
      bridgeAnswering({ branchContext: SERVED_CONTEXT, gitAction: WIRE_UNREGISTERED }),
      clock,
    );
    reader.start();
    await settle(clock, reader);

    await reader.requestAction("push");
    await settleAct(clock, reader);

    expect(reader.snapshot.actionRefusals.get("push")?.code).toBe("wire-unregistered");
  });
});
