// I-023-13, as a test.
//
// The invariant: "the fixture bridge is typed from the same `packages/contracts`
// desktop-bridge types as the live bridge, is shape-identical to `SidekicksBridge`
// namespace for namespace, and the scenario manifest's live-status field is checked
// against `Plan-023 §Console growth slate`."
//
// WHY A RUNTIME TEST FOR SOMETHING THE TYPES ALREADY SAY. Both bridges are declared
// `SidekicksBridge`, so a namespace added to the contract breaks the fixture at
// compile time. What the compiler cannot see is the LIVE side: `window.sidekicks`
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
// `keyof SidekicksBridge` and therefore cannot go stale.
//
// WHAT THIS FILE DOES NOT COVER. `FAILURE-MATRIX.test.ts` already drives the growth
// ledger's internal coherence — every slate row covered, no orphaned row id, every
// entry `fixture-only` while its row is unregistered, one port method per operation
// entry. Repeating those here would be two tests failing for one cause. What is
// left, and what this file adds, is the join between the ledger and an actual
// `ConsoleBridge`: that the operations the manifest carries a live status for are
// reachable on the port BOTH bridges expose, and that every row a ledger entry
// names resolves to a row object rather than throwing.

import { createTier1Bridge, type SidekicksBridge } from "@ai-sidekicks/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  SIDEKICKS_BRIDGE_NAMESPACES,
  describeBridgeShape,
  diffBridgeShapes,
  type BridgeShape,
} from "./bridge-shape.js";
import type { ConsoleBridge } from "./console-bridge.js";
import { createFixtureBridge } from "./fixture/fixture-bridge.js";
import { GROWTH_OPERATIONS } from "./growth-operations/index.js";
import { GROWTH_PREREQUISITES } from "./growth-port/growth-prerequisites.js";
import { growthSlateRow } from "./growth-port/growth-slate.js";
import { createLiveBridge, readInstalledBridge } from "./live-bridge.js";
import { consoleScenario, consoleScenarioManifest } from "./scenario-runtime/scenario-manifest.js";
import { FIRST_RUN_SCENARIO_ID } from "./scenarios/first-run.js";

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
  (globalThis as { sidekicks?: unknown }).sidekicks = installed;
  const read = readInstalledBridge();
  return read === undefined ? undefined : createLiveBridge(read);
}

function fixtureBridge(): ConsoleBridge {
  return createFixtureBridge({ scenario: consoleScenario(FIRST_RUN_SCENARIO_ID) });
}

function shapesOf(left: ConsoleBridge, right: ConsoleBridge): readonly string[] {
  return diffBridgeShapes(
    { label: "the live bridge", shape: describeBridgeShape(left.sidekicks) },
    { label: "the fixture bridge", shape: describeBridgeShape(right.sidekicks) },
  );
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "sidekicks");
});

describe("I-023-13 — the fixture bridge is shape-identical to the live bridge", () => {
  it("exposes the same namespaces and the same members in each", () => {
    const live = resolveLiveBridgeFrom(createTier1Bridge());
    expect(live, "the preload-shaped bridge was refused by the probe").toBeDefined();
    if (live === undefined) {
      return;
    }

    expect(shapesOf(live, fixtureBridge())).toStrictEqual([]);
  });

  it("covers every namespace the contract declares, so the comparison is not vacuous", () => {
    // Without this, two bridges that had both lost the same namespace — or an
    // enumeration that read nothing at all — would compare equal and pass. The
    // namespace table is keyed by `keyof SidekicksBridge`, so this is the point
    // where the runtime reading is tied back to the contract.
    const live = resolveLiveBridgeFrom(createTier1Bridge());
    const fixture = fixtureBridge();
    const expected = [...SIDEKICKS_BRIDGE_NAMESPACES].sort();

    expect(live).toBeDefined();
    expect([...describeBridgeShape(fixture.sidekicks).keys()].sort()).toStrictEqual(expected);
    if (live !== undefined) {
      expect([...describeBridgeShape(live.sidekicks).keys()].sort()).toStrictEqual(expected);
    }
  });

  it("reads members, not just namespaces", () => {
    // The other vacuity arm: a describer that returned an empty member list for
    // every namespace would satisfy both tests above. Every namespace the contract
    // declares carries at least one member, so an empty one is a reading failure.
    const shape: BridgeShape = describeBridgeShape(fixtureBridge().sidekicks);
    for (const namespace of SIDEKICKS_BRIDGE_NAMESPACES) {
      expect(shape.get(namespace)?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("negative control: rejects a bridge missing one method", () => {
    // The comparison must be able to FAIL, and this is the failure it exists for —
    // a fixture that answered every call but one. Perturbed on a constructed
    // bridge and compared through the SAME function the positive test uses, so a
    // comparison that had quietly become a tautology is caught here.
    const perturbed = createTier1Bridge();
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
    const perturbed: SidekicksBridge & { readonly telemetry?: unknown } = {
      ...createTier1Bridge(),
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
    const perturbed = createTier1Bridge();
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
    const installed = createTier1Bridge();
    const [firstNamespace] = SIDEKICKS_BRIDGE_NAMESPACES;
    expect(firstNamespace).toBeDefined();
    const arrayValued = { ...installed, [firstNamespace ?? "daemon"]: [] };

    expect(resolveLiveBridgeFrom(arrayValued)).toBeUndefined();
    // And the same object with that namespace intact IS admitted, so the case above
    // fails for the array and not for the way this literal was built.
    expect(resolveLiveBridgeFrom({ ...installed })).toBeDefined();
  });
});

describe("I-023-13 — the growth ledger's live status is checked against the slate", () => {
  it("exposes every ledgered operation on the growth port of BOTH bridges", () => {
    // The manifest carries a `liveStatus` per operation. A status for an operation
    // no bridge exposes is a claim about a method that does not exist — the ledger
    // would go on reporting "fixture-only" for a wire no surface could ever call.
    const live = resolveLiveBridgeFrom(createTier1Bridge());
    const fixture = fixtureBridge();
    expect(live).toBeDefined();

    for (const entry of consoleScenarioManifest().growthOperations) {
      expect(Object.keys(fixture.growth)).toContain(entry.id);
      if (live !== undefined) {
        expect(Object.keys(live.growth)).toContain(entry.id);
      }
    }
  });

  it("keeps prerequisites off the port, since a method that dispatches nothing is a fiction", () => {
    const portMethodNames = new Set(Object.keys(fixtureBridge().growth));
    for (const entry of consoleScenarioManifest().prerequisites) {
      expect(portMethodNames.has(entry.id)).toBe(false);
    }
  });

  it("resolves every slate row a ledger entry names", () => {
    for (const entry of [
      ...consoleScenarioManifest().growthOperations,
      ...consoleScenarioManifest().prerequisites,
    ]) {
      expect(growthSlateRow(entry.slateRow).id).toBe(entry.slateRow);
    }
  });

  it("serves only operations it has entries for", () => {
    // `fixtureServedOperations` is the fixture's claim about which growth wires it
    // scripts. An id here that the ledger does not carry would be a served wire
    // with no slate row and therefore no owner.
    for (const operationId of consoleScenarioManifest().fixtureServedOperations) {
      expect(Object.keys(GROWTH_OPERATIONS)).toContain(operationId);
    }
  });

  it("negative control: the port-membership check notices an id that is not on the port", () => {
    // Proves the three checks above are reading the port rather than passing over
    // whatever they are handed. A prerequisite id is the right probe: it is a real
    // ledger id that must never be a method.
    const portMethodNames = Object.keys(fixtureBridge().growth);
    const prerequisiteId = Object.keys(GROWTH_PREREQUISITES)[0];

    expect(prerequisiteId).toBeDefined();
    expect(portMethodNames).not.toContain(prerequisiteId);
    expect(portMethodNames.length).toBeGreaterThan(0);
  });

  it("resolves every scenario the manifest lists", () => {
    for (const scenario of consoleScenarioManifest().scenarios) {
      expect(consoleScenario(scenario.id).id).toBe(scenario.id);
    }
  });

  it("negative control: an unknown scenario id is refused rather than defaulted", () => {
    expect(() => consoleScenario("no-such-scenario")).toThrow(RangeError);
  });
});
