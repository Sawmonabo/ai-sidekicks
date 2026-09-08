// The deep-link lifecycle, driven without rendering anything.
//
// Every case here runs the REAL fixture port, so what the adapter reads is what the
// namespace's stand-in actually serves — including the properties that matter most and
// that no component test can reach: that a reference is single-use, that an outcome is
// matched to the invitation it names rather than to whatever is on screen, and that a
// dismissal releases without producing an answer.
//
// The FEED cases — a channel that would not open, one that broke part-way, and one
// that came back — are `pending-invite.feeds.test.ts`, and the two states a preview
// reaches when it produces no invitation are `pending-invite.previews.test.ts`. All
// three drive the same scenario and the same started adapter, which is why both live
// in `pending-invite.test-support.ts` and in none of them.

import { describe, expect, it } from "vitest";

import type { ConsoleScenario } from "../../bridge/scenario-runtime/scenario.js";
import { PENDING_INVITE_QUEUE_MAX } from "../../core/index.js";
import type { PendingInviteAdapter } from "./pending-invite.js";
import {
  FIRST_REFERENCE,
  SECOND_REFERENCE,
  scenarioWithArrivals,
  scenarioWithUnsentAcceptance,
  settleFeeds,
  startedAdapter,
} from "./pending-invite.test-support.js";

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

describe("the deep-link lifecycle — an answer about the handle rather than the invitation", () => {
  it("settles a prompt an authentication detour would otherwise hold open forever", async () => {
    // The union carried four arms and neither of the two main emits about the HANDLE,
    // so an acceptance waiting on authentication had no terminal it could reach: the
    // reference bound lapses mid-ceremony, main answers `reference-invalid`, and a
    // window that could not represent that arm kept the prompt on screen with nothing
    // to press for the rest of the visit.
    const adapter = await startedAdapter();
    adapter.dismiss();
    await settleFeeds();
    adapter.confirm();
    await settleFeeds();
    expect(adapter.snapshot().outcome?.kind).toBe("authentication-required");
    adapter.acknowledge();
    expect(adapter.snapshot().invite?.reference).toBe(SECOND_REFERENCE);

    adapter.confirm();
    await settleFeeds();

    expect(adapter.snapshot().outcome).toMatchObject({
      kind: "reference-invalid",
      reason: "consumed",
    });
    adapter.acknowledge();
    expect(adapter.snapshot().invite).toBeUndefined();
    adapter.dispose();
  });
});

describe("the deep-link lifecycle — putting one away", () => {
  it("releases a reference the authentication detour is still holding", async () => {
    // The way out of a ceremony that has stalled, and the reason the card routes
    // Escape and the backdrop here rather than to the acknowledgement on this one
    // arm: acknowledging is refused while a terminal is still to come, so a card that
    // acknowledged left the prompt gone and the reference outstanding. The act that
    // works is the wire's, and this is the port serving it mid-ceremony.
    const adapter = await startedAdapter();
    adapter.dismiss();
    await settleFeeds();
    adapter.confirm();
    await settleFeeds();
    expect(adapter.snapshot().outcome?.kind).toBe("authentication-required");

    adapter.dismiss();
    await settleFeeds();

    expect(adapter.snapshot().actRefusal).toBeUndefined();
    expect(adapter.snapshot().invite).toBeUndefined();
    adapter.dispose();
  });

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

describe("the deep-link lifecycle — an acceptance that never reached the control plane", () => {
  // The defect this block exists for: `unavailable` was classified with the five
  // terminal arms, so a local acknowledgement cleared the prompt and released nothing
  // — while main went on holding a reference the wire had just called retryable, and
  // the next replay of the pending feed put the same invitation back on screen.

  it("refuses a local acknowledgement, because main is still holding the reference", async () => {
    const adapter = await startedAdapter(scenarioWithUnsentAcceptance());
    adapter.confirm();
    await settleFeeds();
    expect(adapter.snapshot().outcome?.kind).toBe("unavailable");

    adapter.acknowledge();

    expect(adapter.snapshot().invite?.reference).toBe(FIRST_REFERENCE);
    adapter.dispose();
  });

  it("releases it through main when the dismissal is dispatched instead", async () => {
    // The act that DOES work on this arm, driven through the real port: the entry is
    // spent for confirmation and still present, so the dismissal is served and the
    // queue moves.
    const adapter = await startedAdapter(scenarioWithUnsentAcceptance());
    adapter.confirm();
    await settleFeeds();

    adapter.dismiss();
    await settleFeeds();

    expect(adapter.snapshot().actRefusal).toBeUndefined();
    expect(adapter.snapshot().invite?.reference).toBe(SECOND_REFERENCE);
    adapter.dispose();
  });

  it("negative control: an answer that DID spend its reference is acknowledged away", async () => {
    // Without this the first case would pass over an adapter that had stopped
    // acknowledging anything at all, which would strand every settled prompt.
    const adapter = await startedAdapter();
    adapter.confirm();
    await settleFeeds();
    expect(adapter.snapshot().outcome?.kind).toBe("joined");

    adapter.acknowledge();

    expect(adapter.snapshot().invite?.reference).toBe(SECOND_REFERENCE);
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

describe("the deep-link lifecycle — more than the queue holds", () => {
  const BOUND_SESSION = "019b7920-0000-7000-8000-000000000001";

  /** One arrival past the bound, all due at the first tick. */
  function scenarioPastTheBound(): ConsoleScenario {
    const references = Array.from(
      { length: PENDING_INVITE_QUEUE_MAX + 1 },
      (_unused, index) => `bound-ref-${String(index + 1)}`,
    );
    return {
      ...scenarioWithArrivals(),
      pendingInvites: references.map((reference) => ({
        atMs: 0,
        invite: {
          reference,
          sessionId: BOUND_SESSION,
          joinMode: "collaborator" as const,
          expiresAt: "2026-01-08T10:05:00.000Z",
          sessionName: null,
          inviterDisplayName: null,
        },
        onConfirm: {
          kind: "joined" as const,
          reference,
          sessionId: BOUND_SESSION,
          membershipId: "019b7920-0000-7000-8000-000000000002",
          role: "collaborator",
        },
      })),
    };
  }

  /** Put the head away and let the release settle. */
  async function dismissHead(adapter: PendingInviteAdapter): Promise<void> {
    adapter.dismiss();
    await settleFeeds();
  }

  it("holds the bound and says the rest are waiting rather than dropping them", async () => {
    const adapter = await startedAdapter(scenarioPastTheBound());
    expect(adapter.snapshot().waitingBehind).toBe(PENDING_INVITE_QUEUE_MAX - 1);
    expect(adapter.snapshot().hasDeferredArrivals).toBe(true);
    adapter.dispose();
  });

  it("asks main to re-deliver once the queue has room, and shows what it held back", async () => {
    // The recovery `core/constants.ts` names beside the bound: main holds every
    // reference until an act releases it, and re-opening the pending feed
    // re-delivers them. Without the request the ninth invitation is gone for the
    // life of the window — nobody dropped it on purpose and nobody can get it back.
    const adapter = await startedAdapter(scenarioPastTheBound());
    await dismissHead(adapter);
    expect(adapter.snapshot().hasDeferredArrivals).toBe(false);
    expect(adapter.snapshot().waitingBehind).toBe(PENDING_INVITE_QUEUE_MAX - 1);

    for (let released = 1; released < PENDING_INVITE_QUEUE_MAX; released += 1) {
      await dismissHead(adapter);
    }
    expect(adapter.snapshot().invite?.reference).toBe(
      `bound-ref-${String(PENDING_INVITE_QUEUE_MAX + 1)}`,
    );
    adapter.dispose();
  });

  it("negative control: a window inside the bound asks for no replay", async () => {
    // Without this the case above would pass over a reading that re-opened the feed
    // on every release, which is a subscription churned once per invitation read.
    const adapter = await startedAdapter();
    expect(adapter.snapshot().hasDeferredArrivals).toBe(false);
    await dismissHead(adapter);
    expect(adapter.snapshot().hasDeferredArrivals).toBe(false);
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
