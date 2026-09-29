// The renderer's root component.
//
// The root mounts the console.
//
// Everything the console needs it builds for itself: `AppProviders` installs the
// token sheet before first paint, resolves the bridge, creates the per-window stores,
// and mounts whatever the route names.
//
// The one fact the console cannot build for itself is whether this window was launched
// to play a fixture scenario, because that is a property of the launch rather than of
// the code. It is read here, once, at module evaluation — see `./fixture-composition.ts`.

import type { BridgeComposition } from "@renderer/services/platform/bridge-context.js";
import { composeFixtureLaunch } from "./fixture-composition.js";
import { AppProviders } from "./providers.js";

/**
 * The fixture composition this window's launch asks for, or `undefined` for a normal launch.
 *
 * At MODULE scope rather than inside the component, and that is the whole mechanism: a
 * launch is read exactly once, before the first render, and the value is a constant for
 * the life of the window. A read inside the component would run again on every render and
 * make a mid-session change representable.
 *
 * `__FIXTURE_BUILD__` is a build-time literal, so a release bundle folds this
 * to `undefined`, drops the call, and tree-shakes the fixture composition and every
 * scenario with it: a shipped console reads no launch and cannot be switched into fixture
 * data.
 */
const FIXTURE_COMPOSITION: BridgeComposition | undefined = __FIXTURE_BUILD__
  ? composeFixtureLaunch()
  : undefined;

/** The renderer's root: mounts the console, playing the launch's scenario when it names one. */
export function App(): React.JSX.Element {
  // Spread rather than passed as `composition={FIXTURE_COMPOSITION}`: the prop is optional
  // under `exactOptionalPropertyTypes`, so an explicit `undefined` is a different value
  // from an absent prop and the normal launch has to omit it.
  return (
    <AppProviders
      {...(FIXTURE_COMPOSITION === undefined ? {} : { composition: FIXTURE_COMPOSITION })}
    />
  );
}
