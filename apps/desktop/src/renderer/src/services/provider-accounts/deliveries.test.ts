// A provider-account delivery is checked with the notification's generated check: one it refuses
// moves no account but is counted and published, never dropped unheard, and one it admits moves
// the fold.

import { describe, expect, it, vi } from "vitest";

import { ProviderAccountFold } from "#renderer/store/provider-accounts/fold.js";
import { ProviderAccountDeliveries } from "./deliveries.js";

describe("a provider-account delivery", () => {
  it("counts and publishes one its check refuses, and applies one it admits", () => {
    const onChanged = vi.fn();
    const deliveries = new ProviderAccountDeliveries(new ProviderAccountFold(), {
      onChanged,
      onSupersededRead: vi.fn(),
    });

    deliveries.deliver({ kind: "accountRemoved", accountId: 7 });

    expect(deliveries.unreadable.unreadableDeliveryCount).toBe(1);
    expect(deliveries.unreadable.unreadableRefusal?.code).toBe("delivery-unreadable");
    expect(onChanged).toHaveBeenCalledOnce();

    deliveries.deliver({ kind: "accountRemoved", accountId: "pa-0003" });

    expect(deliveries.unreadable.unreadableDeliveryCount).toBe(1);
    expect(onChanged).toHaveBeenCalledTimes(2);
  });
});
