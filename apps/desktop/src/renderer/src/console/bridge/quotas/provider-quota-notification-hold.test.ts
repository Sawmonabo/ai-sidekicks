// The hold's own rules, driven without a bridge.
//
// The cap is the reason this is its own module: proving that a full hold degrades to
// a re-read rather than a drop means pushing more frames than the cap admits, and
// doing that through a React hook asserts the arithmetic through three layers that
// have nothing to do with it.

import { describe, expect, it } from "vitest";
import {
  ProviderAccountNotificationSchema,
  type ProviderAccountNotification,
} from "@ai-sidekicks/contracts";

import { PROVIDER_QUOTA_PENDING_NOTIFICATION_CAP } from "../../core/index.js";
import { ProviderQuotaNotificationHold } from "./provider-quota-notification-hold.js";

/** Parsed through the registered union rather than cast, so the frame is a real one. */
function removalOf(accountId: string): ProviderAccountNotification {
  return ProviderAccountNotificationSchema.parse({ kind: "account_removed", accountId });
}

describe("ProviderQuotaNotificationHold", () => {
  it("holds nothing until a read begins", () => {
    const hold = new ProviderQuotaNotificationHold();

    expect(hold.isHolding).toBe(false);
    expect(hold.release()).toStrictEqual([]);
  });

  it("hands frames back in arrival order and stops holding", () => {
    // Order is the whole claim: a removal followed by a re-registration and the
    // reverse pair are the same two frames, and only the sequence says which state
    // the registry ended in.
    const hold = new ProviderQuotaNotificationHold();
    hold.begin();
    hold.hold(removalOf("acct-one"));
    hold.hold(removalOf("acct-two"));

    const released = hold.release();

    expect(released.map((notification) => JSON.stringify(notification))).toStrictEqual([
      JSON.stringify(removalOf("acct-one")),
      JSON.stringify(removalOf("acct-two")),
    ]);
    expect(hold.isHolding).toBe(false);
  });

  it("says the caller must re-read once the cap is reached", () => {
    const hold = new ProviderQuotaNotificationHold();
    hold.begin();
    for (let held = 0; held < PROVIDER_QUOTA_PENDING_NOTIFICATION_CAP; held += 1) {
      expect(hold.hold(removalOf(`acct-${String(held)}`))).toBe("held");
    }

    expect(hold.hold(removalOf("acct-overflowing"))).toBe("overflowed");
    // The overflowing frame is NOT kept: the caller applies it live, and a copy held
    // here would be applied a second time on the replay.
    expect(hold.release()).toHaveLength(PROVIDER_QUOTA_PENDING_NOTIFICATION_CAP);
  });

  it("a read begun after a release starts empty rather than replaying the last one's", () => {
    // The overflow path's sequence, and the double-apply the release above rules out:
    // frames handed to the caller once must not be handed over a second time.
    const hold = new ProviderQuotaNotificationHold();
    hold.begin();
    hold.hold(removalOf("acct-one"));
    hold.release();

    hold.begin();

    expect(hold.isHolding).toBe(true);
    expect(hold.release()).toStrictEqual([]);
  });

  it("a read begun while another is still holding inherits its frames", () => {
    // The superseded-attempt sequence, which nothing releases: a `window-focus`
    // trigger begins a second read while the opening one is still travelling, and the
    // opening one's reply is then discarded by its ordinal. Clearing here dropped
    // every frame it held — silently, by the method whose purpose is that none is.
    const hold = new ProviderQuotaNotificationHold();
    hold.begin();
    hold.hold(removalOf("acct-one"));

    hold.begin();
    hold.hold(removalOf("acct-two"));

    expect(hold.isHolding).toBe(true);
    expect(hold.release().map((notification) => JSON.stringify(notification))).toStrictEqual([
      JSON.stringify(removalOf("acct-one")),
      JSON.stringify(removalOf("acct-two")),
    ]);
  });

  it("counts an inherited frame against the cap rather than past it", () => {
    // The cap bounds the BUFFER and not one attempt's share of it, so an inherited
    // hold that fills degrades to the same re-read as any other. A cap re-based per
    // attempt would let a run of superseded reads grow the buffer without bound.
    const hold = new ProviderQuotaNotificationHold();
    hold.begin();
    for (let held = 0; held < PROVIDER_QUOTA_PENDING_NOTIFICATION_CAP; held += 1) {
      expect(hold.hold(removalOf(`acct-${String(held)}`))).toBe("held");
    }

    hold.begin();

    expect(hold.hold(removalOf("acct-overflowing"))).toBe("overflowed");
  });
});
