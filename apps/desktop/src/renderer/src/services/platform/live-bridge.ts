// The live bridge: the only module that reads `window.desktopBridge`, and the one reader of the
// fixture launch the preload exposes beside it. Everything above takes a `PlatformBridge` from
// context so the fixture is substitutable, and a lint rule in `eslint.config.mjs` bans the direct
// read elsewhere. A preload that did not run is a real state, so `readInstalledBridge` returns
// `undefined` and the caller renders a stated failure instead of a blank window.
import { isWireRecord } from "#renderer/lib/wire/record.js";
import { FIXTURE_LAUNCH_GLOBAL, type FixtureLaunch } from "#shared/fixture-launch.js";
import type { PreloadApi } from "#shared/preload-api.js";
import type { PlatformBridge } from "./platform-bridge.js";
import { TransportReconnectSignal } from "../transport/reconnect.js";

/** The installed preload bridge, or `undefined` when the preload did not run. */
export function readInstalledBridge(): PreloadApi | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }
  const candidate = (window as { desktopBridge?: PreloadApi }).desktopBridge;
  return isBridgeShaped(candidate) ? candidate : undefined;
}

/**
 * The fixture launch the preload exposed, or `undefined` for a window started without one. Only
 * the fixture composition calls it, behind the fixture define, so a release bundle carries neither
 * the call nor the property name.
 */
export function readFixtureLaunch(): FixtureLaunch | undefined {
  return (window as unknown as Record<string, FixtureLaunch | undefined>)[FIXTURE_LAUNCH_GLOBAL];
}

/** Wraps the installed preload bridge as the window's platform bridge. */
export function createLiveBridge(preloadApi: PreloadApi): PlatformBridge {
  return {
    ...preloadApi,
    // Reported into by main's `daemon.status` topic (`daemon/status.ts`) and by every
    // subscription any window opens (`transport/observed-subscription.ts`). One for the app: every
    // window reaches the service through main's one connection, so they share one reading.
    transportReconnect: new TransportReconnectSignal(),
    source: "live",
  };
}

/**
 * Every namespace `PreloadApi` declares. The annotation makes it exhaustive in both directions: a
 * namespace missing here, or one not on `PreloadApi`, is a compile error.
 */
const PRELOAD_NAMESPACE_PRESENCE: Readonly<Record<keyof PreloadApi, true>> = {
  daemon: true,
  native: true,
  machineSettings: true,
  keyboardMap: true,
  window: true,
  app: true,
};

const PRELOAD_NAMESPACES = Object.keys(PRELOAD_NAMESPACE_PRESENCE);

/**
 * A shallow "did the preload run" probe over the namespaces the contract declares, not a
 * validator. It uses `isWireRecord` because a `typeof === "object"` pair admits an array-valued
 * namespace.
 */
function isBridgeShaped(candidate: unknown): candidate is PreloadApi {
  if (!isWireRecord(candidate)) {
    return false;
  }
  return PRELOAD_NAMESPACES.every((namespace) => isWireRecord(candidate[namespace]));
}
