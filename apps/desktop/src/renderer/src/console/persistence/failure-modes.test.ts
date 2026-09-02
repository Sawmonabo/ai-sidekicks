// Failure modes of the durable tier.
//
// The class splits in two, and both halves are about a write that must not happen
// quietly. The first is the store the console cannot OPEN — a renderer scheme the
// browser refuses to give storage to, a database a newer build already wrote, a
// runtime with no IndexedDB at all, a quota that is already full. The second is the
// store the console must not WRITE INTO — a value class outside the closed set,
// participant-authored prose inside an allowed class, prose smuggled through an
// object key.
//
// Both live in `persistence/` because both are about the same chokepoint. Opening
// decides whether `UiStateStore` has a durable adapter behind it and what it
// DISCLOSES when it does not; the value-class guard decides what may cross it at
// all. A surface that could reach an adapter directly would bypass both, which is
// why the family has one door and why these cases belong behind it.
//
// Where a mode has a "the code should have refused" shape, the assertion is on the
// REFUSAL — its code, its detail, the tripwire it fired — rather than merely on the
// absence of a crash. Falling back to memory without saying so, and storing prose
// because nothing looked at it, are both silent-corruption bugs that a
// does-not-throw assertion passes over.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { consoleTripwires } from "../core/index.js";
import { classifyOpenFailure, openConsoleDatabase } from "./indexeddb-adapter.js";
import { MemoryPersistenceAdapter } from "./memory-adapter.js";
import { UiStateStore } from "./ui-state-store.js";

// Tripwires throw in development so a breach is impossible to ignore. Under test
// they are RECORDED instead, because the point of these cases is to assert that the
// breach was detected and described — a throw would only prove it was noticed.
beforeEach(() => {
  consoleTripwires.setThrowOnReport(false);
  consoleTripwires.reset();
});

describe("failure matrix — the durable store cannot be opened", () => {
  // Every case that installs one removes it again, so a file that runs after this
  // one sees the host it actually has rather than this file's stand-in.
  afterEach(() => {
    Reflect.deleteProperty(globalThis, "indexedDB");
  });

  it("classifies a refused open as the unprivileged-scheme case", () => {
    expect(classifyOpenFailure(named("SecurityError"))).toBe("open-refused");
    expect(classifyOpenFailure(named("InvalidStateError"))).toBe("open-refused");
    expect(classifyOpenFailure(named("UnknownError"))).toBe("open-refused");
  });

  it("classifies a version mismatch separately, so nothing is deleted to recover", () => {
    // A newer build already wrote this database. Falling back to memory keeps its
    // bytes intact; treating it as a generic failure and clearing the store would
    // destroy a future version's state.
    expect(classifyOpenFailure(named("VersionError"))).toBe("version-mismatch");
  });

  it("reports the missing global rather than throwing when the host has no IndexedDB", async () => {
    // The production shape: nothing is injected, and this host genuinely has no
    // factory (happy-dom defines none, own or inherited).
    const outcome = await openConsoleDatabase({});
    expect(outcome).toStrictEqual({ outcome: "unavailable", reason: "no-indexeddb-global" });
  });

  it("honours an EXPLICITLY absent factory on a host that has an ambient one", async () => {
    // The arm a `??` coalesce cannot reach. On a host that HAS a global — every
    // browser, and this case — `options.indexedDbFactory ?? indexedDB` substitutes
    // the ambient factory for the caller's explicit `undefined` and opens durable
    // storage instead of reporting that there is none. The recorder is what makes
    // that observable: the claim is not merely which reason came back, it is that
    // the ambient factory was never touched.
    const ambientFactory = new RecordingIndexedDbFactory();
    installAmbientIndexedDb(ambientFactory);

    const outcome = await openConsoleDatabase({ indexedDbFactory: undefined });

    expect(outcome).toStrictEqual({ outcome: "unavailable", reason: "no-indexeddb-global" });
    expect(ambientFactory.openCallCount).toBe(0);
  });

  it("negative control: an OMITTED factory still opens the ambient one", async () => {
    // The gate is the property's presence, not its value, so the other half has to
    // hold too — otherwise "explicitly absent" would just be "never open anything"
    // and the case above would pass against an adapter that no longer persists.
    const ambientFactory = new RecordingIndexedDbFactory();
    installAmbientIndexedDb(ambientFactory);

    const outcome = await openConsoleDatabase({});

    expect(outcome.outcome).toBe("unavailable");
    expect(ambientFactory.openCallCount).toBe(1);
  });

  it("falls back to memory and SAYS SO when the open is refused (I-023-11)", async () => {
    // The refusing factory is installed as the AMBIENT global as well as passed,
    // because `idb`'s `openDB` reads the global rather than a parameter — a
    // factory handed only to the option would never have its `open` called, and
    // the refusal reaching the classifier would be a `ReferenceError` from a
    // missing global rather than the `SecurityError` this case is named for.
    const refusingFactory = new RecordingIndexedDbFactory();
    installAmbientIndexedDb(refusingFactory);

    const outcome = await openConsoleDatabase({
      indexedDbFactory: refusingFactory.asIndexedDbFactory,
    });
    expect(outcome.outcome).toBe("unavailable");
    if (outcome.outcome === "unavailable") {
      expect(outcome.reason).toBe("open-refused");
    }
    expect(refusingFactory.openCallCount).toBe(1);

    const store = new UiStateStore({
      adapter: new MemoryPersistenceAdapter({ unavailableReason: "open-refused" }),
    });
    const health = await store.health();
    expect(health.durable).toBe(false);
    expect(health.description).toContain("not survive a restart");
    // The disclosure names the cause. "Storage unavailable" alone would leave an
    // operator with nothing to check.
    expect(health.description).toContain("renderer scheme");
  });

  it("trims once and then surfaces the refusal when the quota is exhausted", async () => {
    // The ceiling admits the first record (43 bytes by the adapter's estimator:
    // partition + key + value class + serialised value) and cannot admit the
    // second (88) even with the first evicted. That is the case worth pinning:
    // the trim runs, frees a whole partition, and the write STILL fails — so the
    // refusal reaches the caller instead of being retried forever.
    const store = new UiStateStore({
      adapter: new MemoryPersistenceAdapter({ capacityBytes: 50 }),
      sessionPartitionCap: 1,
    });

    const first = await store.write("session-1", "layout", "layout", { deck: { width: 100 } });
    expect(first.outcome).toBe("written");

    const overflowing = await store.write("session-2", "layout", "layout", {
      deck: { width: 100, height: 200, ratio: 3, offset: 4, gutter: 5 },
    });

    expect(overflowing.outcome).toBe("refused");
    if (overflowing.outcome === "refused") {
      expect(overflowing.refusal.code).toBe("quota-exceeded");
    }
    const health = await store.health();
    expect(health.trimCount).toBeGreaterThan(0);
    expect(health.refusalCounts["quota-exceeded"]).toBe(1);
  });
});

describe("failure matrix — the persistence chokepoint is handed something it may not keep", () => {
  it("refuses an unknown value class and names the closed set", async () => {
    const store = new UiStateStore({ adapter: new MemoryPersistenceAdapter() });

    // Deliberately cast: the compiler already refuses this, and the runtime guard
    // has to hold anyway for anything that arrives across a boundary the compiler
    // does not see.
    const result = await store.write("session-1", "k", "composer-draft" as never, "hello");

    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.refusal.code).toBe("value-class-unknown");
      expect(result.refusal.detail).toContain("layout");
    }
    expect(consoleTripwires.firingCount("persistence-value-class")).toBe(1);
  });

  it("refuses participant-authored prose inside an allowed class", async () => {
    const store = new UiStateStore({ adapter: new MemoryPersistenceAdapter() });

    const result = await store.write("session-1", "selection", "selection", {
      composer: "Can you take another look at the rate-limit wiring before I merge it?",
    });

    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.refusal.code).toBe("value-not-identifier-shaped");
    }
    expect(consoleTripwires.firingCount("persistence-value-class")).toBe(1);
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

  it("accepts the identifier-shaped values the classes are for", async () => {
    const store = new UiStateStore({ adapter: new MemoryPersistenceAdapter() });

    await expect(
      store.write("session-1", "expansion", "expansion", ["run-01", "run-02"]),
    ).resolves.toStrictEqual({ outcome: "written" });
    await expect(store.writeGlobal("scheme", "scheme", "dark")).resolves.toStrictEqual({
      outcome: "written",
    });
    expect(consoleTripwires.totalFiringCount).toBe(0);
  });
});

/** An error carrying only the `name` the classifier keys on. */
function named(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

/**
 * An ambient `indexedDB` that RECORDS being reached, and refuses if it is.
 *
 * Without one, the missing-global arm is unfalsifiable: on a host with no factory
 * at all — which happy-dom is — coalescing the option's value and checking the
 * property's presence agree, because the fallback is `undefined` either way. So
 * the cases install a factory the adapter must not touch, and assert on whether it
 * did. Refusing rather than returning a request is deliberate: a case that reached
 * this by mistake fails on its own assertion instead of on a half-built database.
 */
class RecordingIndexedDbFactory {
  #openCallCount = 0;

  public get openCallCount(): number {
    return this.#openCallCount;
  }

  /** Matches `IDBFactory.open` in name only; it counts the call and never returns. */
  public open(): never {
    this.#openCallCount += 1;
    throw named("SecurityError");
  }

  /**
   * The same object, typed as what `openConsoleDatabase` gates on.
   *
   * A cast rather than a full `IDBFactory`: `open` is the only member either the
   * gate or `idb` reaches, and stubbing `cmp` / `databases` / `deleteDatabase`
   * would be three members no case drives and a reader would have to check.
   */
  public get asIndexedDbFactory(): IDBFactory {
    return this as unknown as IDBFactory;
  }
}

/**
 * Give this host an ambient factory, as a browser has and this environment does
 * not. `configurable` so the `afterEach` can take it away again.
 */
function installAmbientIndexedDb(factory: RecordingIndexedDbFactory): void {
  Object.defineProperty(globalThis, "indexedDB", {
    value: factory.asIndexedDbFactory,
    configurable: true,
    writable: true,
  });
}
