// The write chokepoint keeps prose and paths out of the unencrypted durable store: a value, an
// object key, a record key or a partition that is not identifier-shaped is refused, nothing is
// written, and the tripwire fires without quoting what it refused. A failed read is a third
// answer, not a second nothing, so a caller that writes back a value derived from an absence does
// not overwrite what the adapter still holds.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ManualClock } from "@renderer/lib/clock.js";
import { isRefusal } from "@renderer/lib/refusal.js";
import { windowTripwires } from "@renderer/lib/tripwires.js";
import { ReadFailurePersistenceAdapter } from "@test/helpers/read-failure-persistence-adapter.js";
import { MemoryPersistenceAdapter } from "./memory-persistence-adapter.js";
import { UiStateStore } from "./ui-state-store.js";

// Tripwires throw in development; here they are recorded, because these cases assert the
// breach was detected and described.
beforeEach(() => {
  windowTripwires.setThrowOnReport(false);
  windowTripwires.reset();
});

afterEach(() => {
  windowTripwires.reset();
});

describe("the write chokepoint refuses what the durable store may not hold", () => {
  it("refuses prose inside an ADMITTED class, so the class is not the only guard", async () => {
    const store = new UiStateStore({
      adapter: new MemoryPersistenceAdapter(),
      clock: new ManualClock(1_000),
    });

    const result = await store.write("session-1", "selection", "selection", {
      note: "Rerun the migration against staging and tell me what the row counts look like.",
    });

    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.refusal.code).toBe("value-not-identifier-shaped");
    }
    expect(windowTripwires.firingCount("persistence-value-class")).toBe(1);
    await store.close();
  });

  it("refuses a key built from prose, writes nothing, and fires the tripwire", async () => {
    // Nothing in the value is wrong, so a chokepoint validating only the value would have
    // written the sentence.
    const store = new UiStateStore({
      adapter: new MemoryPersistenceAdapter(),
      clock: new ManualClock(1_000),
    });
    const proseKey = "Rerun the migration and tell me what the row counts look like";

    const result = await store.write("session-1", proseKey, "expansion", ["run-01"]);

    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.refusal.code).toBe("address-not-identifier-shaped");
      expect(isRefusal(result.refusal)).toBe(true);
    }
    expect(windowTripwires.firingCount("persistence-value-class")).toBe(1);
    // The site a tripwire reports must not carry the prose the store refused.
    expect(windowTripwires.reports().at(-1)?.site).not.toContain(proseKey);

    expect(await store.read("session-1", proseKey)).toBeUndefined();
    expect(await store.readPartition("session-1")).toStrictEqual([]);
    const health = await store.health();
    expect(health.refusalCounts["address-not-identifier-shaped"]).toBe(1);
    await store.close();
  });

  it("refuses a path-shaped partition, which the value grammar would have admitted", async () => {
    const store = new UiStateStore({
      adapter: new MemoryPersistenceAdapter(),
      clock: new ManualClock(1_000),
    });
    const path = "/Users/someone/repos/service/notes.md";

    const result = await store.write(path, "expansion", "expansion", ["run-01"]);

    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.refusal.code).toBe("address-not-identifier-shaped");
    }
    expect(await store.readPartition(path)).toStrictEqual([]);
    await store.close();
  });

  it("refuses prose smuggled through an object KEY", async () => {
    const store = new UiStateStore({ adapter: new MemoryPersistenceAdapter() });

    const result = await store.write("session-1", "scroll", "scroll-position", {
      "note to self: fix this later": 12,
    });

    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.refusal.code).toBe("value-not-identifier-shaped");
    }
  });
});

describe("a read that failed is not a record that was never written", () => {
  it(
    "answers `failed` where the record is " + "unreachable and `absent` where it is not there",
    async () => {
      const adapter = new ReadFailurePersistenceAdapter();
      const store = new UiStateStore({ adapter, clock: new ManualClock(1_000) });
      expect((await store.write("session-1", "expansion", "expansion", ["run-01"])).outcome).toBe(
        "written",
      );

      // The record is there and the adapter cannot say so: one answer for "unreachable",
      // another for "not there".
      expect((await store.readOutcome("session-1", "expansion")).outcome).toBe("failed");
      adapter.stopFailingReads();
      expect((await store.readOutcome("session-1", "expansion")).outcome).toBe("present");
      expect((await store.readOutcome("session-1", "never-written")).outcome).toBe("absent");
    },
  );
});
