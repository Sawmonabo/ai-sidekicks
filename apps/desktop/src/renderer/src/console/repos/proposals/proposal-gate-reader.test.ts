// Each arm from its own outcome, each reason from its own transition, and no timer at
// all.
//
// THE READ HALF ONLY. What an act sends and what its answer leaves standing is
// `proposal-gate-actions.test.ts`, beside the module that owns it; the scripted port
// both files drive is `proposal-gate-scripted-port.test-support.ts`, which is where the fixture
// choice and the drain discipline are recorded.

import { afterEach, describe, expect, it } from "vitest";

import { createFixtureBridge } from "../../bridge/index.js";
import { REPOS_SCENARIO } from "../../bridge/scenarios/repos.js";
import { ManualClock, REFRESH_DEBOUNCE_MS } from "../../core/index.js";
import type { ProposalGateReading } from "./proposal-gate-model.js";
import {
  OpenReaders,
  READ_ONLY_SUBJECT,
  REPLY_ABANDONED,
  SERVED_CONTEXT,
  WIRE_UNREGISTERED,
  gateBridgeAnswering,
  bridgeWithMovingAnswers,
  publishedProposalOf,
  rejectsWith,
  servedContext,
  settle,
  settleAct,
} from "./proposal-gate-scripted-port.test-support.js";
import type { ProposalGateReader } from "./proposal-gate-reader.js";
import { offeredProposalActions } from "./proposal-actions.js";

const readers = new OpenReaders();

afterEach(() => {
  readers.disposeAll();
});

describe("ProposalGateReader — one arm per outcome", () => {
  it("says nobody could ask when the wire is unregistered, and carries the port's sentence", async () => {
    const clock = new ManualClock();
    const reader = readers.open(gateBridgeAnswering({ branchContext: WIRE_UNREGISTERED }), clock);
    reader.start();
    await settle(clock, reader);

    const reading = reader.snapshot;
    expect(reading.state.kind).toBe("not-checked");
    // The arm carries no message of its own, so the refusal travels beside it — this
    // is the field the section renders through `RefusalCard`.
    expect(reading.refusal?.code).toBe("wire-unregistered");
    expect(reading.settlement).toBe(WIRE_UNREGISTERED.detail);
  });

  it("says the read failed when the question was put and the answer never came", async () => {
    // The OTHER refusal class, and it is a different arm: `not-checked` would claim
    // nothing was asked, which is false here.
    const clock = new ManualClock();
    const reader = readers.open(gateBridgeAnswering({ branchContext: REPLY_ABANDONED }), clock);
    reader.start();
    await settle(clock, reader);

    const reading = reader.snapshot;
    expect(reading.state).toStrictEqual({ kind: "refused", message: REPLY_ABANDONED.detail });
    // The arm carries the message, so the same sentence is not also put beside it.
    expect(reading.refusal).toBeUndefined();
  });

  it("says the read failed when the call rejected, and carries what the rejection said", async () => {
    // THE THIRD WAY THIS READ FAILS, and it earns the same arm as the case above for
    // the same reason: an IPC disconnect makes the call THROW, which is the question
    // PUT and no answer arriving. It used to land on `not-checked` — the family's
    // growth door stamped `wire-unregistered` on every rejection, so a gate whose
    // bridge had dropped reported that nobody had asked and showed no reason at all.
    // `repos/growth-call.ts` hands the rejection to the port's own builder now, which
    // stamps `call-rejected`, and `proposal-gate-readings.ts` routes every member but
    // the unregistered one to the arm that says something went wrong.
    const disconnected = new Error("the bridge went away mid-read");
    const clock = new ManualClock();
    const reader = readers.open(
      gateBridgeAnswering({ branchContext: rejectsWith(disconnected) }),
      clock,
    );
    reader.start();
    await settle(clock, reader);

    const reading = reader.snapshot;
    expect(reading.state.kind).toBe("refused");
    expect(reading.state.kind === "refused" ? reading.state.message : "").toContain(
      disconnected.message,
    );
    // The arm carries the message, so nothing is put beside it — which is also what
    // tells this arm from `not-checked`, where the refusal travels in `refusal`.
    expect(reading.refusal).toBeUndefined();
  });

  it("reports a workspace with no context as the daemon's own refusal", async () => {
    // The registered reply is FLAT and carries no absence: a `(workspace, worktree)`
    // pair that resolves no row refuses, so "there is no context here" arrives as the
    // daemon's sentence on the `refused` arm rather than as a console reading of an
    // empty envelope member. That envelope was the bug — a contract-shaped reply made
    // it `undefined` on EVERY read, so every gate published the absence and withheld
    // its proposal actions.
    const clock = new ManualClock();
    const reader = readers.open(
      gateBridgeAnswering({
        branchContext: {
          status: "unavailable",
          code: "wire-unregistered",
          origin: "growth-port",
          detail: "worktree.not_found: no branch context for this pair",
        },
      }),
      clock,
      READ_ONLY_SUBJECT,
    );
    reader.start();
    await settle(clock, reader);

    expect(reader.snapshot.state).toStrictEqual({ kind: "not-checked" });
    expect(reader.snapshot.refusal?.detail).toContain("no branch context for this pair");
  });

  it("publishes the served context from the real fixture, verbatim and without the workspace id", async () => {
    const clock = new ManualClock();
    const reader = readers.open(createFixtureBridge({ scenario: REPOS_SCENARIO }), clock);
    reader.start();
    await settle(clock, reader);

    const { state } = reader.snapshot;
    expect(state.kind).toBe("prepared");
    if (state.kind !== "prepared") {
      throw new Error("the fixture served a context, so the arm is `prepared`");
    }
    expect(state.context.baseBranch).toBe("develop");
    expect(state.context.headBranch).toBe("feat/rate-limit-wiring");
    expect(state.context.executionMode).toBe("worktree");
    // Nothing supplied a host, so none is claimed — the member is absent rather than
    // defaulted to a provider name.
    expect(state.detectedHost).toBeUndefined();
    expect(state.proposal).toBeUndefined();
    expect("workspaceId" in state.context).toBe(false);
  });

  it("negative control: nothing is read until the gate starts", async () => {
    // Without this the cases above would pass against a reader that read at
    // construction, which would put a call behind every render pass React discards.
    const clock = new ManualClock();
    const reader = readers.open(gateBridgeAnswering({ branchContext: SERVED_CONTEXT }), clock);
    clock.advance(REFRESH_DEBOUNCE_MS);
    await Promise.resolve();

    expect(reader.performCount).toBe(0);
    expect(reader.snapshot.state.kind).toBe("not-checked");
    expect(reader.snapshot.refusal).toBeUndefined();
  });

  it("enters the wait once: a refresh redraws the answer, never the wait", async () => {
    const clock = new ManualClock();
    const reader = readers.open(gateBridgeAnswering({ branchContext: SERVED_CONTEXT }), clock);
    const seen: ProposalGateReading[] = [];
    reader.subscribe((reading) => seen.push(reading));
    reader.start();
    await settle(clock, reader);

    window.dispatchEvent(new Event("focus"));
    await settle(clock, reader);

    expect(reader.performCount).toBe(2);
    expect(seen.filter((reading) => reading.state.kind === "preparing")).toHaveLength(1);
  });
});

describe("ProposalGateReader — the proposal and the context it was prepared for", () => {
  /** Prepare a proposal, then serve `nextContext` and let the re-read land. */
  async function prepareThenRefresh(nextContext: unknown): Promise<ProposalGateReader> {
    const clock = new ManualClock();
    const { bridge, serveContext } = bridgeWithMovingAnswers();
    const reader = readers.open(bridge, clock);
    reader.start();
    await settle(clock, reader);

    await reader.requestAction("prepare-proposal");
    await settleAct(clock, reader);

    serveContext(nextContext);
    window.dispatchEvent(new Event("focus"));
    await settle(clock, reader);
    return reader;
  }

  it("keeps the proposal when the refreshed context is the same one", async () => {
    const reader = await prepareThenRefresh(SERVED_CONTEXT);

    expect(publishedProposalOf(reader)).toBeDefined();
    // The whole point of retaining it: the remote act stays offered.
    expect(offeredProposalActions(reader.snapshot.state)).toContain("push");
  });

  it("drops the proposal when the refreshed context is a different context row", async () => {
    const reader = await prepareThenRefresh(
      servedContext({ branchContextId: "019b7b30-0280-7c11-8420-b1a5c0de2399" }),
    );

    expect(publishedProposalOf(reader)).toBeUndefined();
    // Push is what a stale proposal would have authorised, so this is the claim.
    expect(offeredProposalActions(reader.snapshot.state)).not.toContain("push");
  });

  it("drops the proposal when the head branch moved under the same context row", async () => {
    // The id-only check would pass this one: a repair re-establishes the row over a
    // moved head, and the proposal was built against the branch that is gone.
    const reader = await prepareThenRefresh(servedContext({ headBranch: "feat/something-else" }));

    expect(publishedProposalOf(reader)).toBeUndefined();
    expect(offeredProposalActions(reader.snapshot.state)).not.toContain("push");
  });
});
