// The two growth feeds the deep-link lifecycle reads: opening one, losing one, and
// getting one back.
//
// Its own file rather than three more suites in `pending-invite.test.ts`, on the split
// `SentInvites.reading` / `.revoking` / `.subject` already make in this directory: that
// file is about what the lifecycle DOES with an invitation — arrival, confirmation,
// retry, dismissal, matching an answer to its subject — and this one is about the
// channel underneath it, which fails and recovers in ways no case up there can reach.
//
// What both files share is one scenario and one settle helper, and both live in
// `pending-invite.test-support.ts` rather than in either suite: two invitation tables
// for one adapter would be two places a member added to `GrowthPendingInvite` has to
// be remembered.

import { describe, expect, it } from "vitest";

import { PAST_REFRESH_DEBOUNCE_MS } from "../../core/settle.test-support.js";
import {
  createFixtureBridge,
  type ConsoleBridge,
  type GrowthPendingInvite,
} from "../../bridge/index.js";
import { fixtureBridgeWithGrowth } from "../../bridge/fixture/fixture-bridge.test-support.js";
import { PendingInviteAdapter } from "./pending-invite.js";
import {
  FIRST_REFERENCE,
  FIRST_SESSION,
  scenarioWithArrivals,
  settleFeeds,
} from "./pending-invite.test-support.js";

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

describe("the deep-link lifecycle — a feed that opened and then broke", () => {
  /**
   * A pending feed that hands over one invitation and then ends the way the caller
   * decides — by throwing, or by running out.
   *
   * Hand-built rather than delegated to a second fixture port, which is the shape
   * the re-open cases below use: a scenario scripts arrivals and a clean end, and a
   * producer that fails PART-WAY is the one ending it cannot express. So this is the
   * narrow exception, and it is built with both endings so the failing case has a
   * negative control that differs from it in exactly one statement.
   */
  function feedEndingAfterOneInvite(ending: "throws" | "runs-out"): {
    readonly bridge: ConsoleBridge;
    /** How many times the handle was closed, so a leak is an assertion rather than a hope. */
    readonly closes: () => number;
  } {
    let closes = 0;
    const bridge = fixtureBridgeWithGrowth(scenarioWithArrivals(), {
      invitePendingSubscribe: async () =>
        await Promise.resolve({
          status: "served",
          value: {
            events: (async function* serveOneThenEnd(): AsyncGenerator<GrowthPendingInvite> {
              yield {
                reference: FIRST_REFERENCE,
                sessionId: FIRST_SESSION,
                joinMode: "collaborator",
                expiresAt: "2026-01-08T10:05:00.000Z",
                sessionName: "Design review",
                inviterDisplayName: "Priya Raman",
              };
              if (ending === "throws") {
                throw new Error("the producer went away mid-stream");
              }
            })(),
            close: (): void => {
              closes += 1;
            },
          },
        }),
    });
    return { bridge, closes: () => closes };
  }

  it("says a feed that threw part-way is down", async () => {
    // Without the drain's `catch` this is an unhandled promise rejection and nothing
    // else: the refusal is never recorded, so the section keeps drawing a channel
    // that is down and an invitation nobody could deliver stays indistinguishable
    // from one nobody sent — which is the exact confusion this lifecycle exists to
    // remove for the ENDED case and had left open for the THREW one.
    const { bridge } = feedEndingAfterOneInvite("throws");
    const adapter = new PendingInviteAdapter(bridge);
    adapter.requestRead("subscribe");
    await settleFeeds();

    expect(adapter.snapshot().invite?.reference).toBe(FIRST_REFERENCE);
    expect(adapter.snapshot().feedRefusal).toBeDefined();
    adapter.dispose();
  });

  it("closes the handle of a feed that threw part-way", async () => {
    // A producer that threw is still a subscription somebody has to end. Dropping
    // the handle leaves it and the producer behind it alive for the life of the
    // window, once per open — and the triggers above re-open on every reconnect.
    const { bridge, closes } = feedEndingAfterOneInvite("throws");
    const adapter = new PendingInviteAdapter(bridge);
    adapter.requestRead("subscribe");
    await settleFeeds();

    expect(closes()).toBe(1);
    adapter.dispose();
  });

  it("negative control: a feed that simply ran out is not a failure", async () => {
    // Without this the case above would pass over a drain that recorded a refusal
    // for every ending, which would put a permanent banner under every feed that
    // finished normally.
    const { bridge } = feedEndingAfterOneInvite("runs-out");
    const adapter = new PendingInviteAdapter(bridge);
    adapter.requestRead("subscribe");
    await settleFeeds();

    expect(adapter.snapshot().invite?.reference).toBe(FIRST_REFERENCE);
    expect(adapter.snapshot().feedRefusal).toBeUndefined();
    adapter.dispose();
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

  it("takes the banner down once the feed it described is back", async () => {
    // The refusal is a claim about a channel's state NOW. Written and never cleared it
    // outlives the outage: the feed re-opens on the next repair trigger, invitations
    // arrive again, and the section goes on telling a person the channel is down for
    // the life of the window — the one state a reader can neither act on nor dismiss.
    const { adapter, bridge } = adapterWhosePendingFeedFailsOnce();
    adapter.requestRead("subscribe");
    await settleFeeds();
    expect(adapter.snapshot().feedRefusal).toBeDefined();

    adapter.requestRead("reconnect");
    bridge.scenarioEngine?.advance(PAST_REFRESH_DEBOUNCE_MS);
    await settleFeeds();

    // Both halves, because either alone is satisfied by the wrong adapter: a feed that
    // came back with the banner still up, or a banner cleared by an open that served
    // nothing.
    expect(adapter.snapshot().invite?.reference).toBe(FIRST_REFERENCE);
    expect(adapter.snapshot().feedRefusal).toBeUndefined();
    adapter.dispose();
  });

  it("negative control: a repair that does not reach the feed leaves the banner up", async () => {
    // Without this the case above would pass over an adapter that cleared its refusal
    // on every open ATTEMPT — which would take the banner down while the channel was
    // still down, and put it back on the next failure, blinking.
    const scenario = scenarioWithArrivals();
    const bridge = fixtureBridgeWithGrowth(scenario, {
      invitePendingSubscribe: async () => await Promise.resolve(UNSCRIPTED_PENDING_FEED),
    });
    const adapter = new PendingInviteAdapter(bridge);
    adapter.requestRead("subscribe");
    await settleFeeds();
    expect(adapter.snapshot().feedRefusal?.code).toBe("reply-unscripted");

    adapter.requestRead("reconnect");
    bridge.scenarioEngine?.advance(PAST_REFRESH_DEBOUNCE_MS);
    await settleFeeds();

    expect(adapter.snapshot().feedRefusal?.code).toBe("reply-unscripted");
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
