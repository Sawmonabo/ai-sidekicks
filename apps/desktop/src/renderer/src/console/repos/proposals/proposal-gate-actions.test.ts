// Each act from its own answer, and the request the act puts on the wire.
//
// THE ACT HALF ONLY. Which arm a read publishes is `proposal-gate-reader.test.ts`,
// beside the module that owns it; the scripted port every file here drives is
// `proposal-gate-scripted-port.test-support.ts`, which is where the fixture choice and the drain
// discipline are recorded.
//
// WHAT A REFUSAL LEAVES STANDING IS NEXT DOOR, in `proposal-gate-refusals.test.ts`,
// beside the module that composes those sentences; WHICH ACTS ARE ADMITTED AT ALL is
// in `proposal-gate-actions.admission.test.ts` — the single flight, the context
// re-check, and the identity a caller acts under.
//
// DRIVEN THROUGH `ProposalGateReader.requestAction`, which is the one seam a surface
// has: the acts are constructed by the reader and handed its host, so a case that
// built a `ProposalGateActions` over a hand-written host would be asserting against a
// host the console never composes.

import { afterEach, describe, expect, it } from "vitest";

import { PARTICIPANT_YOU } from "../../bridge/scenarios/repos-fixture-data.js";
import { ManualClock } from "../../core/index.js";
import { offeredProposalActions, type ProposalAction } from "./proposal-actions.js";
import type { ProposalGateReader } from "./proposal-gate-reader.js";
import {
  ACCEPTED_ACTION,
  OpenReaders,
  SERVED_CONTEXT,
  SUBJECT,
  WIRE_UNREGISTERED,
  bridgeAnswering,
  bridgeWithMovingAnswers,
  publishedProposalOf,
  recordingPort,
  settleAct,
  settle,
} from "./proposal-gate-scripted-port.test-support.js";

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
