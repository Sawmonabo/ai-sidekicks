// The fixture bridge is shape-identical to the live `PlatformBridge`, namespace for namespace.
// Types cover the fixture, but the live side is installed by a preload across `contextBridge`, so
// the shapes are read at runtime from the two real bridges (the live one built as the preload
// builds it, the fixture by its own factory) and compared. Nothing is hand-listed: the only
// listing is `bridge-shape.ts`'s namespace table, keyed by `keyof PreloadApi`, so it cannot go
// stale.
import { afterEach, describe, expect, it } from "vitest";

import { createStubBridge, type PreloadApi } from "@shared/preload-api.js";
import {
  DESKTOP_BRIDGE_NAMESPACES,
  describeBridgeShape,
  diffBridgeShapes,
  type BridgeShape,
} from "./bridge-shape.js";
import type { PlatformBridge } from "./platform-bridge.js";
import { FIXTURE_APP_META, createFixtureBridge } from "./platform-bridge.fixture.js";
import { createLiveBridge, readInstalledBridge } from "./live-bridge.js";
import { findScenario } from "../../../../../fixtures/index.js";
import { FIRST_RUN_SCENARIO_ID } from "../../../../../fixtures/scenarios/first-run.js";

/**
 * Installs a bridge the way the preload does and returns the live `PlatformBridge` the console
 * would resolve. It goes through `readInstalledBridge` so the "did the preload run" probe is on
 * the path this test drives.
 */
function resolveLiveBridgeFrom(installed: unknown): PlatformBridge | undefined {
  (globalThis as { desktopBridge?: unknown }).desktopBridge = installed;
  const read = readInstalledBridge();
  return read === undefined ? undefined : createLiveBridge(read);
}

function fixtureBridge(): PlatformBridge {
  return createFixtureBridge({ scenario: findScenario(FIRST_RUN_SCENARIO_ID) }).bridge;
}

function shapesOf(left: PlatformBridge, right: PlatformBridge): readonly string[] {
  return diffBridgeShapes(
    { label: "the live bridge", shape: describeBridgeShape(left) },
    { label: "the fixture bridge", shape: describeBridgeShape(right) },
  );
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "desktopBridge");
});

describe("the fixture bridge is shape-identical to the live bridge", () => {
  it("exposes the same namespaces and the same members in each", () => {
    const live = resolveLiveBridgeFrom(createStubBridge(FIXTURE_APP_META));
    expect(live, "the preload-shaped bridge was refused by the probe").toBeDefined();
    if (live === undefined) {
      return;
    }

    expect(shapesOf(live, fixtureBridge())).toStrictEqual([]);
  });

  it("covers every namespace the contract declares, so the comparison is not vacuous", () => {
    // Without this, two bridges that had both lost the same namespace, or an enumeration that read
    // nothing, would compare equal. It ties the runtime reading back to the contract.
    const live = resolveLiveBridgeFrom(createStubBridge(FIXTURE_APP_META));
    const fixture = fixtureBridge();
    const expected = [...DESKTOP_BRIDGE_NAMESPACES].sort();

    expect(live).toBeDefined();
    expect([...describeBridgeShape(fixture).keys()].sort()).toStrictEqual(expected);
    if (live !== undefined) {
      expect([...describeBridgeShape(live).keys()].sort()).toStrictEqual(expected);
    }
  });

  it("reads members, not just namespaces", () => {
    // The other vacuity arm: a describer returning an empty member list for every namespace would
    // pass both tests above.
    const shape: BridgeShape = describeBridgeShape(fixtureBridge());
    for (const namespace of DESKTOP_BRIDGE_NAMESPACES) {
      expect(shape.get(namespace)?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("negative control: rejects a bridge missing one method", () => {
    // The comparison must be able to fail: perturb a constructed bridge and compare through the
    // same function as the positive test, so a comparison that became a tautology is caught.
    const perturbed = createStubBridge(FIXTURE_APP_META);
    Reflect.deleteProperty(perturbed.native, "revealInFileExplorer");
    const live = resolveLiveBridgeFrom(perturbed);
    expect(live).toBeDefined();
    if (live === undefined) {
      return;
    }

    const differences = shapesOf(live, fixtureBridge());
    expect(differences).toHaveLength(1);
    expect(differences[0]).toContain("native.revealInFileExplorer");
  });

  it("negative control: rejects a bridge carrying an extra namespace", () => {
    const perturbed: PreloadApi & { readonly telemetry?: unknown } = {
      ...createStubBridge(FIXTURE_APP_META),
      telemetry: { report: () => undefined },
    };
    const live = resolveLiveBridgeFrom(perturbed);
    expect(live).toBeDefined();
    if (live === undefined) {
      return;
    }

    expect(shapesOf(live, fixtureBridge())).toStrictEqual([
      "namespace telemetry is on the live bridge and not on the fixture bridge",
    ]);
  });

  it("negative control: rejects a member whose type changed under it", () => {
    // A method replaced by a plausible value is how a half-installed preload arrives, and a
    // name-only comparison would call it equal.
    const perturbed = createStubBridge({ ...FIXTURE_APP_META });
    Reflect.set(perturbed.app, "version", 0);
    const live = resolveLiveBridgeFrom(perturbed);
    expect(live).toBeDefined();
    if (live === undefined) {
      return;
    }

    const differences = shapesOf(live, fixtureBridge());
    expect(differences).toContain(
      "app.version: number is on the live bridge and not on the fixture bridge",
    );
    expect(differences).toContain(
      "app.version: string is on the fixture bridge and not on the live bridge",
    );
  });

  it("treats a bridge that is not there as absent rather than as a shape difference", () => {
    // "The preload did not run" is a window to reopen and "the bridges diverged" is a defect to
    // fix; conflating them sends a person to the wrong one.
    expect(resolveLiveBridgeFrom(undefined)).toBeUndefined();
    expect(resolveLiveBridgeFrom({ daemon: {} })).toBeUndefined();
  });

  it("negative control: an array-valued namespace is refused rather than admitted", () => {
    // A hand-written `typeof === "object"` probe admits an array, so a namespace that arrived as
    // one passed and the console called methods on it. `isWireRecord` rejects it.
    const installed = createStubBridge(FIXTURE_APP_META);
    const [firstNamespace] = DESKTOP_BRIDGE_NAMESPACES;
    expect(firstNamespace).toBeDefined();
    const arrayValued = { ...installed, [firstNamespace ?? "daemon"]: [] };

    expect(resolveLiveBridgeFrom(arrayValued)).toBeUndefined();
    // The same object with that namespace intact is admitted, so the case above fails for the
    // array and not for how the literal was built.
    expect(resolveLiveBridgeFrom({ ...installed })).toBeDefined();
  });
});
