// The workflows feature's screen and pane, mounted once for the accessibility tier.
//
// The bodies come out of the feature's own registries (`PaneRegistry`, `ScreenRegistry`) after it
// registers into them, so a tier renders what the pane layout and the rail would mount, with the
// feature's stylesheets loaded as in the app. The screen is mounted over the shipped playback,
// whose replies answer on the engine's frozen clock, so a mount moves that clock until every read
// the view puts in flight has answered: the runs list, and a run's page with its graph and the
// step panel it opens on the step waiting on a person.
//
// A pane is a region named by its crumb trail through `aria-labelledby`, so it is found by its
// current crumb. The screen is not a region and is found by its root class.

import type { FunctionComponent } from "react";

import { act } from "@testing-library/react";
import { onTestFinished } from "vitest";

import { renderSettled } from "../../helpers/app/harness.js";
import { crossMacrotaskBoundary } from "../../helpers/macrotask-boundary.js";
import {
  createFixtureBridge,
  type FixtureBridge,
} from "#renderer/services/platform/platform-bridge.fixture.js";
import { type PlatformBridge } from "#renderer/services/platform/platform-bridge.js";
import { unscriptedScenario } from "../../helpers/fixture/bridge.js";
import { FixtureBridgeProvider } from "../../helpers/app/frame-fixtures.js";
import { CONCURRENT_STREAMING_SCENARIO } from "#fixtures/scenarios/concurrent-streaming.js";
import {
  PROBE_SESSION_ID,
  definition,
} from "#renderer/features/workflows/workflows-probe.test-support.js";
import { type AppRoute } from "#renderer/routing/routes.js";
import { type ScreenContext } from "#renderer/registries/screens/screen-context.js";
import { LiveAnnouncerProvider } from "#renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import { MAXIMUM_LIVE_DRAFT_COUNT } from "#renderer/store/persistence/caps.js";
import { DraftStore } from "#renderer/store/draft-store.js";
import { UiStateStore } from "#renderer/store/persistence/ui-state-store.js";
import { WindowStore } from "#renderer/store/window/window-store.js";
import { SessionStore } from "#renderer/store/session/session-store.js";
import { SessionStoreRegistry } from "#renderer/store/session/session-store-registry.js";
import {
  registerWorkflowPanes,
  registerWorkflowScreens,
} from "#renderer/features/workflows/index.js";
import { PaneRegistry } from "#renderer/registries/panes/pane-registry.js";
import { type PaneContext } from "#renderer/registries/panes/pane-context.js";
import { type PaneKind } from "#renderer/routing/panes/pane-kinds.js";
import { paneContext } from "../../helpers/pane-context.js";
import { resolvedPaneBody, resolvedScreenBody } from "./pane-body-resolution.js";
import { COMPOSED_ENTITY_PROJECTORS } from "./projector-composition.js";
import { type MountedView } from "./mount-queries.js";

/** A registry carrying exactly this feature's pane claims, built per call so no state is shared. */
function workflowPaneRegistry(): PaneRegistry {
  const registry = new PaneRegistry();
  registerWorkflowPanes(registry);
  return registry;
}

/**
 * The workflows pane body the pane layout holds for a kind, loaded. The resolution lives in
 * `pane-body-resolution.ts`; this adds the feature's registrar and the `{ context }` prop shape.
 */
async function paneBodyComponent(
  kind: PaneKind,
): Promise<FunctionComponent<{ context: PaneContext }>> {
  const render = await resolvedPaneBody(kind, registerWorkflowPanes);
  return ({ context }) => render(context);
}

/**
 * The session store a workflows pane is bound to, opened with the fold a window composes;
 * without projectors every event folds into no entity.
 */
function probeSessionStore(): SessionStore {
  return new SessionStore({ sessionId: PROBE_SESSION_ID, projectors: COMPOSED_ENTITY_PROJECTORS });
}

/** The UI-state store over the page's database a mount hands its view, closed when the test ends. */
function openUiStateStore(): UiStateStore {
  const store = UiStateStore.opening();
  onTestFinished(async () => store.close());
  return store;
}

/**
 * Find the one region a workflows pane renders as, by its current crumb.
 *
 * It goes through the accessible name, not a class, because that is what assistive technology
 * navigates by. The chrome names a pane by its whole address trail, so the current crumb is
 * compared, not the whole name.
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
 * The screen body the rail holds for the workflows screen, as a component, or a throw.
 *
 * It throws, not returns undefined, so a feature that stopped claiming its screen fails here by
 * name instead of the audit passing over an empty box.
 */
async function screenBodyComponent(): Promise<FunctionComponent<{ context: ScreenContext }>> {
  const render = await resolvedScreenBody("workflows", registerWorkflowScreens);
  return ({ context }) => render(context);
}

/**
 * The screen context the rail mounts the workflows screen with at `route`. The session-store
 * registry is real and empty because this window has opened nothing.
 */
function screenContext(bridge: PlatformBridge, route: AppRoute): ScreenContext {
  return {
    route,
    bridge,
    frameStore: new WindowStore({ initialRoute: route }),
    sessionStore: undefined,
    // The registry hands its fold to every store it opens, so it takes the window's composition.
    sessionStoreRegistry: new SessionStoreRegistry({
      read: () => Promise.resolve(undefined),
      projectors: COMPOSED_ENTITY_PROJECTORS,
    }),
    // The board the screen opens panes from; the pane helper above mounts bodies from the same one.
    paneRegistry: workflowPaneRegistry(),
    uiStateStore: openUiStateStore(),
    draftStore: new DraftStore({ maximumDraftCount: MAXIMUM_LIVE_DRAFT_COUNT }),
    chooseScheme: () => undefined,
  };
}

/** How far the frozen clock moves per round, and how many rounds a chain of reads is given. */
const SETTLE_STEP_MS = 250;
const SETTLE_ROUNDS = 8;

/**
 * Move the playback's clock until every read in flight has answered: a run's page reads the run,
 * then its version chain, then the version, then the form its waiting step holds, each held on
 * the clock until it moves.
 */
async function answerHeldReads(fixture: FixtureBridge): Promise<void> {
  for (let round = 0; round < SETTLE_ROUNDS; round += 1) {
    await act(async () => {
      fixture.scenarioEngine.advance(SETTLE_STEP_MS);
      await crossMacrotaskBoundary();
    });
  }
}

/**
 * The workflows screen at `route` over the shipped playback, through the rail's own screen
 * registry, once every read it puts in flight has answered.
 *
 * It renders under the bridge provider as the running app does: a screen body reaches the
 * bridge through the provider, so a bare mount would throw. The announcer wraps it because
 * `useAnnounce` throws outside its provider.
 */
async function mountWorkflowsScreenAt(route: AppRoute): Promise<MountedView> {
  const fixture = createFixtureBridge({ scenario: CONCURRENT_STREAMING_SCENARIO });
  const { bridge } = fixture;
  const WorkflowsScreenBody = await screenBodyComponent();
  const { container } = await renderSettled(
    <FixtureBridgeProvider fixture={fixture}>
      <LiveAnnouncerProvider>
        <WorkflowsScreenBody context={screenContext(bridge, route)} />
      </LiveAnnouncerProvider>
    </FixtureBridgeProvider>,
  );
  await answerHeldReads(fixture);
  const element = container.querySelector<HTMLElement>(".meridian-workflows-destination");
  if (element === null) {
    throw new Error("the workflows screen rendered no root");
  }
  return { element, bridge };
}

/** The Runs tab: the attention list, the filters and the runs table, all read. */
export async function mountWorkflowRunsTab(): Promise<MountedView> {
  return mountWorkflowsScreenAt({ kind: "workflows", tab: "runs" });
}

/**
 * One run's page: its header, its graph and, where the run waits on a person, the step panel
 * open on the waiting step.
 *
 * The graph renderer is a lazily loaded chunk, so a reader waits on `run-graph-settled.ts`
 * before it reads the picture.
 */
export async function mountWorkflowRunPage(workflowRunId: string): Promise<MountedView> {
  return mountWorkflowsScreenAt({ kind: "workflows", tab: "runs", runId: workflowRunId });
}

/**
 * The builder pane on a definition, the one arm that renders a body.
 *
 * Addressed rather than empty: the unaddressed arm draws one empty-state block, while this one
 * composes the node graph and draft regions. It needs no wait
 * because the pane puts no read in flight.
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
            entity: { kind: "workflow-definition", id: definition().id },
          },
          {
            paneId: "pane-workflow-builder",
            bridge,
            sessionStore: probeSessionStore(),
            // The builder hands its canvas the UI-state store, node layout's home, so it answers.
            uiStateStore: openUiStateStore(),
          },
        )}
      />
    </FixtureBridgeProvider>,
  );
  return { element: requirePaneNamed(container, "Workflow builder"), bridge };
}
