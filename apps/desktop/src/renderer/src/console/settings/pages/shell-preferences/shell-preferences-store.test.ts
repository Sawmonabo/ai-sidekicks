// The three answers a preference carrier can give, and what each one leaves on screen.
//
// The interesting one is the middle arm: a carrier that was never asked is not a
// carrier that refused, and collapsing the two would either lose a person's choice
// or claim a refusal nobody made. Both other arms are asserted beside it so the
// distinction is proved rather than described.

import { describe, expect, it, vi } from "vitest";

import {
  fixtureBridgeWithGrowth,
  growthRefusing,
  growthServing,
  unscriptedScenario,
} from "../../../bridge/fixture-bridge-overrides.test-support.js";
import { ShellPreferenceStore } from "./shell-preferences-store.js";
import { SHELL_PREFERENCE_DEFAULTS, effectivePreference } from "./shell-preference-snapshot.js";
import type { GrowthPort } from "../../../bridge/index.js";

/**
 * The scenario behind every bridge below.
 *
 * Nothing is scripted, and nothing needs to be: the store reaches the growth port
 * alone, and each case replaces exactly the two operations it exercises. What the
 * scenario buys is that every OTHER namespace is the shipped fixture's rather than a
 * cast object literal, so a store that started reading a third seam would find a real
 * answer rather than `undefined`.
 */
const SCENARIO = unscriptedScenario("shell-preferences-test");

/**
 * The carrier nobody has registered: both operations answer the port's own refusal.
 *
 * A stub COLLABORATOR, not a stand-in for the store: every assertion below drives the
 * real `ShellPreferenceStore`, and what is replaced is the wire it talks to, which is
 * the only part a unit test cannot have. The refusal is built by the shipped
 * `growthUnavailable` rather than written out here, so what the store is asserted
 * against is what a release build actually returns.
 */
const REFUSING_CARRIER: Partial<GrowthPort> = {
  shellConfigRead: growthRefusing("shellConfigRead"),
  shellConfigWrite: growthRefusing("shellConfigWrite"),
};

describe("shell preferences — a carrier nobody asked", () => {
  it("reads as unavailable rather than as an empty preference set", async () => {
    const store = new ShellPreferenceStore(fixtureBridgeWithGrowth(SCENARIO, REFUSING_CARRIER));
    store.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(store.snapshot().reading.kind).toBe("unavailable");
  });

  it("holds a choice the carrier never took, and says which window holds it", async () => {
    const store = new ShellPreferenceStore(fixtureBridgeWithGrowth(SCENARIO, REFUSING_CARRIER));
    await store.choose("updates.automatic", false);
    const snapshot = store.snapshot();
    expect(effectivePreference(snapshot, "updates.automatic")).toBe(false);
    expect(Object.hasOwn(snapshot.heldLocally, "updates.automatic")).toBe(true);
    // Held is not refused: nothing was rejected, so nothing renders a code.
    expect(snapshot.refusalByKey).toStrictEqual({});
  });

  it("negative control: an untouched key answers its default, not the last choice", () => {
    // Without this, the case above would pass over a store that flipped every key
    // whenever any key was chosen.
    const store = new ShellPreferenceStore(fixtureBridgeWithGrowth(SCENARIO, REFUSING_CARRIER));
    expect(effectivePreference(store.snapshot(), "updates.automatic")).toBe(
      SHELL_PREFERENCE_DEFAULTS["updates.automatic"],
    );
    expect(effectivePreference(store.snapshot(), "notifications.osToastsMuted")).toBe(
      SHELL_PREFERENCE_DEFAULTS["notifications.osToastsMuted"],
    );
  });
});

describe("shell preferences — a carrier that answers", () => {
  it("prefers the carrier's stored value over the default", async () => {
    const store = new ShellPreferenceStore(
      fixtureBridgeWithGrowth(SCENARIO, {
        shellConfigRead: growthServing({ "diagnostics.crashReports": false }),
        shellConfigWrite: growthServing(undefined),
      }),
    );
    store.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(effectivePreference(store.snapshot(), "diagnostics.crashReports")).toBe(false);
  });

  it("applies a served write into the carrier's own record, holding nothing locally", async () => {
    const write = vi.fn(growthServing(undefined));
    const store = new ShellPreferenceStore(
      fixtureBridgeWithGrowth(SCENARIO, {
        shellConfigRead: growthServing({}),
        shellConfigWrite: write,
      }),
    );
    store.start();
    await Promise.resolve();
    await Promise.resolve();
    await store.choose("notifications.osToastsMuted", true);
    const snapshot = store.snapshot();
    expect(write).toHaveBeenCalledWith({ key: "notifications.osToastsMuted", enabled: true });
    expect(effectivePreference(snapshot, "notifications.osToastsMuted")).toBe(true);
    expect(snapshot.heldLocally).toStrictEqual({});
  });

  it("leaves the stored value and renders the code when a present carrier refuses", async () => {
    const store = new ShellPreferenceStore(
      fixtureBridgeWithGrowth(SCENARIO, {
        shellConfigRead: growthServing({ "updates.automatic": true }),
        shellConfigWrite: () => Promise.reject(new Error("the preference store is read-only")),
      }),
    );
    store.start();
    await Promise.resolve();
    await Promise.resolve();
    await store.choose("updates.automatic", false);
    const snapshot = store.snapshot();
    expect(effectivePreference(snapshot, "updates.automatic")).toBe(true);
    expect(snapshot.refusalByKey["updates.automatic"]?.detail).toBe(
      "the preference store is read-only",
    );
    // The dismiss a person presses on the notice clears exactly that key.
    store.dismiss("updates.automatic");
    expect(store.snapshot().refusalByKey).toStrictEqual({});
  });

  it("negative control: a refused write does not become a held local choice", async () => {
    // Without this, the case above would pass over a store that both refused AND
    // applied — which would show the new position beside the reason it was rejected.
    const store = new ShellPreferenceStore(
      fixtureBridgeWithGrowth(SCENARIO, {
        shellConfigRead: growthServing({}),
        shellConfigWrite: () => Promise.reject(new Error("no")),
      }),
    );
    await store.choose("updates.automatic", false);
    expect(store.snapshot().heldLocally).toStrictEqual({});
  });
});

/**
 * A rejection no bare `String(...)` can render.
 *
 * `Object.create(null)` has no prototype, so it carries no `toString`, no `valueOf`,
 * and no `Symbol.toPrimitive` — and ToPrimitive throws rather than answering. It is
 * built here rather than mocked because the value is the whole subject: what the
 * catch path has to survive is a rejection whose own rendering fails.
 */
function unrenderableRejection(): unknown {
  return Object.create(null) as unknown;
}

describe("shell preferences — a rejection the catch path cannot stringify", () => {
  it("clears the pending key and publishes the refusal anyway", async () => {
    // The defect: composing the sentence threw INSIDE the catch that exists to
    // publish the failure, so `choose` rejected with the key still pending — the
    // toggle spun for the life of the window with nothing on screen saying why. On
    // the partial normalizer this case does not merely assert wrongly, it throws.
    const store = new ShellPreferenceStore(
      fixtureBridgeWithGrowth(SCENARIO, {
        shellConfigRead: growthServing({}),
        shellConfigWrite: () => Promise.reject(unrenderableRejection()),
      }),
    );

    await store.choose("updates.automatic", false);

    const snapshot = store.snapshot();
    expect(snapshot.pendingKeys.size).toBe(0);
    expect(snapshot.refusalByKey["updates.automatic"]?.code).toBe("preference-write-failed");
    expect(typeof snapshot.refusalByKey["updates.automatic"]?.detail).toBe("string");
  });

  it("negative control: an ordinary rejection still renders its own words", async () => {
    // Without this, the case above would pass over a normalizer that answered the
    // same placeholder for every rejection — which would hide every reason a
    // carrier ever gives behind the one sentence written for the value that has
    // none.
    const store = new ShellPreferenceStore(
      fixtureBridgeWithGrowth(SCENARIO, {
        shellConfigRead: growthServing({}),
        shellConfigWrite: () => Promise.reject(new Error("the carrier is read-only")),
      }),
    );

    await store.choose("updates.automatic", false);

    expect(store.snapshot().refusalByKey["updates.automatic"]?.detail).toBe(
      "the carrier is read-only",
    );
  });
});

/**
 * A carrier read this test settles by hand.
 *
 * The whole subject below is the ORDER two settlements land in, and the shipped
 * builders resolve immediately, so a case built from them could never put a choice
 * between a read's start and its answer.
 */
type ServedShellConfig = Extract<
  Awaited<ReturnType<GrowthPort["shellConfigRead"]>>,
  { status: "served" }
>;

/** The served arm of one carrier read, resolved when a case decides to resolve it. */
function heldRead(): {
  readonly answer: GrowthPort["shellConfigRead"];
  readonly serve: (values: Readonly<Record<string, boolean>>) => void;
} {
  let settle: (outcome: ServedShellConfig) => void = () => undefined;
  const held = new Promise<ServedShellConfig>((resolve) => {
    settle = resolve;
  });
  return {
    answer: () => held,
    serve: (values) => {
      settle({ status: "served", value: values });
    },
  };
}

describe("shell preferences — the opening read never lands on a newer choice", () => {
  it("keeps a value the carrier accepted while the opening read was still in flight", async () => {
    // The defect: the write settled first and applied the accepted value, and the
    // read's continuation then replaced the whole record with the snapshot from
    // before the choice — so the switch reverted moments after it was saved.
    const opening = heldRead();
    const store = new ShellPreferenceStore(
      fixtureBridgeWithGrowth(SCENARIO, {
        shellConfigRead: opening.answer,
        shellConfigWrite: growthServing(undefined),
      }),
    );
    store.start();

    await store.choose("updates.automatic", false);
    opening.serve({ "updates.automatic": true });
    await Promise.resolve();
    await Promise.resolve();

    expect(effectivePreference(store.snapshot(), "updates.automatic")).toBe(false);
  });

  it("installs a read that settled with no choice against it", async () => {
    const opening = heldRead();
    const store = new ShellPreferenceStore(
      fixtureBridgeWithGrowth(SCENARIO, {
        shellConfigRead: opening.answer,
        shellConfigWrite: growthServing(undefined),
      }),
    );
    store.start();

    opening.serve({ "updates.automatic": false });
    await Promise.resolve();
    await Promise.resolve();

    expect(store.snapshot().reading.kind).toBe("read");
    expect(effectivePreference(store.snapshot(), "updates.automatic")).toBe(false);
  });

  it("negative control: the discard is scoped to the read a choice raced", async () => {
    // Without this, the first case would pass over a store that discarded EVERY
    // read — including one that settled before anybody chose — which would make the
    // carrier's record unreachable rather than merely superseded.
    const opening = heldRead();
    const store = new ShellPreferenceStore(
      fixtureBridgeWithGrowth(SCENARIO, {
        shellConfigRead: opening.answer,
        shellConfigWrite: growthServing(undefined),
      }),
    );
    store.start();

    opening.serve({ "diagnostics.crashReports": false });
    await Promise.resolve();
    await Promise.resolve();
    await store.choose("updates.automatic", false);

    // The read landed first, so its record stands beside the later choice.
    expect(effectivePreference(store.snapshot(), "diagnostics.crashReports")).toBe(false);
    expect(effectivePreference(store.snapshot(), "updates.automatic")).toBe(false);
  });
});

/**
 * A carrier write this test settles by hand, so several can be in flight at once.
 *
 * Settlers are held per key AS A LIST, because the case that matters most has two
 * calls outstanding for ONE key: serving that key releases both continuations, which
 * is what lets the supersession rule be observed rather than assumed.
 */
function heldWrite(): {
  readonly answer: GrowthPort["shellConfigWrite"];
  readonly serve: (key: string) => void;
} {
  const settlersByKey = new Map<string, (() => void)[]>();
  return {
    answer: async ({ key }) =>
      await new Promise((resolve) => {
        settlersByKey.set(key, [
          ...(settlersByKey.get(key) ?? []),
          () => {
            resolve({ status: "served", value: undefined });
          },
        ]);
      }),
    serve: (key) => {
      const settlers = settlersByKey.get(key) ?? [];
      expect(settlers.length).toBeGreaterThan(0);
      settlersByKey.delete(key);
      for (const settle of settlers) {
        settle();
      }
    },
  };
}

describe("shell preferences — one key's write never discards another's", () => {
  it("settles both keys when two writes are in flight together", async () => {
    // The defect: the generation was shared across keys, so choosing B superseded
    // A's round and A's accepted settlement was discarded. `shellConfigWrite` takes
    // one key and leaves the others alone, so the two acts are independent — and
    // this store reads once and never refreshes, so the window showed A's old value
    // for the rest of its life.
    const write = heldWrite();
    const store = new ShellPreferenceStore(
      fixtureBridgeWithGrowth(SCENARIO, {
        shellConfigRead: growthServing({}),
        shellConfigWrite: write.answer,
      }),
    );
    const chosenA = store.choose("updates.automatic", false);
    const chosenB = store.choose("diagnostics.crashReports", false);
    expect(store.snapshot().pendingKeys).toStrictEqual(
      new Set(["updates.automatic", "diagnostics.crashReports"]),
    );

    write.serve("updates.automatic");
    write.serve("diagnostics.crashReports");
    await Promise.all([chosenA, chosenB]);

    const snapshot = store.snapshot();
    expect(effectivePreference(snapshot, "updates.automatic")).toBe(false);
    expect(effectivePreference(snapshot, "diagnostics.crashReports")).toBe(false);
    expect(snapshot.pendingKeys).toStrictEqual(new Set());
  });

  it("clears only the settled key's spinner, not every key writing", async () => {
    const write = heldWrite();
    const store = new ShellPreferenceStore(
      fixtureBridgeWithGrowth(SCENARIO, {
        shellConfigRead: growthServing({}),
        shellConfigWrite: write.answer,
      }),
    );
    const chosenA = store.choose("updates.automatic", false);
    const chosenB = store.choose("diagnostics.crashReports", false);

    write.serve("updates.automatic");
    await chosenA;

    // B's write is still outstanding, and a row that stopped saying so would offer
    // a control whose previous press has not landed.
    expect(store.snapshot().pendingKeys).toStrictEqual(new Set(["diagnostics.crashReports"]));
    write.serve("diagnostics.crashReports");
    await chosenB;
  });

  it("negative control: a newer choice for the SAME key still discards the older one", async () => {
    // Without this, the cases above would pass over a store that had stopped
    // superseding at all — which would let a stale reply for one key land over the
    // value a person chose for it a moment later.
    const write = heldWrite();
    const store = new ShellPreferenceStore(
      fixtureBridgeWithGrowth(SCENARIO, {
        shellConfigRead: growthServing({}),
        shellConfigWrite: write.answer,
      }),
    );
    const first = store.choose("updates.automatic", false);
    const second = store.choose("updates.automatic", true);

    // Both calls are released together, so the older continuation genuinely runs and
    // is genuinely discarded rather than merely never reaching its settlement.
    write.serve("updates.automatic");
    await Promise.all([first, second]);

    expect(effectivePreference(store.snapshot(), "updates.automatic")).toBe(true);
    expect(store.snapshot().pendingKeys).toStrictEqual(new Set());
  });
});
