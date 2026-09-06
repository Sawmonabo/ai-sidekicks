// What the TAIL does to a reading the read already seeded.
//
// Split from the read's own cases because the subject is different: those are about
// the registry reply, and every case here takes a seeded chip as its premise and is
// about the frame that arrives afterwards — one window moving, a frame the registered
// union does not admit, and a reading behind its own account's credential generation.

import { act } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  ACCOUNT_ID,
  AccountPlaneBridge,
  account,
  listReply,
  mountQuotas,
  readingAt,
  usageWindow,
} from "./provider-quota-feed.test-support.js";

describe("useProviderQuotas — the tail moves one reading", () => {
  it("replaces the newer observation of one (account, limit) and leaves the rest", async () => {
    const plane = new AccountPlaneBridge(
      listReply(
        [account()],
        [usageWindow(), usageWindow({ limitId: "weekly-opus", label: "Weekly, Opus" })],
      ),
    );
    const mounted = await mountQuotas(plane.bridge);

    await act(async () => {
      plane.deliver({
        kind: "usage_window_updated",
        accountId: ACCOUNT_ID,
        window: usageWindow({ usedPercent: 88, observedAt: "2026-01-01T12:00:00.000Z" }),
      });
    });

    expect(readingAt(mounted.readingsNow(), "weekly-all").usedPercent).toBe(88);
    expect(readingAt(mounted.readingsNow(), "weekly-opus").usedPercent).toBe(62);
  });

  it("keeps the newest observation when an older one arrives after it", async () => {
    const plane = new AccountPlaneBridge(listReply([account()], [usageWindow()]));
    const mounted = await mountQuotas(plane.bridge);

    await act(async () => {
      plane.deliver({
        kind: "usage_window_updated",
        accountId: ACCOUNT_ID,
        window: usageWindow({ usedPercent: 5, observedAt: "2025-12-31T23:00:00.000Z" }),
      });
    });

    expect(readingAt(mounted.readingsNow(), "weekly-all").usedPercent).toBe(62);
  });

  it("ignores a session-timeline row pushed at it", async () => {
    // The defect this module replaced. `usage.rate_limit_update` is the row the
    // composer used to fold, and it is not a registered account-plane notification —
    // so the envelope below reaches the tail and changes nothing.
    const plane = new AccountPlaneBridge(listReply([account()], [usageWindow()]));
    const mounted = await mountQuotas(plane.bridge);

    await act(async () => {
      plane.deliver({
        id: "event-1",
        sessionId: "00000000-0000-0000-0000-000000000000",
        sequence: 1,
        type: "usage.rate_limit_update",
        payload: {
          providerAccountId: ACCOUNT_ID,
          limitId: "weekly-all",
          accountLabel: "Team",
          limitLabel: "Weekly, all models",
          usedPercent: 99,
          observedAt: "2026-01-01T13:00:00.000Z",
        },
      });
    });

    expect(readingAt(mounted.readingsNow(), "weekly-all").usedPercent).toBe(62);
  });

  it("holds the high-water figure when the tail sends a lower one for the same window", async () => {
    // Consumption does not fall inside one window, so a 90%-consumed account must not
    // regress to 20% on a newer timestamp and hide imminent exhaustion until the
    // window actually resets.
    const plane = new AccountPlaneBridge(
      listReply(
        [account()],
        [usageWindow({ usedPercent: 90, resetsAt: "2026-01-08T00:00:00.000Z" })],
      ),
    );
    const mounted = await mountQuotas(plane.bridge);

    await act(async () => {
      plane.deliver({
        kind: "usage_window_updated",
        accountId: ACCOUNT_ID,
        window: usageWindow({
          usedPercent: 20,
          resetsAt: "2026-01-08T00:00:00.000Z",
          observedAt: "2026-01-01T13:00:00.000Z",
        }),
      });
    });

    expect(readingAt(mounted.readingsNow(), "weekly-all").usedPercent).toBe(90);
  });

  it("takes the lower figure once the window's own reset horizon has moved", async () => {
    // Negative control on the guard above: a reset horizon that moved IS a new window,
    // so the same lower reading is the ordinary case and must be seated.
    const plane = new AccountPlaneBridge(
      listReply(
        [account()],
        [usageWindow({ usedPercent: 90, resetsAt: "2026-01-08T00:00:00.000Z" })],
      ),
    );
    const mounted = await mountQuotas(plane.bridge);

    await act(async () => {
      plane.deliver({
        kind: "usage_window_updated",
        accountId: ACCOUNT_ID,
        window: usageWindow({
          usedPercent: 20,
          resetsAt: "2026-01-15T00:00:00.000Z",
          observedAt: "2026-01-01T13:00:00.000Z",
        }),
      });
    });

    expect(readingAt(mounted.readingsNow(), "weekly-all").usedPercent).toBe(20);
  });

  it("negative control: the same reading DOES move on the registered notification", async () => {
    // Without this the case above would hold over a tail that had stopped delivering
    // anything at all, which is a different bug wearing the same green.
    const plane = new AccountPlaneBridge(listReply([account()], [usageWindow()]));
    const mounted = await mountQuotas(plane.bridge);

    await act(async () => {
      plane.deliver({
        kind: "usage_window_updated",
        accountId: ACCOUNT_ID,
        window: usageWindow({ usedPercent: 99, observedAt: "2026-01-01T13:00:00.000Z" }),
      });
    });

    expect(readingAt(mounted.readingsNow(), "weekly-all").usedPercent).toBe(99);
  });
});

describe("useProviderQuotas — a delivery this build cannot read is a partial read", () => {
  it("counts an unreadable delivery and keeps the snapshot it already has", async () => {
    // The chips a person is looking at stay: they are the best reading the console
    // has. What changes is that the console now says the tail carrying the next one
    // is incomplete, instead of presenting the old snapshot as current.
    const plane = new AccountPlaneBridge(listReply([account()], [usageWindow()]));
    const mounted = await mountQuotas(plane.bridge);

    await act(async () => {
      plane.deliver({ kind: "account_removed" });
    });

    expect(mounted.partialNow().unreadableDeliveryCount).toBe(1);
    expect(mounted.partialNow().unreadableRefusalCode).toBe("delivery-unreadable");
    expect(mounted.readingsNow()).toHaveLength(1);
  });

  it("keeps counting, because an unreadable shape is a build fact and not a blip", async () => {
    // Nothing clears this count — deliberately, and unlike the queue's. The registry
    // read answers for an instant the tail has already moved past, so no snapshot may
    // claim to cover a frame that arrived after it.
    const plane = new AccountPlaneBridge(listReply([account()], [usageWindow()]));
    const mounted = await mountQuotas(plane.bridge);

    await act(async () => {
      plane.deliver({ kind: "account_removed" });
      plane.deliver({ kind: "usage_window_updated", accountId: ACCOUNT_ID });
    });

    expect(mounted.partialNow().unreadableDeliveryCount).toBe(2);
  });

  it("negative control: a readable delivery leaves the reading whole", async () => {
    // Without this the cases above would hold over a reading that counted every
    // delivery, readable or not, and the count would mean nothing.
    const plane = new AccountPlaneBridge(listReply([account()], [usageWindow()]));
    const mounted = await mountQuotas(plane.bridge);

    await act(async () => {
      plane.deliver({ kind: "account_removed", accountId: ACCOUNT_ID });
    });

    expect(mounted.partialNow().unreadableDeliveryCount).toBe(0);
    expect(mounted.partialNow().unreadableRefusalCode).toBeUndefined();
    expect(mounted.readingsNow()).toStrictEqual([]);
  });
});

describe("useProviderQuotas — a reading behind its account's generation is stale", () => {
  it("marks the reading observed under the older generation and no other", async () => {
    const plane = new AccountPlaneBridge(
      listReply(
        [account({ credentialGeneration: 2 })],
        [
          usageWindow({ observedCredentialGeneration: 1 }),
          usageWindow({
            limitId: "weekly-opus",
            label: "Weekly, Opus",
            observedCredentialGeneration: 2,
          }),
        ],
      ),
    );
    const mounted = await mountQuotas(plane.bridge);

    expect(readingAt(mounted.readingsNow(), "weekly-all").isStale).toBe(true);
    expect(readingAt(mounted.readingsNow(), "weekly-opus").isStale).toBe(false);
  });

  it("re-reads staleness when the account's own generation advances on the tail", async () => {
    // The comparison the timeline fold could not make: the account moved, the stored
    // reading did not, and the chip has to say so without a second quota row arriving.
    const plane = new AccountPlaneBridge(listReply([account()], [usageWindow()]));
    const mounted = await mountQuotas(plane.bridge);
    expect(readingAt(mounted.readingsNow(), "weekly-all").isStale).toBe(false);

    await act(async () => {
      plane.deliver({ kind: "account_changed", account: account({ credentialGeneration: 2 }) });
    });

    expect(readingAt(mounted.readingsNow(), "weekly-all").isStale).toBe(true);
  });

  it("negative control: an account on its original generation marks nothing stale", async () => {
    const plane = new AccountPlaneBridge(
      listReply([account()], [usageWindow(), usageWindow({ limitId: "weekly-opus" })]),
    );
    const mounted = await mountQuotas(plane.bridge);

    expect(mounted.readingsNow().every((reading) => !reading.isStale)).toBe(true);
  });
});
