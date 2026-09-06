// The tail opens BEFORE the read settles, so a frame that arrives between them is
// buffered rather than dropped — and one subscription is opened per bridge.
//
// Its own file because both claims are about the ORDER of the two seams rather than
// about either one's content: every case here parks the read on purpose, which is a
// premise none of the other two files takes.

import { act } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PROVIDER_QUOTA_PENDING_NOTIFICATION_CAP } from "../../core/index.js";
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
import { drainMicrotasks } from "../../core/microtask-drain.test-support.js";

describe("useProviderQuotas — the tail opens before the read, so it is buffered across it", () => {
  /** Let every microtask the read's continuation chain queues actually run. */
  async function settleMicrotasks(): Promise<void> {
    await act(async () => {
      await drainMicrotasks();
    });
  }

  it("keeps an account removed when the removal arrives before the snapshot lands", async () => {
    // The snapshot is taken at an instant the tail has already moved past, so applying
    // the removal on arrival let the reply's unconditional writes resurrect the
    // account — and the tail emits no second notification for a mutation it already
    // reported, so it stayed resurrected for the life of the window.
    const plane = new AccountPlaneBridge(listReply([account()], [usageWindow()]), {
      holdsReads: true,
    });
    const mounted = await mountQuotas(plane.bridge);

    await act(async () => {
      plane.deliver({ kind: "account_removed", accountId: ACCOUNT_ID });
    });
    await act(async () => {
      plane.settleRead();
    });
    await settleMicrotasks();

    expect(mounted.readingsNow()).toStrictEqual([]);
  });

  it("keeps a credential generation that advanced before the snapshot landed", async () => {
    // The other half of the same defect: the snapshot's older account row overwrote the
    // newer one, and a stale quota reading then presented itself as current.
    const plane = new AccountPlaneBridge(listReply([account()], [usageWindow()]), {
      holdsReads: true,
    });
    const mounted = await mountQuotas(plane.bridge);

    await act(async () => {
      plane.deliver({ kind: "account_changed", account: account({ credentialGeneration: 2 }) });
    });
    await act(async () => {
      plane.settleRead();
    });
    await settleMicrotasks();

    expect(readingAt(mounted.readingsNow(), "weekly-all").isStale).toBe(true);
  });

  it("re-reads rather than dropping once the hold is full, and the abandoned reply seats nothing", async () => {
    // Past the cap the reading applies what it holds and takes a FRESH read. The
    // abandoned read is settled LAST here on purpose: its reply is the one that could
    // still overwrite a newer snapshot, and the ordinal is what stops it.
    const plane = new AccountPlaneBridge(listReply([account()], [usageWindow()]), {
      holdsReads: true,
      laterReply: listReply(
        [account({ accountId: OTHER_ACCOUNT_ID, displayLabel: "Personal" })],
        [usageWindow({ accountId: OTHER_ACCOUNT_ID })],
      ),
    });
    const mounted = await mountQuotas(plane.bridge);

    await act(async () => {
      for (
        let delivered = 0;
        delivered <= PROVIDER_QUOTA_PENDING_NOTIFICATION_CAP;
        delivered += 1
      ) {
        plane.deliver({ kind: "account_removed", accountId: `acct-departed-${String(delivered)}` });
      }
    });
    expect(plane.listCallCount).toBe(2);

    // The fresh read answers first, then the one it superseded.
    await act(async () => {
      plane.settleRead(1);
    });
    await settleMicrotasks();
    await act(async () => {
      plane.settleRead(0);
    });
    await settleMicrotasks();

    expect(mounted.readingsNow().map((reading) => reading.accountId)).toStrictEqual([
      OTHER_ACCOUNT_ID,
    ]);
  });

  it("negative control: a notification after the read has settled applies at once", async () => {
    // Without this every case above would hold over a reading that had simply stopped
    // applying notifications, and the buffer would be indistinguishable from a drop.
    const plane = new AccountPlaneBridge(listReply([account()], [usageWindow()]));
    const mounted = await mountQuotas(plane.bridge);
    expect(mounted.readingsNow()).toHaveLength(1);

    await act(async () => {
      plane.deliver({ kind: "account_removed", accountId: ACCOUNT_ID });
    });

    expect(mounted.readingsNow()).toStrictEqual([]);
    expect(plane.listCallCount).toBe(1);
  });

  it("negative control: nothing is held once the read has answered", async () => {
    // The hold is scoped to the OPENING read. A reading that kept buffering forever
    // would pass the removal case above and never move again.
    const plane = new AccountPlaneBridge(listReply([account()], [usageWindow()]), {
      holdsReads: true,
    });
    const mounted = await mountQuotas(plane.bridge);
    await act(async () => {
      plane.settleRead();
    });
    await settleMicrotasks();

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

describe("useProviderQuotas — one subscription per bridge", () => {
  it("opens once for two watchers and closes when the last leaves", async () => {
    const plane = new AccountPlaneBridge(listReply([account()], [usageWindow()]));
    const first = await mountQuotas(plane.bridge);
    const second = await mountQuotas(plane.bridge);

    expect(plane.openCount).toBe(1);
    expect(plane.listCallCount).toBe(1);

    await act(async () => {
      first.unmount();
    });
    expect(plane.closeCount).toBe(0);

    await act(async () => {
      second.unmount();
    });
    expect(plane.closeCount).toBe(1);
  });

  it("leaves one live registered reading when one watcher replaces another in a commit", async () => {
    // Cleanups run before setups, so the arriving watcher's subscribe lands after the
    // leaving one retired the reading. Subscribing through a reading captured at
    // render revived it outside the registry, and the next watcher minted a second —
    // two reads and two tails for the one node-scoped question this answers once.
    const plane = new AccountPlaneBridge(listReply([account()], [usageWindow()]));
    const leaving = await mountQuotas(plane.bridge);
    await act(async () => {
      leaving.unmount();
    });
    const arriving = await mountQuotas(plane.bridge);
    const joining = await mountQuotas(plane.bridge);

    expect(plane.openCount).toBe(2);
    expect(plane.listCallCount).toBe(2);

    // And the reading the swap left behind is the registered one: the joiner shares
    // it, so its departure alone does not close the tail.
    await act(async () => {
      arriving.unmount();
    });
    expect(plane.closeCount).toBe(1);
    await act(async () => {
      joining.unmount();
    });
    expect(plane.closeCount).toBe(2);
  });
});
