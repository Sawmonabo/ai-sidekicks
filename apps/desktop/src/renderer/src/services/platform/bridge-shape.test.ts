// The fixture-bridge shape claim, as a test.
//
// The claim: the fixture bridge is typed from the same `packages/contracts`
// desktop-bridge types as the live bridge, and is shape-identical to `DesktopBridge`
// namespace for namespace.
//
// WHY A RUNTIME TEST FOR SOMETHING THE TYPES ALREADY SAY. Both bridges are declared
// `DesktopBridge`, so a namespace added to the contract breaks the fixture at
// compile time. What the compiler cannot see is the LIVE side: `window.desktopBridge`
// is installed by a preload across `contextBridge`, which structurally clones the
// object graph, and the renderer's belief that it satisfies the interface is a
// declaration about a value the renderer never checked. So the shapes are read from
// the two real bridges — the live one built the way the preload builds it, the
// fixture one built by its own factory — and compared.
//
// NOTHING HERE HAND-LISTS A NAMESPACE OR A METHOD. A test that carried its own copy
// of the bridge's surface would be a third declaration of it, maintained by whoever
// remembered, and would go on passing over a fixture that dropped a method the
// hand-list also forgot. The comparison enumerates both objects at runtime, and the
// only listing anywhere is `bridge-shape.ts`'s namespace table, which is keyed by
// `keyof DesktopBridge` and therefore cannot go stale.

import { createStubBridge, type DesktopBridge } from "@ai-sidekicks/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  DESKTOP_BRIDGE_NAMESPACES,
  describeBridgeShape,
  diffBridgeShapes,
  type BridgeShape,
} from "@renderer/services/platform/bridge-shape.js";
import type { ConsoleBridge } from "./console-bridge.js";
import { createFixtureBridge } from "./fixture/call-plane/bridge.js";
import { createLiveBridge, readInstalledBridge } from "@renderer/services/platform/live-bridge.js";
import { CONSOLE_SCENARIOS } from "../../../../../fixtures/index.js";
import { consoleScenario } from "./scenario/manifest.js";
import { FIRST_RUN_SCENARIO_ID } from "../../../../../fixtures/scenarios/first-run.js";

/**
 * Install a bridge the way the preload does, and hand back the live `ConsoleBridge`
 * the console would have resolved.
 *
 * Goes through `readInstalledBridge` rather than calling `createLiveBridge` with the
 * object directly, so the probe that decides whether a preload ran is on the path
 * this test drives. A helper that skipped it would be testing a bridge the console
 * would have refused.
 */
function resolveLiveBridgeFrom(installed: unknown): ConsoleBridge | undefined {
  (globalThis as { desktopBridge?: unknown }).desktopBridge = installed;
  const read = readInstalledBridge();
  return read === undefined ? undefined : createLiveBridge(read);
}

function fixtureBridge(): ConsoleBridge {
  return createFixtureBridge({ scenario: consoleScenario(FIRST_RUN_SCENARIO_ID) });
}

function shapesOf(left: ConsoleBridge, right: ConsoleBridge): readonly string[] {
  return diffBridgeShapes(
    { label: "the live bridge", shape: describeBridgeShape(left.desktopBridge) },
    { label: "the fixture bridge", shape: describeBridgeShape(right.desktopBridge) },
  );
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "desktopBridge");
});

describe("the fixture bridge is shape-identical to the live bridge", () => {
  it("exposes the same namespaces and the same members in each", () => {
    const live = resolveLiveBridgeFrom(createStubBridge());
    expect(live, "the preload-shaped bridge was refused by the probe").toBeDefined();
    if (live === undefined) {
      return;
    }

    expect(shapesOf(live, fixtureBridge())).toStrictEqual([]);
  });

  it("covers every namespace the contract declares, so the comparison is not vacuous", () => {
    // Without this, two bridges that had both lost the same namespace — or an
    // enumeration that read nothing at all — would compare equal and pass. The
    // namespace table is keyed by `keyof DesktopBridge`, so this is the point
    // where the runtime reading is tied back to the contract.
    const live = resolveLiveBridgeFrom(createStubBridge());
    const fixture = fixtureBridge();
    const expected = [...DESKTOP_BRIDGE_NAMESPACES].sort();

    expect(live).toBeDefined();
    expect([...describeBridgeShape(fixture.desktopBridge).keys()].sort()).toStrictEqual(expected);
    if (live !== undefined) {
      expect([...describeBridgeShape(live.desktopBridge).keys()].sort()).toStrictEqual(expected);
    }
  });

  it("reads members, not just namespaces", () => {
    // The other vacuity arm: a describer that returned an empty member list for
    // every namespace would satisfy both tests above. Every namespace the contract
    // declares carries at least one member, so an empty one is a reading failure.
    const shape: BridgeShape = describeBridgeShape(fixtureBridge().desktopBridge);
    for (const namespace of DESKTOP_BRIDGE_NAMESPACES) {
      expect(shape.get(namespace)?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("negative control: rejects a bridge missing one method", () => {
    // The comparison must be able to FAIL, and this is the failure it exists for —
    // a fixture that answered every call but one. Perturbed on a constructed
    // bridge and compared through the SAME function the positive test uses, so a
    // comparison that had quietly become a tautology is caught here.
    const perturbed = createStubBridge();
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
    const perturbed: DesktopBridge & { readonly telemetry?: unknown } = {
      ...createStubBridge(),
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
    // A method replaced by a plausible-looking value is the shape a half-installed
    // preload actually arrives in, and a name-only comparison would call it equal.
    const perturbed = createStubBridge();
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
    // The two failures are different facts with different next steps: "the preload
    // did not run" is a window to reopen, and "the bridges diverged" is a defect to
    // fix. Conflating them would send a person to the wrong one.
    expect(resolveLiveBridgeFrom(undefined)).toBeUndefined();
    expect(resolveLiveBridgeFrom({ daemon: {} })).toBeUndefined();
  });

  it("negative control: an array-valued namespace is refused rather than admitted", () => {
    // The probe used to read each namespace as `typeof … === "object" && … !== null`,
    // which is true of an array — so a namespace that arrived as one passed, and the
    // console went on to call methods on it. The reading is `core/isWireRecord` now,
    // which rejects an array, and this is what fails if that is written by hand again.
    const installed = createStubBridge();
    const [firstNamespace] = DESKTOP_BRIDGE_NAMESPACES;
    expect(firstNamespace).toBeDefined();
    const arrayValued = { ...installed, [firstNamespace ?? "daemon"]: [] };

    expect(resolveLiveBridgeFrom(arrayValued)).toBeUndefined();
    // And the same object with that namespace intact IS admitted, so the case above
    // fails for the array and not for the way this literal was built.
    expect(resolveLiveBridgeFrom({ ...installed })).toBeDefined();
  });
});

describe("the scenario lookup", () => {
  it("resolves every scenario on the board", () => {
    for (const scenario of CONSOLE_SCENARIOS) {
      expect(consoleScenario(scenario.id).id).toBe(scenario.id);
    }
  });

  it("negative control: an unknown scenario id is refused rather than defaulted", () => {
    expect(() => consoleScenario("no-such-scenario")).toThrow(RangeError);
  });
});
