// The hold's own rules, driven without a bridge: every frame held across the registry's opening
// read reaches the fold once and in arrival order, or the reply's writes undo a removal or a
// credential change that arrived meanwhile.

import { describe, expect, it } from "vitest";
import {
  ProviderAccountNotificationSchema,
  type ProviderAccountNotification,
} from "@ai-sidekicks/contracts";

import { ProviderAccountNotificationHold } from "./provider-account-notification-hold.js";

/** Parsed through the registered union rather than cast, so the frame is a real one. */
function removalOf(accountId: string): ProviderAccountNotification {
  return ProviderAccountNotificationSchema.parse({ kind: "account_removed", accountId });
}

describe("ProviderAccountNotificationHold", () => {
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
});
