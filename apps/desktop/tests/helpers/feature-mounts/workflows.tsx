// The workflows feature's screen and panes, mounted once for the two tiers that look at them.
//
// Not a test file — no `include` glob reaches it. The screenshot tier and the
// accessibility tier need the views this feature ships, and a per-tier copy of the
// mount would be two chances to compose them differently and then read the results as
// if they were comparable. `app-harness.ts` owns HOW the app is mounted, one
// level down; this module owns WHAT of this feature is mounted into it.
//
// ONE FILE PER FEATURE, UNDER `tests/helpers/feature-mounts/`. The tier root holds the
// roles every tier reaches for — the harness, the graph-readiness wait, the source walk —
// and a mount that is one feature's is not one of them. Seven features each dropping a
// mount file beside those would bury the shared set in the per-feature set, and a
// reader looking for what a tier can reuse would have to know the difference by
// name. The directory is the difference, and it scales.
//
// THE THREE REGISTERED VIEWS, AND ONE PIECE NO VIEW MOUNTS YET. The feature registers
// one rail destination and TWO pane kinds, so all three are mounted here, each drawing
// what it has with no call to read a run or a definition through. The accessibility tier
// audits every one of them — a feature-wide claim that skipped a registered pane could not
// fail on a regression unique to it. The screenshot tier pins its own subset, a separate
// judgment made in that tier's own table. The run's phase graph is mounted on its own,
// from a hand-built run, because no view composes it until the run read is built and
// its geometry and readiness are still worth holding.
//
// THE BODIES COME OUT OF THE FEATURE'S REGISTRIES, NOT OUT OF AN IMPORT, on the
// browser-terminal tiers' precedent: the run pane is resolved through
// `PaneRegistry` and the destination through `ScreenRegistry`, each
// after the feature registers into it — so a tier renders what the pane layout and the rail
// would actually mount rather than a component that happens to sit beside them, and
// the feature's stylesheets arrive on the edges its own modules already own, which is
// what makes the captured pixels the ones a person would see.
//
// THE DESTINATION IS MOUNTED WITH A SESSION IN SCOPE, WHICH IS HOW A PERSON REACHES
// IT. `#/workflows` is a bare route and the definition enumeration's request carries
// a required session id, so the screen resolves its subject from the session this
// window last opened. The frame store below is put in that state by NAVIGATING —
// into a session and then to the workflows destination — rather than by setting the
// field, because that retention is the store's own rule and a tier that wrote the
// member directly would pin a frame the shipped store could no longer produce.
//
// WHY EACH VIEW IS FOUND A DIFFERENT WAY. Each pane IS one region, and
// `PaneFrame` names it with `aria-labelledby` pointing at the crumb
// TRAIL rather than at a heading — so a pane's accessible name is its whole address
// ("session-1 run-01 Workflow run") and two panes of one kind in one pane layout are told
// apart by what they are scoped to. That is why the lookup below reads the trail's
// current crumb rather than comparing the whole name. The destination is not a region
// at all, so it is addressed by its own root instead.

import type { FunctionComponent } from "react";

import { renderSettled } from "../app-harness.js";
import { createFixtureBridge } from "@renderer/services/platform/platform-bridge.fixture.js";
import { type PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import { unscriptedScenario } from "../fixture-bridge.js";
import { FixtureBridgeProvider } from "../app-frame-fixtures.js";
import {
  PARKED_RUN,
  PROBE_SESSION_ID,
  definition,
} from "@renderer/features/workflows/workflows-probe.test-support.js";
import { RunGraphSection } from "@renderer/features/workflows/run-page/components/RunGraphSection.js";
// The context comes off its own module: it was hoisted out of the board to break the
// cycle a loader-backed screen's reserved frame would otherwise close.
import { type ScreenContext } from "@renderer/registries/screens/screen-context.js";
import { LiveAnnouncerProvider } from "@renderer/console/primitives/index.js";
import { MAXIMUM_LIVE_DRAFT_COUNT } from "@renderer/store/persistence-caps.js";
import { DraftStore } from "@renderer/store/draft-store.js";
import { UiStateStore } from "@renderer/store/persistence/ui-state-store.js";
import { WindowStore } from "@renderer/store/window/window-store.js";
import { SessionStore } from "@renderer/store/session/session-store.js";
import { SessionStoreRegistry } from "@renderer/store/session/session-store-registry.js";
import {
  registerWorkflowPanes,
  registerWorkflowScreens,
} from "@renderer/features/workflows/index.js";
import {
  PaneRegistry,
  type PaneAddress,
  type PaneContext,
  type PaneKind,
} from "@renderer/console/seats/index.js";
import { resolvedPaneBody, resolvedScreenBody } from "./pane-body-resolution.js";
import { COMPOSED_ENTITY_PROJECTORS } from "./projector-composition.js";
import { type MountedView } from "./mount-queries.js";

/**
 * A registry carrying exactly this feature's two claims.
 *
 * Built per call rather than shared: the registry is owner-scoped state, and two
 * tiers holding one instance would make the second tier's mount depend on whether
 * the first had run.
 */
function workflowPaneRegistry(): PaneRegistry {
  const registry = new PaneRegistry();
  registerWorkflowPanes(registry);
  return registry;
}

/**
 * The workflows pane body the pane layout holds for a kind, loaded.
 *
 * The resolution — build a feature-scoped registry, preload, read the descriptor, throw
 * by name — lives once in `pane-body-resolution.ts`; what stays here is
 * this feature's registrar and the `{ context }` prop shape its mounts below render with.
 */
async function paneBodyComponent(
  kind: PaneKind,
): Promise<FunctionComponent<{ context: PaneContext }>> {
  const render = await resolvedPaneBody(kind, registerWorkflowPanes);
  return ({ context }) => render(context);
}

/**
 * The pane layout context a pane is mounted with, minus the parts each caller supplies.
 *
 * The caller supplies the ADDRESS and the pane id, not a `Pick` of the context: the
 * address is a kind-scoped union, so `entity` is not a key every arm has and a `Pick`
 * naming it does not resolve. Taking the union itself is also the stronger claim —
 * a tier cannot mount a workflow pane over an entity kind the pane registry refuses.
 */
function paneContext(
  address: PaneAddress & { readonly paneId: string },
  bridge: PlatformBridge,
): PaneContext {
  return {
    ...address,
    frameStore: new WindowStore(),
    uiStateStore: UiStateStore.opening(),
    draftStore: new DraftStore({ maximumDraftCount: MAXIMUM_LIVE_DRAFT_COUNT }),
    // Nothing opened these panes from another: each tier mounts one body directly.
    linkedSourcePaneId: undefined,
    focusHue: undefined,
    bridge,
    // Opened with the fold a window composes rather than with none: a store built
    // without projectors folds every event into no entity, so a partition a pane
    // reads answers the empty map a session with no runs answers.
    sessionStore: new SessionStore({
      sessionId: PROBE_SESSION_ID,
      projectors: COMPOSED_ENTITY_PROJECTORS,
    }),
  };
}

/**
 * Find the one region a workflows pane renders itself as, by the crumb it is on.
 *
 * Through the accessible name rather than a class, because that is what a person
 * using assistive technology navigates by — a pane that lost its name would still
 * match a class selector and would still be captured as if nothing had changed. The
 * reference is resolved the way an IDREF resolves, from the tree it lives in, so a
 * pair of panes sharing one id would be caught here rather than silently returning
 * the first pane twice.
 *
 * The CURRENT crumb and not the whole name: the chrome names a pane by its entire
 * address trail, so the name carries the session and the run beside the pane's own
 * title and an equality check against the title alone would never match.
 */
function requirePaneNamed(container: HTMLElement, paneTitle: string): HTMLElement {
  for (const region of container.querySelectorAll("section[aria-labelledby]")) {
    const labelId = region.getAttribute("aria-labelledby");
    const label = labelId === null ? null : container.querySelector(`#${CSS.escape(labelId)}`);
    const currentCrumb = label?.querySelector(".meridian-pane__heading");
    if (region instanceof HTMLElement && currentCrumb?.textContent === paneTitle) {
      return region;
    }
  }
  throw new Error(`no pane in the mounted tree is on the \`${paneTitle}\` crumb`);
}

/**
 * The screen body the rail holds for a screen name, as a component, or a throw.
 *
 * The pane helper's shape, applied to the other registry: a throw rather than an
 * optional return, so a feature that stopped claiming its screen fails here — where the
 * message names the screen — instead of rendering nothing and letting a tier compare an
 * empty box against a baseline.
 */
async function screenBodyComponent(): Promise<FunctionComponent<{ context: ScreenContext }>> {
  const render = await resolvedScreenBody("workflows", registerWorkflowScreens);
  return ({ context }) => render(context);
}

/**
 * The screen context the rail mounts a destination with.
 *
 * The frame store is put in the state a person arrives in by NAVIGATING — into a
 * session, then to the workflows destination — because retaining the last opened
 * session is the store's own rule and writing the member directly would pin a frame
 * the shipped store could no longer produce. The session-store registry is real and
 * empty: this window has opened nothing, which is the ordinary case for a person who
 * reached the rail from a session the route has since left.
 */
function screenContext(bridge: PlatformBridge): ScreenContext {
  const frameStore = new WindowStore({
    initialRoute: { kind: "session", sessionId: PROBE_SESSION_ID },
  });
  frameStore.navigate({ kind: "workflows" });
  return {
    route: { kind: "workflows" },
    bridge,
    frameStore,
    sessionStore: undefined,
    // The registry hands its fold to every store it opens, so it takes the window's
    // composition for `paneContext`'s reason one screen up — a registry opened with
    // none would give a session this screen navigates into an unprojected store.
    sessionStoreRegistry: new SessionStoreRegistry({
      read: () => Promise.resolve(undefined),
      projectors: COMPOSED_ENTITY_PROJECTORS,
    }),
    // This composition's own board, which is what the screen opens panes out of —
    // the same instance the pane helper above mounts bodies from, so a tier that
    // opens a run from the destination reaches the body this file registered.
    paneRegistry: workflowPaneRegistry(),
    uiStateStore: UiStateStore.opening(),
    draftStore: new DraftStore({ maximumDraftCount: MAXIMUM_LIVE_DRAFT_COUNT }),
    chooseScheme: () => undefined,
  };
}

/**
 * The workflows destination, mounted through the rail's own screen registry.
 *
 * Every workflows mount here renders under the bridge provider, as the running console mounts
 * every body: a pane body reads its bridge off its context, but a screen body is handed only the
 * screen context and reaches the bridge through the provider, so a capture mounted bare would
 * throw where the running console does not.
 *
 * With a session in scope, which is how a person reaches it. The announcer is mounted
 * around it because `useAnnounce` throws outside its provider rather than falling back to
 * a region created at the moment something spoke.
 */
export async function mountWorkflowsDestination(): Promise<MountedView> {
  const fixture = createFixtureBridge({ scenario: unscriptedScenario("workflows-destination") });
  const { bridge } = fixture;
  const WorkflowsDestinationBody = await screenBodyComponent();
  const { container } = await renderSettled(
    <FixtureBridgeProvider fixture={fixture}>
      <LiveAnnouncerProvider>
        <WorkflowsDestinationBody context={screenContext(bridge)} />
      </LiveAnnouncerProvider>
    </FixtureBridgeProvider>,
  );
  const element = container.querySelector<HTMLElement>(".meridian-workflows-destination");
  if (element === null) {
    throw new Error("the workflows destination rendered no root");
  }
  return { element, bridge };
}

/** The run pane addressed at a run, drawing the frame it has without a run read. */
export async function mountWorkflowRunPane(): Promise<MountedView> {
  const fixture = createFixtureBridge({ scenario: unscriptedScenario("workflow-run-pane") });
  const { bridge } = fixture;
  const WorkflowRunPaneBody = await paneBodyComponent("workflow-run");
  const { container } = await renderSettled(
    <FixtureBridgeProvider fixture={fixture}>
      <WorkflowRunPaneBody
        context={paneContext(
          {
            kind: "workflow-run",
            paneId: "pane-workflow-run",
            entity: { kind: "workflow-run", id: PARKED_RUN.workflowRunId },
          },
          bridge,
        )}
      />
    </FixtureBridgeProvider>,
  );
  return { element: requirePaneNamed(container, "Workflow run"), bridge };
}

/**
 * The run's phase graph, drawn from a hand-built run parked on a usage window and on a
 * person's sign-off.
 *
 * The presentational piece alone, because no view composes it until the run read is
 * built. The graph renderer is its own lazily-loaded chunk, so a reader waits on
 * `run-graph-settled.ts` before it reads the picture.
 */
export async function mountWorkflowRunPhaseGraph(): Promise<HTMLElement> {
  const { container } = await renderSettled(<RunGraphSection phases={PARKED_RUN.phaseStates} />);
  return container;
}

/**
 * The builder pane on a definition, which is its one arm that renders a body.
 *
 * ADDRESSED RATHER THAN EMPTY, and that is what makes the mount worth auditing: the
 * unaddressed arm draws a single absence block the frame tier already covers, while
 * this one composes the node graph and the draft regions only this pane has. No wait: this
 * pane puts no read on any arm, so there is nothing in flight to settle.
 */
export async function mountWorkflowBuilderPane(): Promise<MountedView> {
  const fixture = createFixtureBridge({ scenario: unscriptedScenario("workflow-builder-pane") });
  const { bridge } = fixture;
  const WorkflowBuilderPaneBody = await paneBodyComponent("workflow-builder");
  const { container } = await renderSettled(
    <FixtureBridgeProvider fixture={fixture}>
      <WorkflowBuilderPaneBody
        context={paneContext(
          {
            kind: "workflow-builder",
            paneId: "pane-workflow-builder",
            entity: { kind: "workflow-definition", id: definition().id },
          },
          bridge,
        )}
      />
    </FixtureBridgeProvider>,
  );
  return { element: requirePaneNamed(container, "Workflow builder"), bridge };
}
