// What a preference carrier's answers leave on screen: the stored value over the default,
// an accepted write applied into the carrier's own record, and the races between an
// opening read and a choice, and between keys.

import { describe, expect, it, vi } from "vitest";

import { createFixtureBridge } from "@renderer/console/bridge/fixture/call-plane/bridge.js";
import { unscriptedScenario } from "@renderer/console/bridge/fixture/call-plane/bridge.test-support.js";
import { settleScheduledRead } from "@test/helpers/scheduled-read.js";
import { MachineSettingsStore, type ShellPreferenceCarrier } from "./machine-settings-store.js";
import { effectivePreference } from "./machine-settings-snapshot.js";

/** The bridge the store takes its clock from; nothing is scripted and nothing needs to be. */
function fixtureBridge(): ReturnType<typeof createFixtureBridge> {
  return createFixtureBridge({ scenario: unscriptedScenario("shell-preferences-test") });
}

/** A carrier holding `values`, whose write is accepted. */
function carrierHolding(
  values: Readonly<Record<string, boolean>>,
  write: ShellPreferenceCarrier["write"] = async () => await Promise.resolve(undefined),
): ShellPreferenceCarrier {
  return { read: async () => await Promise.resolve(values), write };
}

describe("shell preferences — a carrier that answers", () => {
  it("prefers the carrier's stored value over the default", async () => {
    const bridge = fixtureBridge();
    const store = new MachineSettingsStore(
      bridge,
      carrierHolding({ "diagnostics.crashReports": false }),
    );
    store.start();
    await settleScheduledRead(bridge);
    expect(effectivePreference(store.snapshot(), "diagnostics.crashReports")).toBe(false);
  });

  it("applies an accepted write into the carrier's own record", async () => {
    const write = vi.fn(async () => await Promise.resolve(undefined));
    const bridge = fixtureBridge();
    const store = new MachineSettingsStore(bridge, carrierHolding({}, write));
    store.start();
    await settleScheduledRead(bridge);
    await store.choose("notifications.osToastsMuted", true);
    expect(write).toHaveBeenCalledWith({ key: "notifications.osToastsMuted", enabled: true });
    expect(effectivePreference(store.snapshot(), "notifications.osToastsMuted")).toBe(true);
  });

  it("negative control: a rejected write leaves the stored value and stops pending", async () => {
    const bridge = fixtureBridge();
    const store = new MachineSettingsStore(
      bridge,
      carrierHolding({ "updates.automatic": true }, () => Promise.reject(new Error("read-only"))),
    );
    store.start();
    await settleScheduledRead(bridge);
    await expect(store.choose("updates.automatic", false)).rejects.toThrow("read-only");
    expect(effectivePreference(store.snapshot(), "updates.automatic")).toBe(true);
    expect(store.snapshot().pendingKeys.size).toBe(0);
  });
});

/**
 * A carrier read this test settles by hand.
 *
 * The whole subject below is the ORDER two settlements land in, and the shipped
 * builders resolve immediately, so a case built from them could never put a choice
 * between a read's start and its answer.
 */
/** One carrier read, resolved when a case decides to resolve it. */
function heldRead(): {
  readonly answer: ShellPreferenceCarrier["read"];
  readonly serve: (values: Readonly<Record<string, boolean>>) => void;
} {
  let settle: (values: Readonly<Record<string, boolean>>) => void = () => undefined;
  const held = new Promise<Readonly<Record<string, boolean>>>((resolve) => {
    settle = resolve;
  });
  return {
    answer: () => held,
    serve: (values) => {
      settle(values);
    },
  };
}

describe("shell preferences — the opening read never lands on a newer choice", () => {
  it("keeps a value the carrier accepted while the opening read was still in flight", async () => {
    // The defect: the write settled first and applied the accepted value, and the
    // read's continuation then replaced the whole record with the snapshot from
    // before the choice — so the switch reverted moments after it was saved.
    const opening = heldRead();
    const bridge = fixtureBridge();
    const store = new MachineSettingsStore(bridge, {
      read: opening.answer,
      write: async () => await Promise.resolve(undefined),
    });
    store.start();
    await settleScheduledRead(bridge);

    await store.choose("updates.automatic", false);
    opening.serve({ "updates.automatic": true });
    await Promise.resolve();
    await Promise.resolve();

    expect(effectivePreference(store.snapshot(), "updates.automatic")).toBe(false);
  });

  it("installs a read that settled with no choice against it", async () => {
    const opening = heldRead();
    const bridge = fixtureBridge();
    const store = new MachineSettingsStore(bridge, {
      read: opening.answer,
      write: async () => await Promise.resolve(undefined),
    });
    store.start();
    await settleScheduledRead(bridge);

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
    const bridge = fixtureBridge();
    const store = new MachineSettingsStore(bridge, {
      read: opening.answer,
      write: async () => await Promise.resolve(undefined),
    });
    store.start();
    await settleScheduledRead(bridge);

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
  readonly answer: ShellPreferenceCarrier["write"];
  readonly serve: (key: string) => void;
} {
  const settlersByKey = new Map<string, (() => void)[]>();
  return {
    answer: async ({ key }) =>
      await new Promise((resolve) => {
        settlersByKey.set(key, [
          ...(settlersByKey.get(key) ?? []),
          () => {
            resolve(undefined);
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
    const store = new MachineSettingsStore(fixtureBridge(), {
      read: async () => await Promise.resolve({}),
      write: write.answer,
    });
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
    const store = new MachineSettingsStore(fixtureBridge(), {
      read: async () => await Promise.resolve({}),
      write: write.answer,
    });
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
    const store = new MachineSettingsStore(fixtureBridge(), {
      read: async () => await Promise.resolve({}),
      write: write.answer,
    });
    const first = store.choose("updates.automatic", false);
    const second = store.choose("updates.automatic", true);

    // Both calls are released together, so the older continuation genuinely runs and
    // is genuinely discarded rather than merely never reaching its settlement.
    write.serve("updates.automatic");
    await Promise.all([first, second]);

    expect(effectivePreference(store.snapshot(), "updates.automatic")).toBe(true);
    expect(store.snapshot().pendingKeys).toStrictEqual(new Set());
  });

  it("lands nothing from an older write that is answered after a newer one for the same key", async () => {
    // The two writes are answered newest first, so the older continuation runs AFTER the
    // newer one has settled and would put its own value over the one chosen later.
    const answers: (() => void)[] = [];
    const store = new MachineSettingsStore(fixtureBridge(), {
      read: async () => await Promise.resolve({}),
      write: async () =>
        await new Promise<void>((resolve) => {
          answers.push(resolve);
        }),
    });
    const older = store.choose("updates.automatic", false);
    const newer = store.choose("updates.automatic", true);

    answers[1]?.();
    await newer;
    answers[0]?.();
    await older;

    expect(effectivePreference(store.snapshot(), "updates.automatic")).toBe(true);
    expect(store.snapshot().pendingKeys).toStrictEqual(new Set());
  });
});
