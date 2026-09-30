// The hold's own rules, driven without a bridge. Proving that a full hold degrades to a
// re-read rather than a drop means pushing more frames than the cap admits, which a React hook
// would assert through three unrelated layers.

import { describe, expect, it } from "vitest";
import {
  ProviderAccountNotificationSchema,
  type ProviderAccountNotification,
} from "@ai-sidekicks/contracts";

import { PROVIDER_QUOTA_PENDING_NOTIFICATION_CAP } from "./provider-account-notification-hold.js";
import { ProviderAccountNotificationHold } from "./provider-account-notification-hold.js";

/** Parsed through the registered union rather than cast, so the frame is a real one. */
function removalOf(accountId: string): ProviderAccountNotification {
  return ProviderAccountNotificationSchema.parse({ kind: "account_removed", accountId });
}

describe("ProviderAccountNotificationHold", () => {
  it("holds nothing until a read begins", () => {
    const hold = new ProviderAccountNotificationHold();

    expect(hold.isHolding).toBe(false);
    expect(hold.release()).toStrictEqual([]);
  });

  it("hands frames back in arrival order and stops holding", () => {
    // Order is the claim: a removal then a re-registration and the reverse are the same two
    // frames, and only the sequence says which state the registry ended in.
    const hold = new ProviderAccountNotificationHold();
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
    const hold = new ProviderAccountNotificationHold();
    hold.begin();
    for (let held = 0; held < PROVIDER_QUOTA_PENDING_NOTIFICATION_CAP; held += 1) {
      expect(hold.hold(removalOf(`acct-${String(held)}`))).toBe("held");
    }

    expect(hold.hold(removalOf("acct-overflowing"))).toBe("overflowed");
    // The overflowing frame is not kept: the caller applies it live, and a held copy would be
    // applied twice on the replay.
    expect(hold.release()).toHaveLength(PROVIDER_QUOTA_PENDING_NOTIFICATION_CAP);
  });

  it("a read begun after a release starts empty rather than replaying the last one's", () => {
    // Frames handed to the caller once must not be handed over again.
    const hold = new ProviderAccountNotificationHold();
    hold.begin();
    hold.hold(removalOf("acct-one"));
    hold.release();

    hold.begin();

    expect(hold.isHolding).toBe(true);
    expect(hold.release()).toStrictEqual([]);
  });

  it("a read begun while another is still holding inherits its frames", () => {
    // A `window-focus` trigger begins a second read while the opening one is still traveling,
    // and the opening one's reply is discarded by its ordinal. Clearing on `begin` dropped
    // every frame it held.
    const hold = new ProviderAccountNotificationHold();
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
    // The cap bounds the buffer, not one attempt's share, so an inherited hold that fills
    // degrades to a re-read; a per-attempt cap would let superseded reads grow it without bound.
    const hold = new ProviderAccountNotificationHold();
    hold.begin();
    for (let held = 0; held < PROVIDER_QUOTA_PENDING_NOTIFICATION_CAP; held += 1) {
      expect(hold.hold(removalOf(`acct-${String(held)}`))).toBe("held");
    }

    hold.begin();

    expect(hold.hold(removalOf("acct-overflowing"))).toBe("overflowed");
  });
});
