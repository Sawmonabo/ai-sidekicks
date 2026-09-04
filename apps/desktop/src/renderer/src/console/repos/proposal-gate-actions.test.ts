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
import {
  PROPOSAL_ACTIONS,
  offeredProposalActions,
  type ProposalAction,
} from "./proposal-actions.js";
import {
  ACCEPTED_ACTION,
  type MovingPort,
  OpenReaders,
  REPLY_ABANDONED,
  SERVED_CONTEXT,
  SERVED_PREPARATION,
  SUBJECT,
  WIRE_UNREGISTERED,
  bridgeAnswering,
  bridgeWithMovingAnswers,
  publishedProposalOf,
  recordingPort,
  rejectsWith,
  settle,
  settleAct,
} from "./proposal-gate-scripted-port.js";
import { PARTICIPANT_YOU } from "../bridge/scenarios/repos-fixture-data.js";

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

describe("ProposalGateActions — the request a git action puts on the wire", () => {
  /** Send one act against a recording port and give back the request it produced. */
  async function requestSentBy(
    action: ProposalAction,
    script: { readonly callerParticipant?: unknown } = {},
  ): Promise<unknown> {
    const clock = new ManualClock();
    const port = recordingPort({ branchContext: SERVED_CONTEXT, ...script });
    const reader = readers.open(port.bridge, clock);
    reader.start();
    await settle(clock, reader);

    await reader.requestAction(action);
    await settleAct(clock, reader);

    const [request] = port.gitActionRequests();
    if (request === undefined) {
      throw new Error("the act has to reach the git action for there to be a request");
    }
    return request;
  }

  it("sends Commit as the registered request: mount, action, params, causation", async () => {
    // The shape `docs/architecture/contracts/api-payload-contracts.md` registers. This
    // call used to send `{ workspaceId, action }` — a member that contract does not
    // have, missing the two it requires — so a contract-valid daemon would have refused
    // every commit and every push before running it.
    expect(await requestSentBy("commit")).toStrictEqual({
      repoMountId: SUBJECT.repoMountId,
      action: "commit",
      params: {
        branchContextId: SERVED_CONTEXT.value["branchContextId"],
        headBranch: SERVED_CONTEXT.value["headBranch"],
      },
      causationParticipantId: PARTICIPANT_YOU,
    });
  });

  it("sends Push with the context's own push target beside the same mount and causation", async () => {
    expect(await requestSentBy("push")).toStrictEqual({
      repoMountId: SUBJECT.repoMountId,
      action: "push",
      params: {
        branchContextId: SERVED_CONTEXT.value["branchContextId"],
        headBranch: SERVED_CONTEXT.value["headBranch"],
        upstreamRef: SERVED_CONTEXT.value["upstreamRef"],
      },
      causationParticipantId: PARTICIPANT_YOU,
    });
  });

  it("sends the act without causation where the caller identity read refused", async () => {
    // The identity is attribution and not authority, so the act still goes — and the
    // member is absent rather than empty, because a placeholder would be a claim about
    // who acted.
    const request = await requestSentBy("commit", { callerParticipant: WIRE_UNREGISTERED });

    expect(Object.keys(request as object)).not.toContain("causationParticipantId");
    expect((request as { readonly repoMountId: unknown }).repoMountId).toBe(SUBJECT.repoMountId);
  });

  it("negative control: no act sends the workspace the gate was read under", async () => {
    // `workspaceId` is what this call used to name and what the registered request does
    // not have. Without this case a sender that spread the whole gate subject would
    // satisfy every assertion above while still sending the member that made the
    // request unacceptable.
    for (const action of ["commit", "push"] as const) {
      const request = await requestSentBy(action);
      expect(Object.keys(request as object)).not.toContain("workspaceId");
      const { params } = request as { readonly params: Record<string, unknown> };
      expect(Object.keys(params)).not.toContain("workspaceId");
    }
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
      expect(refusal?.detail).toContain(DISCONNECTED.message);
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
