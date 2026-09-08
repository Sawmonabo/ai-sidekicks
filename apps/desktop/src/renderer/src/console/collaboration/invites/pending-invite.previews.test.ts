// What a deep link's preview answered, and the one state a person can put again.
//
// Its own file rather than five more suites in `pending-invite.test.ts`, on the split
// `pending-invite.feeds.test.ts` already makes in this directory: that file is about
// what the lifecycle does with an INVITATION — arrival, confirmation, dismissal,
// matching an answer to its subject, and the bound on how many it holds — and this
// one is about the two states a preview reaches when it produces no invitation at
// all, plus the retry that is the only act either admits.
//
// The scenario and the started adapter both live in `pending-invite.test-support.ts`,
// because both files drive them.

import { describe, expect, it } from "vitest";

import { type GrowthPendingInviteState } from "../../bridge/index.js";
import { FixtureGrowthStream } from "../../bridge/fixture/growth/growth-stream.js";
import { fixtureBridgeWithGrowth } from "../../bridge/fixture/call-plane/bridge.test-support.js";
import { PendingInviteAdapter } from "./pending-invite.js";
import { isInviteOutcomeInProgress } from "./pending-invite-reading.js";
import {
  FIRST_REFERENCE,
  PENDING_INVITE_ATTEMPT,
  SECOND_REFERENCE,
  readyPreview,
  refusedPreview,
  scenarioWithArrivals,
  settleFeeds,
  startedAdapter,
  unavailablePreview,
} from "./pending-invite.test-support.js";

/**
 * A started adapter reading one hand-built pending feed.
 *
 * The narrow exception `pending-invite.feeds.test.ts` already takes, and for the same
 * reason: the scenario table scripts INVITATIONS, so the two arms a preview reaches
 * when it produces no invitation — refused, and could-not-be-put — are the two states
 * it cannot express. Everything else here drives the real fixture port.
 */
async function adapterReadingArrivals(
  ...arrivals: readonly GrowthPendingInviteState[]
): Promise<PendingInviteAdapter> {
  const adapter = new PendingInviteAdapter(
    fixtureBridgeWithGrowth(scenarioWithArrivals(), {
      invitePendingSubscribe: async () => {
        const feed = new FixtureGrowthStream<GrowthPendingInviteState>();
        for (const arrival of arrivals) {
          feed.push(arrival);
        }
        return await Promise.resolve({ status: "served", value: feed });
      },
    }),
  );
  adapter.requestRead("subscribe");
  await settleFeeds();
  return adapter;
}

describe("the deep-link lifecycle — what the preview answered", () => {
  it("shows a preview that succeeded as the invitation it is", async () => {
    const adapter = await adapterReadingArrivals(readyPreview());
    const snapshot = adapter.snapshot();
    expect(snapshot.invite?.reference).toBe("pending-ref-under-test");
    expect(snapshot.previewFailure).toBeUndefined();
    expect(snapshot.canRetry).toBe(false);
    adapter.dispose();
  });

  it("shows a preview the control plane refused, with its own code and no invitation", async () => {
    // Typed as the ready arm alone this frame had nowhere to arrive: an expired or
    // revoked link reached the window and the window showed nothing at all.
    const adapter = await adapterReadingArrivals(refusedPreview());
    const snapshot = adapter.snapshot();
    expect(snapshot.previewFailure?.status).toBe("refused");
    expect(snapshot.previewFailure).toMatchObject({ code: "invite.expired" });
    expect(snapshot.invite).toBeUndefined();
    expect(snapshot.canRetry).toBe(false);
    adapter.dispose();
  });

  it("shows a preview that could not be put, and offers the one act it admits", async () => {
    const adapter = await adapterReadingArrivals(unavailablePreview());
    const snapshot = adapter.snapshot();
    expect(snapshot.previewFailure?.status).toBe("unavailable");
    expect(snapshot.invite).toBeUndefined();
    expect(snapshot.canRetry).toBe(true);
    adapter.dispose();
  });

  it("holds all three in arrival order, one prompt at a time", async () => {
    const adapter = await adapterReadingArrivals(
      refusedPreview(),
      unavailablePreview(),
      readyPreview(),
    );
    expect(adapter.snapshot().previewFailure?.status).toBe("refused");
    expect(adapter.snapshot().waitingBehind).toBe(2);
    adapter.acknowledge();
    expect(adapter.snapshot().previewFailure?.status).toBe("unavailable");
    adapter.acknowledge();
    expect(adapter.snapshot().invite?.reference).toBe("pending-ref-under-test");
    adapter.dispose();
  });

  it("holds one copy of a frame a replay delivers twice", async () => {
    // A re-opened feed re-delivers everything main is still holding, so the same
    // arrival arriving twice is the ordinary case rather than the odd one.
    const adapter = await adapterReadingArrivals(
      readyPreview(),
      readyPreview(),
      unavailablePreview(),
      unavailablePreview(),
    );
    expect(adapter.snapshot().waitingBehind).toBe(1);
    adapter.dispose();
  });
});

describe("the deep-link lifecycle — trying again", () => {
  /** An adapter over one arrival, recording what the retry operation was asked for. */
  async function adapterRecordingRetries(arrival: GrowthPendingInviteState): Promise<{
    readonly adapter: PendingInviteAdapter;
    readonly requests: readonly unknown[];
  }> {
    const requests: unknown[] = [];
    const adapter = new PendingInviteAdapter(
      fixtureBridgeWithGrowth(scenarioWithArrivals(), {
        invitePendingSubscribe: async () => {
          const feed = new FixtureGrowthStream<GrowthPendingInviteState>();
          feed.push(arrival);
          return await Promise.resolve({ status: "served", value: feed });
        },
        inviteRetryPending: async (request) => {
          requests.push(request);
          return await Promise.resolve({ status: "served", value: undefined });
        },
      }),
    );
    adapter.requestRead("subscribe");
    await settleFeeds();
    return { adapter, requests };
  }

  it("carries the attempt handle, and never the pending reference", async () => {
    const { adapter, requests } = await adapterRecordingRetries(unavailablePreview());
    adapter.retry();
    await settleFeeds();
    expect(requests).toEqual([{ attempt: PENDING_INVITE_ATTEMPT }]);
    expect(requests[0]).not.toHaveProperty("reference");
    adapter.dispose();
  });

  it("releases the prompt it re-drove, because the answer arrives as a fresh state", async () => {
    const { adapter } = await adapterRecordingRetries(unavailablePreview());
    adapter.retry();
    await settleFeeds();
    expect(adapter.snapshot().previewFailure).toBeUndefined();
    expect(adapter.snapshot().canRetry).toBe(false);
    adapter.dispose();
  });

  it("offers no second attempt on a preview that answered", async () => {
    const { adapter, requests } = await adapterRecordingRetries(refusedPreview());
    expect(adapter.snapshot().canRetry).toBe(false);
    adapter.retry();
    await settleFeeds();
    expect(requests).toEqual([]);
    adapter.dispose();
  });

  it("sends nothing for either authentication outcome", async () => {
    // The bug this replaces: both were treated as retryable, so pressing again sent
    // a reference — main's, spent or lent out — to the operation that takes an
    // attempt handle and does not accept one.
    const requests: unknown[] = [];
    const adapter = new PendingInviteAdapter(
      fixtureBridgeWithGrowth(scenarioWithArrivals(), {
        inviteRetryPending: async (request) => {
          requests.push(request);
          return await Promise.resolve({ status: "served", value: undefined });
        },
      }),
    );
    adapter.requestRead("subscribe");
    await settleFeeds();
    adapter.confirm();
    await settleFeeds();
    adapter.acknowledge();
    adapter.confirm();
    await settleFeeds();

    expect(adapter.snapshot().outcome?.kind).toBe("authentication-required");
    expect(adapter.snapshot().canRetry).toBe(false);
    adapter.retry();
    await settleFeeds();
    expect(requests).toEqual([]);
    adapter.dispose();
  });

  it("offers a retry from exactly one of the three states", () => {
    // The closed set the surface reads: one answer still running, one answer that
    // ended, and one preview that never reached the control plane.
    const inProgress = isInviteOutcomeInProgress({
      kind: "authentication-required",
      reference: FIRST_REFERENCE,
    });
    const ended = isInviteOutcomeInProgress({
      kind: "authentication-failed",
      reference: FIRST_REFERENCE,
      detail: "The device code expired.",
    });
    expect([inProgress, ended]).toEqual([true, false]);
    expect(unavailablePreview().retryable).toBe(true);
  });

  it("holds an answer still running open, and lets an ended one be put away", async () => {
    const adapter = await startedAdapter();
    adapter.dismiss();
    await settleFeeds();
    adapter.confirm();
    await settleFeeds();
    expect(adapter.snapshot().outcome?.kind).toBe("authentication-required");

    // Acknowledging here would clear a prompt whose terminal arm is still coming, and
    // main is still holding its reference across the ceremony.
    adapter.acknowledge();
    expect(adapter.snapshot().invite?.reference).toBe(SECOND_REFERENCE);
    adapter.dispose();
  });
});
