// The "did the preload run" probe over the installed bridge. A window whose preload did not run
// must read as absent, so the provider shows a window to reopen rather than an app calling
// methods on a namespace that is not there.
import { afterEach, describe, expect, it } from "vitest";

import { createStubBridge } from "#shared/preload-api.js";
import type { PlatformBridge } from "./bridge.js";
import { FIXTURE_APP_META, FIXTURE_WINDOW_ID } from "./bridge.fixture.js";
import { createLiveBridge, readInstalledBridge } from "./live-bridge.js";

/**
 * Installs a bridge the way the preload does and returns the live `PlatformBridge` the window
 * would resolve. It goes through `readInstalledBridge` so the "did the preload run" probe is on
 * the path this test drives.
 */
function resolveLiveBridgeFrom(installed: unknown): PlatformBridge | undefined {
  (globalThis as { desktopBridge?: unknown }).desktopBridge = installed;
  const read = readInstalledBridge();
  return read === undefined ? undefined : createLiveBridge(read);
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "desktopBridge");
});

describe("readInstalledBridge — the preload probe", () => {
  it("reads a missing, partial or array bridge as absent, and a whole one as present", () => {
    // "The preload did not run" is a window to reopen and "the bridges diverged" is a defect to
    // fix; conflating them sends a person to the wrong one.
    expect(resolveLiveBridgeFrom(undefined)).toBeUndefined();
    expect(resolveLiveBridgeFrom({ daemon: {} })).toBeUndefined();

    // A hand-written `typeof === "object"` probe admits an array, so a namespace that arrived as
    // one passed and the app called methods on it. `isWireRecord` rejects it.
    const installed = createStubBridge(FIXTURE_APP_META, FIXTURE_WINDOW_ID);
    const arrayValued = { ...installed, daemon: [] };

    expect(resolveLiveBridgeFrom(arrayValued)).toBeUndefined();
    // The same object with that namespace intact is admitted, so the case above fails for the
    // array and not for how the literal was built.
    expect(resolveLiveBridgeFrom({ ...installed })).toBeDefined();
  });
});
