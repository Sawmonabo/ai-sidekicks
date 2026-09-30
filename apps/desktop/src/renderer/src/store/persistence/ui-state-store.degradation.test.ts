// No durable store means a visible degradation, not a silent one. A renderer whose scheme was
// not registered privileged runs on the in-memory adapter and says so on the quota gauge as
// well as in prose, so a view reading only the gauge does not report a silent nothing. An
// unread gauge is not an empty one. The clock is frozen, so a stamped record is evidence.

import { describe, expect, it } from "vitest";

import { ManualClock } from "@renderer/lib/clock.js";
import {
  PERSISTENCE_UNAVAILABLE_DESCRIPTIONS,
  describeQuotaUnavailability,
  unmeasuredQuota,
} from "./persistence-adapter.js";
import { MemoryPersistenceAdapter } from "./memory-persistence-adapter.js";
import { UiStateStore } from "./ui-state-store.js";

describe("no durable store means a visible degradation, not a silent one", () => {
  it("discloses the cause in prose AND on the quota gauge", async () => {
    const store = new UiStateStore({
      adapter: new MemoryPersistenceAdapter({ unavailableReason: "open-refused" }),
      clock: new ManualClock(1_000),
    });

    const health = await store.health();

    expect(health.adapterKind).toBe("memory");
    expect(health.durable).toBe(false);
    expect(health.description).toContain("not survive a restart");
    // "Storage unavailable" alone would leave an operator with nothing to check.
    expect(health.description).toContain("renderer scheme");
    // The gauge, which a storage view reads, carries the reason rather than three absent
    // numbers.
    expect(health.quota.unavailableReason).toBe("open-refused");
    expect(describeQuotaUnavailability(health.quota)).toBe(
      PERSISTENCE_UNAVAILABLE_DESCRIPTIONS["open-refused"],
    );
    await store.close();
  });

  it("negative control: the reason discriminates rather than always producing text", () => {
    // Guards against a `describeQuotaUnavailability` that returned a sentence unconditionally.
    expect(describeQuotaUnavailability(unmeasuredQuota(undefined))).toBeUndefined();
    expect(describeQuotaUnavailability(unmeasuredQuota("open-timed-out"))).toBe(
      PERSISTENCE_UNAVAILABLE_DESCRIPTIONS["open-timed-out"],
    );
  });

  it("reports pressure and the reason together once a ceiling is known", async () => {
    const adapter = new MemoryPersistenceAdapter({
      unavailableReason: "no-indexeddb-global",
      capacityBytes: 200,
    });
    const store = new UiStateStore({ adapter, clock: new ManualClock(1_000) });

    const beforePressure = await store.health();
    expect(beforePressure.quota.pressure).toBe("ok");
    expect(beforePressure.quota.quotaBytes).toBe(200);
    expect(beforePressure.quota.unavailableReason).toBe("no-indexeddb-global");

    await store.write("session-1", "expansion", "expansion", [
      "run-0001",
      "run-0002",
      "run-0003",
      "run-0004",
      "run-0005",
      "run-0006",
      "run-0007",
      "run-0008",
      "run-0009",
      "run-0010",
      "run-0011",
      "run-0012",
      "run-0013",
      "run-0014",
    ]);

    const afterPressure = await store.health();
    // Pressure is reported, never acted on behind the operator's back.
    expect(afterPressure.quota.pressure).toBe("high");
    expect(afterPressure.quota.unavailableReason).toBe("no-indexeddb-global");
    await store.close();
  });

  it("falls all the way back to memory when the window has no database API", async () => {
    // The composition root's path end to end: `opening()` attempts the durable open, this host
    // has no database API, and the store that comes back works but says it is not durable.
    const clock = new ManualClock(1_000);
    const store = UiStateStore.opening({ clock });

    const health = await store.health();

    expect(health.adapterKind).toBe("memory");
    expect(health.durable).toBe(false);
    expect(health.quota.unavailableReason).toBe("no-indexeddb-global");
    expect(describeQuotaUnavailability(health.quota)).toBe(
      PERSISTENCE_UNAVAILABLE_DESCRIPTIONS["no-indexeddb-global"],
    );
    // Preferences still round-trip, and the open armed no timer: the timeout race exists only
    // when there is something to race against.
    await expect(store.writeGlobal("scheme", "scheme", "dark")).resolves.toStrictEqual({
      outcome: "written",
    });
    expect((await store.readGlobal("scheme"))?.updatedAt).toBe(1_000);
    expect(clock.pendingCount).toBe(0);
    await store.close();
  });

  it("starts as 'nothing has been read yet', not as zero bytes used", () => {
    const store = new UiStateStore({
      adapter: new MemoryPersistenceAdapter(),
      clock: new ManualClock(1_000),
    });

    // An unread gauge is not an empty one.
    expect(store.lastQuota.usageBytes).toBeUndefined();
    expect(store.lastQuota.quotaBytes).toBeUndefined();
    expect(store.lastQuota.unavailableReason).toBe("not-attempted");
  });
});
