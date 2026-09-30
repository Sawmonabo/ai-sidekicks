// The workflows feature's screen and panes, mounted once for the screenshot and accessibility
// tiers.
//
// The bodies come out of the feature's own registries (`PaneRegistry`, `ScreenRegistry`) after it
// registers into them, so a tier renders what the pane layout and the rail would mount, with the
// feature's stylesheets loaded as in the app. Each view draws what it has with no run or
// definition read. The run's phase graph is mounted alone, from a hand-built run, because no
// view composes it yet.
//
// The destination is mounted with a session in scope by navigating into a session and then to
// workflows: the window store's retention of the last opened session is its own rule, and
// writing the field directly could pin a frame the store cannot produce.
//
// A pane is a region named by its crumb trail through `aria-labelledby`, so it is found by its
// current crumb. The destination is not a region and is found by its root class.

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
import { type ScreenContext } from "@renderer/registries/screens/screen-context.js";
import { LiveAnnouncerProvider } from "@renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
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
import { PaneRegistry } from "@renderer/registries/panes/pane-registry.js";
import { type PaneAddress } from "@renderer/routing/panes/pane-address.js";
import { type PaneContext } from "@renderer/registries/panes/pane-context.js";
import { type PaneKind } from "@renderer/routing/panes/pane-kinds.js";
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
 * The pane layout context a pane is mounted with, minus what each caller supplies.
 *
 * The caller passes the address union, not a `Pick`: `entity` is not a key every arm has, and
 * the union stops a tier mounting a workflow pane over an entity kind the registry refuses.
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
    linkedSourcePaneId: undefined,
    bridge,
    // Opened with the fold a window composes; without projectors every event folds into no entity.
    sessionStore: new SessionStore({
      sessionId: PROBE_SESSION_ID,
      projectors: COMPOSED_ENTITY_PROJECTORS,
    }),
  };
}

/**
 * Find the one region a workflows pane renders as, by its current crumb.
 *
 * It goes through the accessible name, not a class, because that is what assistive technology
 * navigates by. The chrome names a pane by its whole address trail, so the current crumb is
 * compared, not the whole name. The label is resolved from the container, so two panes sharing
 * an id throw instead of returning the first one twice.
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
 * name instead of a tier comparing an empty box against a baseline.
 */
async function screenBodyComponent(): Promise<FunctionComponent<{ context: ScreenContext }>> {
  const render = await resolvedScreenBody("workflows", registerWorkflowScreens);
  return ({ context }) => render(context);
}

/**
 * The screen context the rail mounts a destination with. The frame store is put in the state a
 * person arrives in by navigating into a session and then to workflows; the session-store
 * registry is real and empty because this window has opened nothing.
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
    // The registry hands its fold to every store it opens, so it takes the window's composition.
    sessionStoreRegistry: new SessionStoreRegistry({
      read: () => Promise.resolve(undefined),
      projectors: COMPOSED_ENTITY_PROJECTORS,
    }),
    // The board the screen opens panes from; the pane helper above mounts bodies from the same one.
    paneRegistry: workflowPaneRegistry(),
    uiStateStore: UiStateStore.opening(),
    draftStore: new DraftStore({ maximumDraftCount: MAXIMUM_LIVE_DRAFT_COUNT }),
    chooseScheme: () => undefined,
  };
}

/**
 * The workflows destination, mounted through the rail's own screen registry with a session in
 * scope.
 *
 * It renders under the bridge provider as the running console does: a screen body reaches the
 * bridge through the provider, so a bare mount would throw. The announcer wraps it because
 * `useAnnounce` throws outside its provider.
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
 * The run's phase graph, drawn from a hand-built run parked on a usage window and on a person's
 * sign-off.
 *
 * The graph renderer is a lazily loaded chunk, so a reader waits on `run-graph-settled.ts`
 * before it reads the picture.
 */
export async function mountWorkflowRunPhaseGraph(): Promise<HTMLElement> {
  const { container } = await renderSettled(<RunGraphSection phases={PARKED_RUN.phaseStates} />);
  return container;
}

/**
 * The builder pane on a definition, the one arm that renders a body.
 *
 * Addressed rather than empty: the unaddressed arm draws one absence block the frame tier
 * already covers, while this one composes the node graph and draft regions. It needs no wait
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
