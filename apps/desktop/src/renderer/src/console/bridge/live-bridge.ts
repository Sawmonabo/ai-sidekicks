// The live bridge: the ONLY module in the console that reads `window.sidekicks`.
//
// Everything above this file takes a `ConsoleBridge` from React context, which is
// what makes the fixture substitutable at all. A single stray `window.sidekicks` in
// a component would quietly make that component unrenderable under the fixture, and
// nobody would notice until a screenshot run failed for an unrelated reason — so
// the single-reader rule is a source-text claim, checked by the architecture tier
// (`test/console/architecture/`), while the claim that the two bridges are the same
// SHAPE is a runtime one and is checked by `bridge-shape.test.ts` beside this file.
//
// The preload not having run is a real state, not a theoretical one: an auxiliary
// window whose preload path is wrong, a renderer loaded before the bridge is
// installed. So `readInstalledBridge` returns `undefined` rather than throwing, and
// the caller renders the "error" kind of nothing — a stated failure with a next
// step — instead of a blank window.

import type { SidekicksBridge } from "@ai-sidekicks/contracts";
import { SIDEKICKS_BRIDGE_NAMESPACES } from "./bridge-shape.js";
import type { ConsoleBridge } from "./console-bridge.js";
import { createRefusingGrowthPort } from "./growth-port/index.js";

/** The installed preload bridge, or `undefined` when the preload did not run. */
export function readInstalledBridge(): SidekicksBridge | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }
  const candidate = (window as { sidekicks?: SidekicksBridge }).sidekicks;
  return isBridgeShaped(candidate) ? candidate : undefined;
}

/**
 * Wrap the installed preload bridge for console use.
 *
 * The growth port is the refusing one: under the live bridge every slate wire is
 * unregistered by definition, so each call resolves to a typed refusal the surface
 * renders as "not checked".
 */
export function createLiveBridge(sidekicks: SidekicksBridge): ConsoleBridge {
  return {
    sidekicks,
    growth: createRefusingGrowthPort(),
    // Empty, and built fresh rather than shared: a frozen module-level set would
    // be a singleton the console's own rules reject, and the allocation is one
    // empty set per window.
    growthServedOperations: new Set(),
    // No view host, which is 12.11's third arm rather than an omission: this task
    // mints no main-process host, so a pane in a live window reports its rectangle
    // to nothing and renders the sentence that says so.
    paneViewHostScript: undefined,
    source: "live",
    scenarioEngine: undefined,
  };
}

/**
 * A structural check over the namespaces the contract declares.
 *
 * Deliberately shallow: this is a "did the preload run" probe, not a validator. A
 * bridge missing a namespace is a build error the contracts package catches; a
 * bridge missing entirely is a runtime state this function exists to name.
 *
 * The namespace list is `bridge-shape.ts`'s, not a second copy — that module holds
 * it as a table keyed by `keyof SidekicksBridge`, so a namespace added to the
 * contract cannot slip past this probe unlisted.
 */
function isBridgeShaped(candidate: unknown): candidate is SidekicksBridge {
  if (typeof candidate !== "object" || candidate === null) {
    return false;
  }
  return SIDEKICKS_BRIDGE_NAMESPACES.every((namespace) => {
    const value = (candidate as Record<string, unknown>)[namespace];
    return typeof value === "object" && value !== null;
  });
}
