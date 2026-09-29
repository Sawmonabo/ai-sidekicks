// The live bridge: the ONLY module in the console that reads `window.desktopBridge`, and the
// one reader of the fixture launch the preload exposes beside it.
//
// Everything above this file takes a `PlatformBridge` from React context, which is
// what makes the fixture substitutable at all. A single stray `window.desktopBridge` in
// a component would quietly make that component unrenderable under the fixture, and
// nobody would notice until a screenshot run failed for an unrelated reason — so
// the single-reader rule is a lint rule — `no-restricted-syntax` in
// `apps/desktop/eslint.config.mjs` bans `window.desktopBridge`, `globalThis.desktopBridge`, and
// the cast form this file uses everywhere but here — while the claim that the two bridges
// are the same SHAPE is a runtime one and is checked by `bridge-shape.test.ts` beside
// this file.
//
// The preload not having run is a real state, not a theoretical one: a window whose
// preload path is wrong, a renderer loaded before the bridge is installed. So
// `readInstalledBridge` returns `undefined` rather than throwing, and the caller
// renders the "error" kind of nothing — a stated failure with a next step — instead
// of a blank window.
import { isWireRecord } from "@renderer/lib/wire-record.js";
import { DESKTOP_BRIDGE_NAMESPACES } from "./bridge-shape.js";
import { FIXTURE_LAUNCH_GLOBAL, type FixtureLaunch } from "@shared/fixture-launch.js";
import type { PreloadApi } from "@shared/preload-api.js";
import type { PlatformBridge } from "./platform-bridge.js";
import { TransportReconnectSignal } from "../transport/transport-reconnect.js";

/** The installed preload bridge, or `undefined` when the preload did not run. */
export function readInstalledBridge(): PreloadApi | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }
  const candidate = (window as { desktopBridge?: PreloadApi }).desktopBridge;
  return isBridgeShaped(candidate) ? candidate : undefined;
}

/**
 * The fixture launch the preload exposed, or `undefined` for a window started without one.
 *
 * Read here for the same reason the bridge is: this module is the one reader of what the
 * preload puts on the page. Only the fixture composition calls it, behind the fixture define,
 * so a release bundle carries neither the call nor the property name.
 */
export function readFixtureLaunch(): FixtureLaunch | undefined {
  return (window as unknown as Record<string, FixtureLaunch | undefined>)[FIXTURE_LAUNCH_GLOBAL];
}

/** Wrap the installed preload bridge for console use. */
export function createLiveBridge(preloadApi: PreloadApi): PlatformBridge {
  return {
    ...preloadApi,
    // Minted here and REPORTED INTO by every subscription this window opens, through
    // `transport/observed-subscription.ts`: whether `daemon.subscribe` returned or
    // threw is the only connection state a live renderer has. Built fresh per window
    // rather than shared: a module-level signal
    // would make two windows in one process share a transport reading only one of
    // them observed.
    transportReconnect: new TransportReconnectSignal(),
    source: "live",
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
 * it as a table keyed by `keyof PreloadApi`, so a namespace added to the
 * contract cannot slip past this probe unlisted.
 *
 * The record reading is `core/isWireRecord`, not a hand-written `typeof … === "object"`
 * pair, which is what these two lines were. That pair admits an ARRAY on both sides —
 * `typeof [] === "object"` and `[] !== null` — so an array-valued namespace passed the
 * probe and the console went on to call methods on it. The shared predicate rejects one,
 * and it also narrows, so the cast the inner line carried is gone with it.
 */
function isBridgeShaped(candidate: unknown): candidate is PreloadApi {
  if (!isWireRecord(candidate)) {
    return false;
  }
  return DESKTOP_BRIDGE_NAMESPACES.every((namespace) => isWireRecord(candidate[namespace]));
}
