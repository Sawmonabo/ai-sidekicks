// The three answers a preference carrier can give, and what each one leaves on screen.
//
// The interesting one is the middle arm: a carrier that was never asked is not a
// carrier that refused, and collapsing the two would either lose a person's choice
// or claim a refusal nobody made. Both other arms are asserted beside it so the
// distinction is proved rather than described.

import { describe, expect, it, vi } from "vitest";

import {
  SHELL_PREFERENCE_DEFAULTS,
  ShellPreferenceStore,
  effectivePreference,
} from "./shell-preferences.js";
import type { ConsoleBridge } from "../../bridge/index.js";

/** The port's refusal, in the two fields the store reads off it. */
const CARRIER_UNAVAILABLE = {
  status: "unavailable",
  code: "wire-unregistered",
  detail: "Not checked — the shell-config preference carrier is not registered yet.",
  origin: "growth-port",
};

/**
 * A bridge whose growth port answers however the case needs.
 *
 * A stub COLLABORATOR, not a stand-in for the store: every assertion below drives
 * the real `ShellPreferenceStore`, and what is faked is the wire it talks to, which
 * is the only part a unit test cannot have.
 */
function bridgeWith(port: {
  readonly shellConfigRead: () => Promise<unknown>;
  readonly shellConfigWrite: (request: { key: string; enabled: boolean }) => Promise<unknown>;
}): ConsoleBridge {
  return { growth: port } as unknown as ConsoleBridge;
}

const refusingCarrier = {
  shellConfigRead: () => Promise.resolve(CARRIER_UNAVAILABLE),
  shellConfigWrite: () => Promise.resolve(CARRIER_UNAVAILABLE),
};

describe("shell preferences — a carrier nobody asked", () => {
  it("reads as unavailable rather than as an empty preference set", async () => {
    const store = new ShellPreferenceStore(bridgeWith(refusingCarrier));
    store.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(store.snapshot().reading.kind).toBe("unavailable");
  });

  it("holds a choice the carrier never took, and says which window holds it", async () => {
    const store = new ShellPreferenceStore(bridgeWith(refusingCarrier));
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
    const store = new ShellPreferenceStore(bridgeWith(refusingCarrier));
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
      bridgeWith({
        shellConfigRead: () =>
          Promise.resolve({ status: "served", value: { "diagnostics.crashReports": false } }),
        shellConfigWrite: () => Promise.resolve({ status: "served", value: undefined }),
      }),
    );
    store.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(effectivePreference(store.snapshot(), "diagnostics.crashReports")).toBe(false);
  });

  it("applies a served write into the carrier's own record, holding nothing locally", async () => {
    const write = vi.fn(() => Promise.resolve({ status: "served", value: undefined }));
    const store = new ShellPreferenceStore(
      bridgeWith({
        shellConfigRead: () => Promise.resolve({ status: "served", value: {} }),
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
      bridgeWith({
        shellConfigRead: () =>
          Promise.resolve({ status: "served", value: { "updates.automatic": true } }),
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
      bridgeWith({
        shellConfigRead: () => Promise.resolve({ status: "served", value: {} }),
        shellConfigWrite: () => Promise.reject(new Error("no")),
      }),
    );
    await store.choose("updates.automatic", false);
    expect(store.snapshot().heldLocally).toStrictEqual({});
  });
});
