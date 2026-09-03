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
} from "../../bridge/fixture-bridge-overrides.test-support.js";
import {
  SHELL_PREFERENCE_DEFAULTS,
  ShellPreferenceStore,
  consoleShellPreferences,
  effectivePreference,
} from "./shell-preferences.js";
import type { GrowthPort } from "../../bridge/index.js";

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

describe("shell preferences — the store belongs to the window, not to a page", () => {
  it("hands one bridge the same store however many pages ask", async () => {
    // The defect this is the negative control for: a store built per calling
    // component died with the page, so a choice made on the updates section was
    // gone by the time the notifications section asked for it — while the row said
    // it was held for the window.
    const bridge = fixtureBridgeWithGrowth(SCENARIO, REFUSING_CARRIER);
    const firstPagesStore = consoleShellPreferences.acquire(bridge);
    await firstPagesStore.choose("updates.automatic", false);

    const secondPagesStore = consoleShellPreferences.acquire(bridge);

    expect(secondPagesStore).toBe(firstPagesStore);
    expect(effectivePreference(secondPagesStore.snapshot(), "updates.automatic")).toBe(false);
    expect(Object.hasOwn(secondPagesStore.snapshot().heldLocally, "updates.automatic")).toBe(true);
  });

  it("gives two bridges two stores, and disposes the one it superseded exactly once", async () => {
    // The fixture's scenario swap replaces the bridge. A store built against the old
    // one would keep answering with the old one's reading, so it is superseded
    // rather than reused — and it is dropped, so asking again mints a live store
    // rather than returning a terminal one whose replies write nothing.
    const firstBridge = fixtureBridgeWithGrowth(SCENARIO, REFUSING_CARRIER);
    const secondBridge = fixtureBridgeWithGrowth(SCENARIO, REFUSING_CARRIER);
    const firstStore = consoleShellPreferences.acquire(firstBridge);
    // Counted rather than read off the flag: `dispose` is idempotent, so a holder
    // that disposed the same store on every ask would leave `isDisposed` looking
    // exactly as it does here.
    const disposals = vi.spyOn(firstStore, "dispose");

    const secondStore = consoleShellPreferences.acquire(secondBridge);
    consoleShellPreferences.acquire(secondBridge);

    expect(secondStore).not.toBe(firstStore);
    expect(disposals).toHaveBeenCalledTimes(1);
    expect(firstStore.isDisposed).toBe(true);
    expect(secondStore.isDisposed).toBe(false);

    const rebuilt = consoleShellPreferences.acquire(firstBridge);
    expect(rebuilt).not.toBe(firstStore);
    expect(rebuilt.isDisposed).toBe(false);
    await rebuilt.choose("updates.automatic", false);
    expect(effectivePreference(rebuilt.snapshot(), "updates.automatic")).toBe(false);
  });

  it("negative control: a superseded store's own reply writes nothing", async () => {
    // Without this, the disposal above would be a flag nobody reads — and a reply
    // landing after the swap would publish the old bridge's answer over the new
    // bridge's store, which is the state a person cannot debug.
    const firstBridge = fixtureBridgeWithGrowth(SCENARIO, REFUSING_CARRIER);
    const firstStore = consoleShellPreferences.acquire(firstBridge);
    consoleShellPreferences.acquire(fixtureBridgeWithGrowth(SCENARIO, REFUSING_CARRIER));

    await firstStore.choose("updates.automatic", false);

    expect(firstStore.snapshot().heldLocally).toStrictEqual({});
    expect(effectivePreference(firstStore.snapshot(), "updates.automatic")).toBe(
      SHELL_PREFERENCE_DEFAULTS["updates.automatic"],
    );
  });
});

describe("shell preferences — the lookup a render body performs", () => {
  it("answers the live store for the bridge it is on", () => {
    const bridge = fixtureBridgeWithGrowth(SCENARIO, REFUSING_CARRIER);
    const acquired = consoleShellPreferences.acquire(bridge);

    expect(consoleShellPreferences.storeIfCurrent(bridge)).toBe(acquired);
  });

  it("answers nothing for a bridge the holder is not on, and disposes nothing", () => {
    // The purity claim, which is the whole of the fix: this is the call a render
    // body makes, and a render body may run for a pass React replays or abandons.
    // The acquiring form disposed the committed store and installed a successor
    // right here, so an abandoned render left the mounted pages on a disposed store.
    const committedBridge = fixtureBridgeWithGrowth(SCENARIO, REFUSING_CARRIER);
    const committed = consoleShellPreferences.acquire(committedBridge);
    const replacementBridge = fixtureBridgeWithGrowth(SCENARIO, REFUSING_CARRIER);

    expect(consoleShellPreferences.storeIfCurrent(replacementBridge)).toBeUndefined();
    expect(committed.isDisposed).toBe(false);
    expect(consoleShellPreferences.storeIfCurrent(committedBridge)).toBe(committed);
  });

  it("negative control: acquiring the replacement is what disposes, so the two differ", () => {
    // Without this, the case above would pass over a holder that never disposed
    // anything at all — and the lookup would be pure because nothing was.
    const committedBridge = fixtureBridgeWithGrowth(SCENARIO, REFUSING_CARRIER);
    const committed = consoleShellPreferences.acquire(committedBridge);

    consoleShellPreferences.acquire(fixtureBridgeWithGrowth(SCENARIO, REFUSING_CARRIER));

    expect(committed.isDisposed).toBe(true);
  });
});
