// The renderer's root component.
//
// The root mounts the console.
//
// Everything the console needs it builds for itself: `ConsoleRoot` installs the
// token sheet before first paint, resolves the bridge (live or `define`-gated
// fixture), creates the per-window stores, and mounts whatever the route names.
//
// The one fact the console cannot build for itself is WHICH scripted session a
// fixture build plays, because that is a property of the launch rather than of the
// code. It arrives on the document URL and is read here, once, at module
// evaluation — see `console/bridge/scenario/selection.ts`.

import { ScenarioSelection } from "@renderer/console/bridge/scenario/selection.js";
import { ConsoleRoot } from "@renderer/console/frame/index.js";

/**
 * The scenario this window plays, or `undefined` when fixtures are compiled out.
 *
 * At MODULE scope rather than inside the component, and that is the whole mechanism:
 * the fixture bridge forbids a runtime fixture switch, so the id is read exactly once —
 * before the first render — and the value is a constant for the life of the window. A
 * read inside the component would run again on every render and make a mid-session
 * change representable, which is the shape the provider's single-resolution rule exists
 * to rule out.
 *
 * `__SIDEKICKS_CONSOLE_FIXTURES__` is a build-time literal, so a release bundle
 * folds this to `undefined`, drops the call, and tree-shakes the whole
 * scenario-selection module: a shipped console reads no query, carries no
 * scenario, and cannot be switched into fixture data by anything on the URL.
 */
const FIXTURE_SCENARIO_ID: string | undefined = __SIDEKICKS_CONSOLE_FIXTURES__
  ? ScenarioSelection.fromDocumentLocation().scenarioId
  : undefined;

/** The renderer's root: mounts the console, playing the launch's scenario in a fixture build. */
export function App(): React.JSX.Element {
  // Spread rather than passed as `scenarioId={FIXTURE_SCENARIO_ID}`: the prop is
  // optional under `exactOptionalPropertyTypes`, so an explicit `undefined` is a
  // different value from an absent prop and the release arm has to omit it.
  return (
    <ConsoleRoot
      {...(FIXTURE_SCENARIO_ID === undefined ? {} : { scenarioId: FIXTURE_SCENARIO_ID })}
    />
  );
}
