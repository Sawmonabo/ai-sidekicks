// The composer family's surfaces, mounted once for the two tiers that look at them.
//
// Not a test file — no `include` glob reaches it as one. It lives under `surfaces/`
// rather than beside the tier harnesses, because the two tiers that mount it are two
// directories and a module named for one family belongs in the directory that holds
// the family mounts, not in the drawer that holds everything. The screenshot tier and the
// accessibility tier need the same compositions, and a per-tier copy of the mount
// would be two chances to compose them differently and then read the results as if
// they were comparable. `console-harness.tsx` owns HOW the console is mounted, one
// level down; this owns WHAT of this family is mounted into it.
//
// THE FOUR COMPOSER STATES ARE ADDRESSES, NOT VARIANTS. `chip-models.ts` resolves
// the send path from the FOCUSED PANE and the session store's own partitions, so
// the composer has no state to be put into — it has an address to be read at. The
// four below are therefore four `focusedPane` values (and, for the two provider-
// bound ones, two different prefixes of the same scenario log), which is why they
// share one store builder and differ in one argument each:
//
//   • the channel path with the session's own default, which is what a composer
//     addresses when focus is not in the deck;
//   • the channel path addressed at a named channel;
//   • the provider-bound path with the run still `running`;
//   • the provider-bound path with the run `waiting_for_input`, which is where the
//     composer scenario ends and the one state the design calls "steer".
//
// THE RUN PARTITION IS THE REAL ONE. The store is fed the scenario's own beats
// through `RUN_LIFECYCLE_PROJECTORS` — the registry the window's composition root
// registers — so the run these surfaces resolve against is the run the fixture
// actually plays, and a change to the projector reaches these tiers rather than
// passing them. The agent partition has no projector on this branch, so the target
// chip renders the binding it could not read as an absence; that is the family's
// own wire-true state and not a gap in this mount.

import type { FunctionComponent } from "react";

import { act } from "@testing-library/react";

import { renderSettled } from "../console-harness.js";

import { APPROVALS_SCENARIO } from "../../../src/renderer/src/console/bridge/scenarios/approvals.js";
import { COMPOSER_SCENARIO } from "../../../src/renderer/src/console/bridge/scenarios/composer.js";
import { RUNS_SCENARIO } from "../../../src/renderer/src/console/bridge/scenarios/runs.js";
import { REFRESH_DEBOUNCE_MS } from "../../../src/renderer/src/console/core/index.js";
import {
  createFixtureBridge,
  type ConsoleBridge,
} from "../../../src/renderer/src/console/bridge/index.js";
// Deep-imported rather than taken off the frame barrel, which does not publish it:
// it is the registry the window's own composition root registers, and a test that
// built its own would be projecting the run partition a second way.
import { RUN_LIFECYCLE_PROJECTORS } from "../../../src/renderer/src/console/frame/run-lifecycle-projector.js";
import { DraftStore, UiStateStore } from "../../../src/renderer/src/console/persistence/index.js";
import {
  FrameStore,
  SessionStore,
  type ConsoleSessionEvent,
} from "../../../src/renderer/src/console/store/index.js";
import { MessageComposer } from "../../../src/renderer/src/shell/MessageComposer.js";
import { registerApprovalsPane } from "../../../src/renderer/src/console/panes/approvals/index.js";
import { registerApprovalFlowProjectors } from "../../../src/renderer/src/console/bridge/index.js";
import { registerRunsPane } from "../../../src/renderer/src/console/panes/runs/index.js";
import { ConsoleEntityProjectorRegistry } from "../../../src/renderer/src/console/store/index.js";
import {
  ConsolePaneRegistry,
  type ConsolePaneAddress,
  type ConsolePaneContext,
  type PaneKind,
} from "../../../src/renderer/src/console/seats/index.js";

/** The element a tier reads, and the bridge it was mounted against. */
export interface MountedFamilySurface {
  readonly element: HTMLElement;
  readonly bridge: ConsoleBridge;
}

/**
 * The composer scenario's own agent, read out of the log rather than restated.
 *
 * A second copy of the UUID here would be a constant that agrees with the scenario
 * only by discipline, and the day the scenario's agent changed this mount would go
 * on addressing an agent nobody attached — resolving the channel path and capturing
 * a baseline of the wrong composition under the provider-bound name.
 */
function composerAgentId(): string {
  const attached = COMPOSER_SCENARIO.beats.find((beat) => beat.event.kind === "agent.attached");
  const agentId = attached?.event.payload?.["agentId"];
  if (typeof agentId !== "string") {
    throw new Error("the composer scenario attaches no agent, so no provider-bound address exists");
  }
  return agentId;
}

/**
 * A store holding the scenario's beats up to and including the named kind.
 *
 * A PREFIX rather than the whole log, because the two provider-bound surfaces differ
 * only in how far the run has got: feeding both the whole log would capture the same
 * composition twice under two names and report the pair as covering two states.
 */
function composerSessionStore(throughKind: string): SessionStore {
  const store = new SessionStore({
    sessionId: COMPOSER_SCENARIO.sessionId,
    projectors: RUN_LIFECYCLE_PROJECTORS,
  });
  store.initialise({ cursor: 0, entities: [], participantJoinLog: [] });
  const lastIndex = COMPOSER_SCENARIO.beats.findLastIndex(
    (beat) => beat.event.kind === throughKind,
  );
  if (lastIndex < 0) {
    throw new Error(`the composer scenario plays no \`${throughKind}\` beat`);
  }
  store.applyBatch(
    COMPOSER_SCENARIO.beats
      .slice(0, lastIndex + 1)
      .map((beat) => beat.event as ConsoleSessionEvent),
  );
  return store;
}

/** Mount the composer at one address, over a store fed to one point in the log. */
async function mountComposerAt(options: {
  readonly throughKind: string;
  readonly focusedPane: ConsolePaneAddress | undefined;
}): Promise<MountedFamilySurface> {
  const bridge = createFixtureBridge({ scenario: COMPOSER_SCENARIO });
  const { container } = await renderSettled(
    <MessageComposer
      sessionStore={composerSessionStore(options.throughKind)}
      bridge={bridge}
      draftStore={new DraftStore()}
      route={{ kind: "workspace", sessionId: COMPOSER_SCENARIO.sessionId }}
      focusedPane={options.focusedPane}
    />,
  );
  return { element: requireRegion(container, "Message composer"), bridge };
}

/** The composer with focus outside the deck: the session's own default channel. */
export async function mountComposerChannelDefault(): Promise<MountedFamilySurface> {
  return mountComposerAt({ throughKind: "run.running", focusedPane: undefined });
}

/** The composer addressed at a named channel rather than at the session default. */
export async function mountComposerChannelAddressed(): Promise<MountedFamilySurface> {
  return mountComposerAt({
    throughKind: "run.running",
    focusedPane: {
      kind: "timeline",
      // A channel the store holds no entity for, which is the ordinary case on this
      // branch: no channel projector is registered, so the chip states that it read
      // no label for the channel it is addressed at. It neither invents a label nor
      // prints the id, and — the reason this surface is pinned beside the default
      // one — it does not fall through to the words the unaddressed arm uses.
      entity: { kind: "channel", id: `${COMPOSER_SCENARIO.sessionId}-main` },
    },
  });
}

/** The composer addressed at a working run: the new-turn path against a live agent. */
export async function mountComposerProviderBoundRunning(): Promise<MountedFamilySurface> {
  return mountComposerAt({
    throughKind: "run.running",
    focusedPane: { kind: "agent-console", entity: { kind: "agent", id: composerAgentId() } },
  });
}

/** The composer addressed at a run waiting on a person: the steer path. */
export async function mountComposerProviderBoundWaiting(): Promise<MountedFamilySurface> {
  return mountComposerAt({
    throughKind: "run.waiting_for_input",
    focusedPane: { kind: "agent-console", entity: { kind: "agent", id: composerAgentId() } },
  });
}

/**
 * The runs pane, mounted out of the deck's registry rather than by importing its body.
 *
 * A tier that imported the component would capture a component that happens to sit
 * beside the registration; this captures the body the deck would actually mount, and
 * the family's stylesheet arrives on the barrel edge that owns it — which is what
 * makes the captured pixels the ones a person would see.
 */
export async function mountRunsPane(): Promise<MountedFamilySurface> {
  const bridge = createFixtureBridge({ scenario: RUNS_SCENARIO });
  const RunsPaneBody = paneBodyComponent("runs", registerRunsPane);
  const { container } = await renderSettled(
    <RunsPaneBody
      kind="runs"
      paneId="pane-runs-surface"
      linkedSourcePaneId={undefined}
      bridge={bridge}
      sessionStore={new SessionStore({ sessionId: RUNS_SCENARIO.sessionId })}
      frameStore={new FrameStore()}
      uiStateStore={UiStateStore.opening()}
      draftStore={new DraftStore()}
      focusHue={undefined}
    />,
  );
  const pane = container.querySelector(".meridian-runs");
  if (!(pane instanceof HTMLElement)) {
    throw new Error("the runs pane rendered no .meridian-runs element to capture");
  }
  // By class rather than by accessible name, and the exception is worth stating: the
  // pane's own root is a layout container and the accessible names inside it belong
  // to its three sections, so there is no one labelled element that IS the pane. The
  // sections' names are what the accessibility tier then audits.
  return { element: pane, bridge };
}

/**
 * The approvals pane, over a store opened with the fold the composer family claims.
 *
 * THE APPROVAL PARTITION IS THE REAL ONE, for the reason the run partition above is:
 * the store is fed the scenario's own beats through `APPROVAL_FLOW_PROJECTORS` — the
 * table `registerComposerFamily` registers — so the provider-ask framing these tiers
 * capture is the one a person would see, and a change to the projector reaches them
 * rather than passing them.
 *
 * The clock is advanced after the mount because this pane READS: its two reads settle
 * through the console's one refresh scheduler, and a capture taken before that
 * deadline would photograph the in-flight phase under a name that claims to be the
 * answered one.
 */
export async function mountApprovalsPane(): Promise<MountedFamilySurface> {
  const bridge = createFixtureBridge({ scenario: APPROVALS_SCENARIO });
  const projectorRegistry = new ConsoleEntityProjectorRegistry();
  registerApprovalFlowProjectors(projectorRegistry);
  const sessionStore = new SessionStore({
    sessionId: APPROVALS_SCENARIO.sessionId,
    projectors: projectorRegistry.snapshot(),
  });
  const sequences = APPROVALS_SCENARIO.beats.map((beat) => beat.event.sequence);
  sessionStore.initialise({
    cursor: Math.min(...sequences) - 1,
    entities: [],
    participantJoinLog: [...APPROVALS_SCENARIO.participantIdsInJoinOrder],
  });
  sessionStore.applyBatch(
    APPROVALS_SCENARIO.beats.map((beat) => beat.event as ConsoleSessionEvent),
  );

  const ApprovalsPaneBody = paneBodyComponent("approvals", registerApprovalsPane);
  const { container } = await renderSettled(
    <ApprovalsPaneBody
      kind="approvals"
      paneId="pane-approvals-surface"
      linkedSourcePaneId={undefined}
      bridge={bridge}
      sessionStore={sessionStore}
      frameStore={new FrameStore()}
      uiStateStore={UiStateStore.opening()}
      draftStore={new DraftStore()}
      focusHue={undefined}
    />,
  );
  await act(async () => {
    bridge.scenarioEngine?.advance(REFRESH_DEBOUNCE_MS);
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  const pane = container.querySelector(".meridian-approvals");
  if (!(pane instanceof HTMLElement)) {
    throw new Error("the approvals pane rendered no .meridian-approvals element to capture");
  }
  // By class rather than by accessible name, for `mountRunsPane`'s reason: the pane
  // root is a layout container and the accessible names inside it belong to its
  // sections.
  return { element: pane, bridge };
}

/**
 * The pane body the deck holds for a kind, as a component, or a throw.
 *
 * A throw rather than an optional return, so a family that stopped registering its
 * kind fails here — where the message names the kind — instead of rendering nothing
 * and letting a tier compare an empty box against a baseline. The descriptor's
 * `render` is handed back for React to MOUNT rather than called here: the body holds
 * hooks, and a plain call outside a render would run them against no dispatcher.
 */
function paneBodyComponent(
  kind: PaneKind,
  registerPane: (registry: ConsolePaneRegistry) => void,
): FunctionComponent<ConsolePaneContext> {
  // Built per call rather than shared: the registry is owner-scoped state, and two
  // tiers holding one instance would make the second tier's mount depend on whether
  // the first had run. The family's own registrar is passed in rather than every
  // family being registered here, so a mount composes the one body it captures.
  const registry = new ConsolePaneRegistry();
  registerPane(registry);
  const descriptor = registry.descriptorFor(kind);
  if (descriptor === undefined) {
    throw new Error(`no console pane is registered for the \`${kind}\` kind`);
  }
  return descriptor.render;
}

/**
 * Find the one element a surface renders itself as.
 *
 * Scoped by accessible name rather than by class, because that is what a person
 * using assistive technology navigates by — a surface that lost its accessible name
 * would still match a class selector and would still be captured as if nothing had
 * changed.
 */
function requireRegion(container: HTMLElement, accessibleName: string): HTMLElement {
  const region = container.querySelector(`[aria-label="${accessibleName}"]`);
  if (!(region instanceof HTMLElement)) {
    throw new Error(`nothing in the mounted tree is labelled \`${accessibleName}\``);
  }
  return region;
}
