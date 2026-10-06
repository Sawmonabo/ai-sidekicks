// The workflows screen mounted under the window store's route, so a press that navigates (opening
// a run, the run page reporting a run the daemon lacks) moves the screen the way it moves in the
// app. A suite about the router hands in its own mount. It runs over the shipped playback, whose
// replies answer on the engine's frozen clock, with the daemon calls recorded.

import { act, fireEvent, render, screen } from "@testing-library/react";

import type {
  WorkflowRunAttentionEntry,
  WorkflowRunAttentionListResponse,
} from "@ai-sidekicks/contracts/workflow/run/records";

import { bridgeWrapper } from "#test/helpers/app/frame-fixtures.js";
import {
  bridgeAnswering,
  withDaemonSubscribe,
  type RecordedDaemonCall,
} from "#test/helpers/fixture/bridge.js";
import { crossMacrotaskBoundary } from "#test/helpers/macrotask-boundary.js";
import { LiveAnnouncerProvider } from "#renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import { PaneRegistry } from "#renderer/registries/panes/registry.js";
import type { ScreenContext } from "#renderer/registries/screens/context.js";
import { workflowRunsRoute } from "#renderer/routing/readers.js";
import type { AppRoute } from "#renderer/routing/routes.js";
import type { ScenarioEngine } from "#renderer/services/daemon/engine.fixture.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import { DraftStore } from "#renderer/store/drafts.js";
import { MemoryPersistenceAdapter } from "#renderer/store/persistence/memory-adapter.js";
import { UiStateStore } from "#renderer/store/persistence/ui-state-store.js";
import { MAXIMUM_LIVE_DRAFT_COUNT } from "#renderer/store/persistence/caps.js";
import { SessionStoreRegistry } from "#renderer/store/session/registry.js";
import { useWindowStore } from "#renderer/store/window/hooks/useWindowStore.js";
import { WindowStore } from "#renderer/store/window/store.js";
import { createWorkflowCommandTargets, type WorkflowCommandTargets } from "./command-target.js";
import { WorkflowsScreen } from "./WorkflowsScreen.js";

/**
 * A mounted workflows screen: the window store it routes by, what it asked the daemon, the bridge
 * it asks through, which another view of the same daemon (a session's card) may use too, and
 * the keyed acts it offers, which a chord presses.
 */
export interface MountedWorkflowsScreen {
  readonly frameStore: WindowStore;
  readonly commandTargets: WorkflowCommandTargets;
  readonly bridge: PlatformBridge;
  readonly calls: readonly RecordedDaemonCall[];
  readonly engine: ScenarioEngine;
  readonly unmount: () => void;
}

/** What a case mounts the screen with; everything left out takes the playback's own answer. */
export interface WorkflowsScreenMountOptions {
  readonly route: AppRoute;
  /** The store the filters are kept in; a fresh in-memory one when left out. */
  readonly uiStateStore?: UiStateStore;
  /** Decides one call's answer; the rest pass through to the playback. */
  readonly answer?: (
    call: RecordedDaemonCall,
    passThrough: () => Promise<unknown>,
  ) => Promise<unknown>;
  /** What draws the screen at the window's route; the screen itself when left out. */
  readonly mount?: (context: ScreenContext) => React.ReactNode;
  /** Decides how a stream opens and ends; every stream plays the scenario's when left out. */
  readonly openStream?: Parameters<typeof withDaemonSubscribe>[1];
}

/** Mount the workflows screen at `route`; the reads have not answered yet. */
export async function mountWorkflowsScreen(
  options: WorkflowsScreenMountOptions,
): Promise<MountedWorkflowsScreen> {
  const answering = bridgeAnswering(
    options.answer ?? (async (_call, passThrough) => passThrough()),
  );
  const { calls, engine } = answering;
  const bridge =
    options.openStream === undefined
      ? answering.bridge
      : withDaemonSubscribe(answering.bridge, options.openStream);
  const frameStore = new WindowStore({ initialRoute: options.route });
  const commandTargets = createWorkflowCommandTargets();
  const context: Omit<ScreenContext, "route"> = {
    bridge,
    frameStore,
    sessionStore: undefined,
    sessionStoreRegistry: new SessionStoreRegistry({
      read: () => Promise.resolve(undefined),
      projectors: {},
    }),
    paneRegistry: new PaneRegistry(),
    uiStateStore:
      options.uiStateStore ?? new UiStateStore({ adapter: new MemoryPersistenceAdapter() }),
    draftStore: new DraftStore({ maximumDraftCount: MAXIMUM_LIVE_DRAFT_COUNT }),
    chooseScheme: () => undefined,
  };
  const Host = bridgeWrapper(bridge, engine.clock);
  let unmount: () => void = () => undefined;
  await act(async () => {
    unmount = render(
      <Host>
        <LiveAnnouncerProvider>
          <RoutedScreen
            context={context}
            mount={
              options.mount ??
              ((routed) => <WorkflowsScreen context={routed} commandTargets={commandTargets} />)
            }
          />
        </LiveAnnouncerProvider>
      </Host>,
    ).unmount;
    await crossMacrotaskBoundary();
  });
  return { frameStore, commandTargets, bridge, calls, engine, unmount };
}

/** Move the window to `route` the way a link on the screen does. */
export async function navigate(
  mounted: MountedWorkflowsScreen,
  route: AppRoute = workflowRunsRoute(undefined),
): Promise<void> {
  await act(async () => {
    mounted.frameStore.navigate(route);
    await crossMacrotaskBoundary();
  });
}

/** Press a button by its accessible name, and let React finish reacting. */
export async function press(name: string | RegExp): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
    await crossMacrotaskBoundary();
  });
}

/** The strip's `Next waiting` control, whatever it reads. */
export function nextWaitingControl(): HTMLButtonElement {
  return screen.getByRole<HTMLButtonElement>("button", {
    name: /^(Next waiting|Nothing waiting)/u,
  });
}

/**
 * Whether a call is one of the runs table's reads rather than the tab count's: the table always
 * asks within a date range, the count under no filter at all.
 */
export function isRunsTableRead(call: RecordedDaemonCall): boolean {
  return (
    call.method === "workflow.runList" &&
    (call.params as { readonly startedAfter?: string }).startedAfter !== undefined
  );
}

/** The run a screen's window has open, or `undefined` on the list. */
export function openRunId(mounted: MountedWorkflowsScreen): string | undefined {
  const { route } = mounted.frameStore.getState();
  return route.kind === "workflows" && route.tab === "runs" ? route.runId : undefined;
}

/** An attention answer holding only the run lines for `workflowRunIds`, in that order. */
export function attentionOf(
  reply: unknown,
  workflowRunIds: readonly string[],
): WorkflowRunAttentionListResponse {
  const entries = (reply as WorkflowRunAttentionListResponse).entries;
  const kept = workflowRunIds.flatMap((workflowRunId): WorkflowRunAttentionEntry[] =>
    entries.filter((entry) => entry.kind === "run" && entry.workflowRunId === workflowRunId),
  );
  return { entries: kept, waitingOnPersonCount: kept.length };
}

/** The mount under the window store's route, as the window frame composes it. */
function RoutedScreen(props: {
  readonly context: Omit<ScreenContext, "route">;
  readonly mount: (context: ScreenContext) => React.ReactNode;
}): React.ReactNode {
  const route = useWindowStore(props.context.frameStore, (state) => state.route);
  return props.mount({ ...props.context, route });
}
