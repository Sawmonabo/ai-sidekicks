// The renderer's root component.
//
// Plan-023 Phase 1C mounts the console here, replacing the Phase-1 substrate probe
// (`SessionBootstrap`) that this component rendered while there was nothing else to
// render. That component is not deleted — it is Plan-002's, it keeps its own unit
// tests, and Plan-002's surfaces mount it through the console's surface registry
// when they land. What changes is only what the ROOT renders.
//
// Everything the console needs it builds for itself: `ConsoleRoot` installs the
// token sheet before first paint, resolves the bridge (live or `define`-gated
// fixture), creates the per-window stores, and mounts whatever the route names.
//
// The one fact the console cannot build for itself is WHICH scripted session a
// fixture build plays, because that is a property of the launch rather than of the
// code. It arrives on the document URL and is read here, once, at module
// evaluation — see `console/bridge/scenario-runtime/scenario-selection.ts`.

import { ScenarioSelection } from "./console/bridge/index.js";
import { ConsoleRoot } from "./console/frame/index.js";
import { OnboardingOverlay } from "./console/onboarding/index.js";
import type { ConsoleSurfaceContext } from "./console/seats/index.js";
import { SignInOverlay } from "./console/sign-in/index.js";

/**
 * The scenario this window plays, or `undefined` when fixtures are compiled out.
 *
 * At MODULE scope rather than inside the component, and that is the whole
 * mechanism: `Spec-023 §Console Design (Meridian)` §The fixture bridge forbids a
 * runtime fixture switch, so the id is read exactly once — before the first render
 * — and the value is a constant for the life of the window. A read inside the
 * component would run again on every render and make a mid-session change
 * representable, which is the shape the provider's single-resolution rule exists
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

/**
 * The window-scoped overlays this root composes, above every route.
 *
 * NEITHER IS A DESTINATION, which is why both are here rather than on the icon rail
 * or in the surface registry. Sign-in is a moment a person is in — the console is
 * fully usable signed out and the card appears only when somebody asks for it — and
 * the first-run walkthrough is forbidden from triggering on launch at all, so it too
 * has to be opened rather than navigated to. The frame threads this seam down to the
 * overlay slot beside the command palette, which is where a window-scoped dialog
 * belongs.
 *
 * COMPOSED HERE RATHER THAN INSIDE THE CONSOLE, because a view family may not import
 * a sibling: the frame cannot name either of them, and neither may name the other.
 * This root sits above the whole family DAG and reaches both through their doors,
 * which is the one place the composition can be written at all.
 *
 * Declared at module scope so its identity is stable: rebuilt per render it would
 * remount both dialogs on every frame render and lose whatever either was holding.
 */
const renderConsoleOverlays = (context: ConsoleSurfaceContext): React.ReactNode => (
  <>
    <SignInOverlay context={context} />
    <OnboardingOverlay context={context} />
  </>
);

export function App(): React.JSX.Element {
  // Spread rather than passed as `scenarioId={FIXTURE_SCENARIO_ID}`: the prop is
  // optional under `exactOptionalPropertyTypes`, so an explicit `undefined` is a
  // different value from an absent prop and the release arm has to omit it.
  return (
    <ConsoleRoot
      renderOverlays={renderConsoleOverlays}
      {...(FIXTURE_SCENARIO_ID === undefined ? {} : { scenarioId: FIXTURE_SCENARIO_ID })}
    />
  );
}
