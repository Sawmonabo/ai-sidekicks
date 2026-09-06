// The deep-link lifecycle, driven without rendering anything.
//
// Every case here runs the REAL fixture port, so what the adapter reads is what the
// namespace's stand-in actually serves — including the properties that matter most and
// that no component test can reach: that a reference is single-use, that an outcome is
// matched to the invitation it names rather than to whatever is on screen, and that a
// dismissal releases without producing an answer.

import { describe, expect, it } from "vitest";

import { crossMacrotaskBoundary } from "../../core/macrotask-boundary.test-support.js";
import { PAST_REFRESH_DEBOUNCE_MS } from "../../core/settle.test-support.js";
import { createFixtureBridge, type ConsoleBridge } from "../../bridge/index.js";
import type { ConsoleScenario } from "../../bridge/scenario-runtime/scenario.js";
import { fixtureBridgeWithGrowth } from "../../bridge/fixture/fixture-bridge.test-support.js";
import { PendingInviteAdapter, isRetryableOutcome } from "./pending-invite.js";

const FIRST_REFERENCE = "pending-ref-first";
const SECOND_REFERENCE = "pending-ref-second";
const FIRST_SESSION = "019b7914-0001-7000-8000-000000000001";
const SECOND_SESSION = "019b7914-0002-7000-8000-000000000002";
const MEMBERSHIP = "019b7914-0003-7000-8000-000000000003";

/**
 * A scenario carrying two arrivals: one that joins, one that needs authentication.
 *
 * Two rather than one, because half of what this adapter does is decide WHICH
 * invitation an answer is about — a suite with a single reference could not tell a
 * matched outcome from an assumed one.
 */
function scenarioWithArrivals(): ConsoleScenario {
  return {
    id: "collaboration-pending-invite-test",
    label: "Two invitations waiting",
    purpose: "Drives the deep-link lifecycle: arrival, confirmation, retry, dismissal.",
    sessionId: "session-pending-invite-test",
    participantIdsInJoinOrder: [],
    beats: [],
    replies: [],
    startedAtIso: "2026-01-01T10:05:00.000Z",
    pendingInvites: [
      {
        atMs: 0,
        invite: {
          reference: FIRST_REFERENCE,
          sessionId: FIRST_SESSION,
          joinMode: "collaborator",
          expiresAt: "2026-01-08T10:05:00.000Z",
          sessionName: "Design review",
          inviterDisplayName: "Priya Raman",
        },
        onConfirm: {
          kind: "joined",
          reference: FIRST_REFERENCE,
          sessionId: FIRST_SESSION,
          membershipId: MEMBERSHIP,
          role: "collaborator",
        },
      },
      {
        atMs: 0,
        invite: {
          reference: SECOND_REFERENCE,
          sessionId: SECOND_SESSION,
          joinMode: "viewer",
          expiresAt: "2026-01-02T10:05:00.000Z",
          sessionName: null,
          inviterDisplayName: null,
        },
        onConfirm: { kind: "authentication-required", reference: SECOND_REFERENCE },
        onRetry: {
          kind: "joined",
          reference: SECOND_REFERENCE,
          sessionId: SECOND_SESSION,
          membershipId: MEMBERSHIP,
          role: "viewer",
        },
      },
    ],
  };
}

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

/** Let both feeds hand over whatever they are holding. */
async function settleFeeds(): Promise<void> {
  await crossMacrotaskBoundary();
  await crossMacrotaskBoundary();
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

describe("the deep-link lifecycle — a feed that could not be opened", () => {
  it("says nothing when the console never asked", async () => {
    // A build with no wire for this namespace has not failed at anything, and a
    // members section carrying a permanent banner about a channel nobody opened
    // would be reporting an outage that never happened.
    const adapter = new PendingInviteAdapter(
      fixtureBridgeWithGrowth(scenarioWithArrivals(), {
        invitePendingSubscribe: async () =>
          await Promise.resolve({
            status: "unavailable",
            code: "wire-unregistered",
            detail: "Nobody asked.",
            origin: "growth-port",
            operationId: "invitePendingSubscribe",
            slateRow: "pending-invite-namespace",
            owningDocument: "Spec-023",
          }),
      }),
    );
    adapter.requestRead("subscribe");
    await settleFeeds();
    expect(adapter.snapshot().feedRefusal).toBeUndefined();
    expect(adapter.snapshot().invite).toBeUndefined();
    adapter.dispose();
  });

  it("records a feed that was reached and broke", async () => {
    const adapter = new PendingInviteAdapter(
      fixtureBridgeWithGrowth(scenarioWithArrivals(), {
        invitePendingSubscribe: async () => {
          await Promise.resolve();
          throw new Error("the channel went away");
        },
      }),
    );
    adapter.requestRead("subscribe");
    await settleFeeds();
    expect(adapter.snapshot().feedRefusal).toBeDefined();
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

describe("the deep-link lifecycle — keeping the channel up", () => {
  /** The refusal a feed that was REACHED and could not answer comes back with. */
  const UNSCRIPTED_PENDING_FEED = {
    status: "unavailable",
    code: "reply-unscripted",
    detail: "This scenario models no pending-invite feed.",
    origin: "growth-port",
    operationId: "invitePendingSubscribe",
    slateRow: "pending-invite-namespace",
    owningDocument: "Spec-023",
  } as const;

  /**
   * An adapter whose pending feed refuses its first open and serves every later one.
   *
   * The serving arm delegates to a SECOND real fixture port on the same scenario
   * rather than to a stream built here: what a re-open has to produce is whatever the
   * namespace's stand-in produces, and a hand-built feed would let this case pass over
   * a re-open that delivered something the fixture never would.
   */
  function adapterWhosePendingFeedFailsOnce(): {
    readonly adapter: PendingInviteAdapter;
    readonly bridge: ConsoleBridge;
    /** How many times the feed has been opened, refused first attempt included. */
    readonly openAttempts: () => number;
  } {
    const scenario = scenarioWithArrivals();
    const serving = createFixtureBridge({ scenario });
    let attempts = 0;
    const bridge = fixtureBridgeWithGrowth(scenario, {
      invitePendingSubscribe: async (request) => {
        attempts += 1;
        if (attempts === 1) {
          return await Promise.resolve(UNSCRIPTED_PENDING_FEED);
        }
        return await serving.growth.invitePendingSubscribe(request);
      },
    });
    return { adapter: new PendingInviteAdapter(bridge), bridge, openAttempts: () => attempts };
  }

  it("learns nothing from the timeline, and says so", () => {
    // The empty set is a claim rather than an omission, and here it is a strong one: a
    // deep-link invitation is about a session this window is not in, so no event on
    // any session it can see could name one.
    const adapter = new PendingInviteAdapter(
      createFixtureBridge({ scenario: scenarioWithArrivals() }),
    );
    expect([...adapter.triggeringEventKinds]).toStrictEqual([]);
    adapter.dispose();
  });

  it("opens the feed that failed once the connection is repaired", async () => {
    // Without this the failed open would be terminal: an invitation that arrived
    // afterwards would reach a window holding no channel for it, and nothing on
    // screen could say so — an invitation nobody sent and one nobody could deliver
    // look identical from here.
    const { adapter, bridge } = adapterWhosePendingFeedFailsOnce();
    adapter.requestRead("subscribe");
    await settleFeeds();
    expect(adapter.snapshot().invite).toBeUndefined();
    expect(adapter.snapshot().feedRefusal?.code).toBe("reply-unscripted");

    adapter.requestRead("reconnect");
    bridge.scenarioEngine?.advance(PAST_REFRESH_DEBOUNCE_MS);
    await settleFeeds();

    expect(adapter.snapshot().invite?.reference).toBe(FIRST_REFERENCE);
    adapter.dispose();
  });

  it("negative control: a repair opens nothing over a feed that is already up", async () => {
    // Without this the case above would pass over an adapter that opened a second
    // stream on every trigger — two readers on one namespace, each seeing half the
    // frames.
    const { adapter, bridge, openAttempts } = adapterWhosePendingFeedFailsOnce();
    adapter.requestRead("subscribe");
    await settleFeeds();
    adapter.requestRead("reconnect");
    bridge.scenarioEngine?.advance(PAST_REFRESH_DEBOUNCE_MS);
    await settleFeeds();
    // One refused and one served: the feed is up.
    expect(openAttempts()).toBe(2);

    adapter.requestRead("window-focus");
    bridge.scenarioEngine?.advance(PAST_REFRESH_DEBOUNCE_MS);
    await settleFeeds();

    expect(openAttempts()).toBe(2);
    adapter.dispose();
  });

  it("asks for nothing once it has been released", async () => {
    const { adapter, bridge, openAttempts } = adapterWhosePendingFeedFailsOnce();
    adapter.dispose();
    adapter.requestRead("subscribe");
    adapter.requestRead("reconnect");
    bridge.scenarioEngine?.advance(PAST_REFRESH_DEBOUNCE_MS);
    await settleFeeds();

    expect(openAttempts()).toBe(0);
  });
});
