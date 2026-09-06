// The account-plane quota reading, asserted where it decides something.
//
// FIVE CLAIMS, and each one is a place the console could start showing a figure the
// registry never sent: the READ is what seeds the chips, the TAIL is what moves one
// of them, a reading behind its own account's generation is marked stale, a frame
// the registered union does not admit moves nothing at all, and a same-window reading
// that moved BACKWARD is held here as it is in the fold.
//
// The supersession rules themselves are asserted in `provider-quota-fold.test.ts`,
// where the disposition is readable directly. What is claimed here is the WIRING —
// that a reading arriving off the tail actually reaches that rule.
//
// The fourth is the defect this module replaced, stated as its own case. The chips
// used to be folded out of `usage.rate_limit_update` rows in a session's timeline —
// a row the daemon binds to the node-scope sentinel session, so no session store
// holds one — and this reading is driven only by the account plane. Pushing a
// timeline-shaped row at it therefore has to change nothing, and the case beside it
// pushes the registered notification so the assertion is not merely a surface that
// stopped updating at all.
//
// Driven through `useProviderQuotas` rather than the reading class, because the
// watcher count is half of what is being claimed: one read and one subscription per
// bridge, opened by the first watcher and closed by the last. This is the same shape
// `queue-feed.test.tsx` takes over its own reading class.
//
// This file keeps the READ: what the registry reply seeds the chips with. What the
// TAIL then does with them is `provider-quota-feed.deliveries.test.tsx`, and what
// happens when the tail opens first is `provider-quota-feed.buffering.test.tsx`.

import { describe, expect, it } from "vitest";

import {
  ACCOUNT_ID,
  AccountPlaneBridge,
  OTHER_ACCOUNT_ID,
  account,
  listReply,
  mountQuotas,
  readingAt,
  usageWindow,
} from "./provider-quota-feed.test-support.js";

describe("useProviderQuotas — the read seeds the chips", () => {
  it("turns the reply's windows into readings labelled by their own accounts", async () => {
    const plane = new AccountPlaneBridge(
      listReply(
        [account(), account({ accountId: OTHER_ACCOUNT_ID, displayLabel: "Personal" })],
        [
          usageWindow(),
          usageWindow({ limitId: "weekly-opus", label: "Weekly, Opus", usedPercent: 91 }),
          usageWindow({ accountId: OTHER_ACCOUNT_ID, limitId: "default", label: undefined }),
        ],
      ),
    );
    const mounted = await mountQuotas(plane.bridge);

    expect(mounted.readingsNow()).toHaveLength(3);
    expect(readingAt(mounted.readingsNow(), "weekly-all").accountLabel).toBe("Team");
    expect(readingAt(mounted.readingsNow(), "weekly-opus").usedPercent).toBe(91);
    // No published label, so the window's own identifier stands in — the most
    // specific true thing the console holds, rather than a composed name.
    expect(readingAt(mounted.readingsNow(), "default").limitLabel).toBe("default");
    expect(plane.listCallCount).toBe(1);
  });

  it("keeps two windows of one length apart by their limit ids", async () => {
    // The pair key, and the whole reason the readings are not keyed by duration: the
    // two windows below are both 10080 minutes, and a duration key keeps one.
    const plane = new AccountPlaneBridge(
      listReply(
        [account()],
        [usageWindow(), usageWindow({ limitId: "weekly-opus", label: "Weekly, Opus" })],
      ),
    );
    const mounted = await mountQuotas(plane.bridge);

    expect(mounted.readingsNow().map((reading) => reading.limitId)).toStrictEqual([
      "weekly-all",
      "weekly-opus",
    ]);
  });

  it("negative control: a window whose account the registry does not carry is dropped", async () => {
    // Without this the seeding case would hold over a fold that rendered every window
    // it was handed, labelling one with an opaque id nobody chose.
    const plane = new AccountPlaneBridge(
      listReply([account()], [usageWindow(), usageWindow({ accountId: "acct-unknown" })]),
    );
    const mounted = await mountQuotas(plane.bridge);

    expect(mounted.readingsNow()).toHaveLength(1);
    expect(readingAt(mounted.readingsNow(), "weekly-all").accountId).toBe(ACCOUNT_ID);
  });

  it("says why it holds nothing when the read is refused", async () => {
    const plane = new AccountPlaneBridge({ accounts: "not a list" });
    const mounted = await mountQuotas(plane.bridge);

    expect(mounted.readingsNow()).toStrictEqual([]);
    expect(mounted.refusalCodeNow()).toBe("reply-unreadable");
  });
});
