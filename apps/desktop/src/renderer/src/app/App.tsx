// The renderer's root component.

import type { BridgeComposition } from "@renderer/services/platform/bridge-context.js";
import { composeFixtureLaunch } from "./fixture-composition.js";
import { AppProviders } from "./AppProviders.js";

/**
 * The fixture composition this launch asks for, or `undefined` for a normal launch.
 *
 * Read once at module scope, so the launch is constant for the console document's life. The
 * build-time `__FIXTURE_BUILD__` literal lets a release bundle drop the call and tree-shake every
 * scenario, so a shipped app cannot be switched into fixture data.
 */
const FIXTURE_COMPOSITION: BridgeComposition | undefined = __FIXTURE_BUILD__
  ? composeFixtureLaunch()
  : undefined;

/** The renderer's root: mounts the app, playing the launch's scenario when it names one. */
export function App(): React.JSX.Element {
  // Spread, not passed directly: under `exactOptionalPropertyTypes` an explicit `undefined`
  // differs from an absent prop, and a normal launch must omit it.
  return (
    <AppProviders
      {...(FIXTURE_COMPOSITION === undefined ? {} : { composition: FIXTURE_COMPOSITION })}
      openWindow={openBlankWindow}
    />
  );
}

/** A window a person sees, opened blank under its id; main builds the native window around it. */
function openBlankWindow(windowId: string): Window | null {
  return window.open("about:blank", windowId);
}
