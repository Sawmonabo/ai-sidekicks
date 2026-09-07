// The deep-link lifecycle, driven without rendering anything.
//
// Every case here runs the REAL fixture port, so what the adapter reads is what the
// namespace's stand-in actually serves — including the properties that matter most and
// that no component test can reach: that a reference is single-use, that an outcome is
// matched to the invitation it names rather than to whatever is on screen, and that a
// dismissal releases without producing an answer.
//
// The FEED cases — a channel that would not open, one that broke part-way, and one that
// came back — are `pending-invite.feeds.test.ts`. Both files drive the same scenario,
// which is why it lives in `pending-invite.test-support.ts` and in neither of them.

import { describe, expect, it } from "vitest";

import { createFixtureBridge } from "../../bridge/index.js";
import type { ConsoleScenario } from "../../bridge/scenario-runtime/scenario.js";
import { PendingInviteAdapter, isRetryableOutcome } from "./pending-invite.js";
import {
  FIRST_REFERENCE,
  FIRST_SESSION,
  MEMBERSHIP,
  SECOND_REFERENCE,
  scenarioWithArrivals,
  settleFeeds,
} from "./pending-invite.test-support.js";

/** A started adapter over the real fixture port, with both feeds drained once. */
async function startedAdapter(
  scenario: ConsoleScenario = scenarioWithArrivals(),
): Promise<PendingInviteAdapter> {
  const adapter = new PendingInviteAdapter(createFixtureBridge({ scenario }));
  // The reading's own `subscribe` read, which is what opens both feeds.
  adapter.requestRead("subscribe");
  await settleFeeds();
  return adapter;
}

describe("the deep-link lifecycle — what arrives", () => {
  it("shows the first invitation and counts the rest", async () => {
    const adapter = await startedAdapter();
    const snapshot = adapter.snapshot();
    expect(snapshot.invite?.reference).toBe(FIRST_REFERENCE);
    expect(snapshot.invite?.sessionName).toBe("Design review");
    expect(snapshot.waitingBehind).toBe(1);
    adapter.dispose();
  });

  it("negative control: a scenario that scripts none shows nothing", async () => {
    const adapter = await startedAdapter({ ...scenarioWithArrivals(), pendingInvites: [] });
    expect(adapter.snapshot().invite).toBeUndefined();
    expect(adapter.snapshot().waitingBehind).toBe(0);
    adapter.dispose();
  });

  it("delivers frames pushed before anything subscribed", async () => {
    // The deep link's own shape: the protocol fires before any surface mounts, so a
    // feed that only carried what arrived after subscription would carry nothing at
    // all for the case this namespace exists to serve.
    const adapter = await startedAdapter();
    expect(adapter.snapshot().invite).toBeDefined();
    adapter.dispose();
  });
});

describe("the deep-link lifecycle — confirming", () => {
  it("accepts nothing until it is asked to", async () => {
    const adapter = await startedAdapter();
    expect(adapter.snapshot().outcome).toBeUndefined();
    adapter.dispose();
  });

  it("lands the outcome the scenario scripted for that reference", async () => {
    const adapter = await startedAdapter();
    adapter.confirm();
    await settleFeeds();
    const { outcome } = adapter.snapshot();
    expect(outcome?.kind).toBe("joined");
    expect(outcome?.reference).toBe(FIRST_REFERENCE);
    adapter.dispose();
  });

  it("spends the reference, so a second confirmation finds nothing", async () => {
    // Single-use is the property the whole opaque-reference design exists for, and
    // it is the fixture's own refusal that enforces it here rather than a rule this
    // adapter re-states.
    const adapter = await startedAdapter();
    adapter.confirm();
    await settleFeeds();
    adapter.confirm();
    await settleFeeds();
    expect(adapter.snapshot().actRefusal?.code).toBe("reply-unscripted");
    adapter.dispose();
  });

  it("moves to the next invitation once the answer is acknowledged", async () => {
    const adapter = await startedAdapter();
    adapter.confirm();
    await settleFeeds();
    adapter.acknowledge();
    expect(adapter.snapshot().invite?.reference).toBe(SECOND_REFERENCE);
    expect(adapter.snapshot().outcome).toBeUndefined();
    expect(adapter.snapshot().waitingBehind).toBe(0);
    adapter.dispose();
  });

  it("negative control: an unanswered head is not acknowledged away", async () => {
    // Without this the case above would pass over an acknowledgement that dropped
    // whatever was on screen, answered or not — which would lose an invitation.
    const adapter = await startedAdapter();
    adapter.acknowledge();
    expect(adapter.snapshot().invite?.reference).toBe(FIRST_REFERENCE);
    adapter.dispose();
  });
});

describe("the deep-link lifecycle — trying again", () => {
  it("carries a second attempt on the same reference", async () => {
    const adapter = await startedAdapter();
    adapter.confirm();
    await settleFeeds();
    adapter.acknowledge();
    adapter.confirm();
    await settleFeeds();
    expect(adapter.snapshot().outcome?.kind).toBe("authentication-required");

    adapter.retry();
    await settleFeeds();
    const { outcome } = adapter.snapshot();
    expect(outcome?.kind).toBe("joined");
    expect(outcome?.reference).toBe(SECOND_REFERENCE);
    adapter.dispose();
  });

  it("offers a second attempt only where one can help", () => {
    expect(
      isRetryableOutcome({ kind: "authentication-required", reference: FIRST_REFERENCE }),
    ).toBe(true);
    expect(
      isRetryableOutcome({
        kind: "authentication-failed",
        reference: FIRST_REFERENCE,
        detail: "The device code expired.",
      }),
    ).toBe(true);
    // A refusal is the control plane's own answer about this invitation: pressing
    // again sends the identical request to the identical answer.
    expect(
      isRetryableOutcome({
        kind: "refused",
        reference: FIRST_REFERENCE,
        code: "invite.expired",
        detail: "Invite has expired and can no longer be accepted",
      }),
    ).toBe(false);
    expect(
      isRetryableOutcome({
        kind: "joined",
        reference: FIRST_REFERENCE,
        sessionId: FIRST_SESSION,
        membershipId: MEMBERSHIP,
        role: "collaborator",
      }),
    ).toBe(false);
    expect(isRetryableOutcome(undefined)).toBe(false);
  });
});

describe("the deep-link lifecycle — putting one away", () => {
  it("releases the reference and shows what was behind it", async () => {
    const adapter = await startedAdapter();
    adapter.dismiss();
    await settleFeeds();
    expect(adapter.snapshot().invite?.reference).toBe(SECOND_REFERENCE);
    adapter.dispose();
  });

  it("produces no outcome, because nothing happened anybody is owed an answer about", async () => {
    const adapter = await startedAdapter();
    adapter.dismiss();
    await settleFeeds();
    expect(adapter.snapshot().outcome).toBeUndefined();
    adapter.dispose();
  });
});

describe("the deep-link lifecycle — matching an answer to its invitation", () => {
  it("names the invitation the answer is actually about", async () => {
    // A window can receive the answer to an invitation it dismissed a moment ago, so
    // the reference travels on every outcome and the adapter matches on it rather
    // than assuming the feed speaks only about what is on screen. Here the first
    // invitation is released before anything is confirmed, so an adapter that
    // assumed would install the answer against a reference it no longer holds.
    const adapter = await startedAdapter();
    adapter.dismiss();
    await settleFeeds();
    adapter.confirm();
    await settleFeeds();
    const { outcome } = adapter.snapshot();
    expect(outcome?.reference).toBe(SECOND_REFERENCE);
    adapter.dispose();
  });
});

describe("the deep-link lifecycle — release", () => {
  it("forgets everything and answers nothing further", async () => {
    const adapter = await startedAdapter();
    adapter.dispose();
    expect(adapter.isDisposed).toBe(true);
    adapter.confirm();
    await settleFeeds();
    expect(adapter.snapshot().outcome).toBeUndefined();
  });
});
