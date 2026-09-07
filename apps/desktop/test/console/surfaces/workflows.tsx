// The workflows family's surfaces, mounted once for the two tiers that look at them.
//
// Not a test file — no `include` glob reaches it. The screenshot tier and the
// accessibility tier need the surfaces this family ships, and a per-tier copy of the
// mount would be two chances to compose them differently and then read the results as
// if they were comparable. `console-harness.tsx` owns HOW the console is mounted, one
// level down; this module owns WHAT of this family is mounted into it.
//
// ONE FILE PER FAMILY, UNDER `test/console/surfaces/`. The tier root holds the roles
// every tier reaches for — the harness, the graph-readiness wait, the source walk —
// and a mount that is one family's is not one of them. Seven families each dropping a
// `<family>-surfaces.tsx` beside those would bury the shared set in the family set,
// and a reader looking for what a tier can reuse would have to know the difference by
// name. The directory is the difference, and it scales.
//
// THREE MOUNTS, AND THE TWO TIERS TAKE DIFFERENT SUBSETS. The family registers one
// rail destination and TWO pane kinds, so all three are mounted here. The
// accessibility tier audits every one of them — a family-wide claim that skipped a
// registered pane could not fail on a regression unique to it. The screenshot tier
// pins its own subset, which is a separate judgement about which COMPOSITIONS a
// committed image is worth holding still, made in that tier's own table.
//
// THE BODIES COME OUT OF THE FAMILY'S REGISTRIES, NOT OUT OF AN IMPORT, on the
// browser-terminal tiers' precedent: the run pane is resolved through
// `ConsolePaneRegistry` and the destination through `ConsoleSurfaceRegistry`, each
// after the family registers into it — so a tier renders what the deck and the rail
// would actually mount rather than a component that happens to sit beside them, and
// the family's stylesheets arrive on the edges its own modules already own, which is
// what makes the captured pixels the ones a person would see.
//
// THE DESTINATION IS MOUNTED WITH A SESSION IN SCOPE, WHICH IS HOW A PERSON REACHES
// IT. `#/workflows` is a bare route and the definition enumeration's request carries
// a required session id, so the surface resolves its subject from the session this
// window last opened. The frame store below is put in that state by NAVIGATING —
// into a session and then to the workflows destination — rather than by setting the
// field, because that retention is the store's own rule and a tier that wrote the
// member directly would pin a frame the shipped store could no longer produce.
//
// BOTH SURFACES ARE DRIVEN BY THE SCENARIO AND NOT BY HAND-BUILT ROWS. The workflows
// scenario scripts the definition enumeration and the run read, and the fixture
// growth port answers both from it — so the destination shows the definitions a
// daemon would have listed, and the run pane shows the run that fixture's own header
// calls the parked one: two park kinds at once, one with an armed resume and one
// without, which is the pair a park banner most easily conflates and therefore the
// frame worth pinning.
//
// WHY EACH SURFACE IS FOUND A DIFFERENT WAY. Each pane IS one region, and
// `seats/ConsolePaneChrome` names it with `aria-labelledby` pointing at the crumb
// TRAIL rather than at a heading — so a pane's accessible name is its whole address
// ("session-1 run-01 Workflow run") and two panes of one kind in one deck are told
// apart by what they are scoped to. That is why the lookup below reads the trail's
// current crumb rather than comparing the whole name: an exact match against
// "Workflow run" was correct while this family drew its own heading and is wrong the
// moment a pane is named by where it is. The destination is not a region at all: it
// is a composition of the scope line, the named browser region, and whatever sections
// stand beside it, so an accessible-name lookup would return one of its parts and a
// tier would capture a fragment of the surface. It is addressed by its own root
// instead.

import { waitFor } from "@testing-library/react";
import type { FunctionComponent } from "react";

import { renderSettled } from "../console-harness.js";

import {
  createFixtureBridge,
  type ConsoleBridge,
} from "../../../src/renderer/src/console/bridge/index.js";
import { WORKFLOWS_SCENARIO } from "../../../src/renderer/src/console/bridge/scenarios/workflows.js";
import { WORKFLOWS_SCENARIO_DEFINITIONS } from "../../../src/renderer/src/console/bridge/scenarios/workflow-fixture-definitions.js";
import { WORKFLOWS_SESSION_ID } from "../../../src/renderer/src/console/bridge/scenarios/workflow-fixture-ids.js";
import { WORKFLOWS_PARKED_RUN } from "../../../src/renderer/src/console/bridge/scenarios/workflow-fixture-runs.js";
// The context comes off its own module: it was hoisted out of the board to break the
// cycle a loader-backed surface's reserved frame would otherwise close.
import { type ConsoleSurfaceContext } from "../../../src/renderer/src/console/seats/surface-context.js";
import { LiveAnnouncerProvider } from "../../../src/renderer/src/console/primitives/index.js";
import { MAXIMUM_LIVE_DRAFT_COUNT } from "../../../src/renderer/src/console/core/index.js";
import { DraftStore, UiStateStore } from "../../../src/renderer/src/console/persistence/index.js";
import {
  FrameStore,
  SessionStore,
  SessionStoreRegistry,
} from "../../../src/renderer/src/console/store/index.js";
import {
  registerWorkflowPanes,
  registerWorkflowSurfaces,
} from "../../../src/renderer/src/console/workflows/index.js";
import {
  ConsolePaneRegistry,
  type ConsolePaneAddress,
  type ConsolePaneContext,
  type PaneKind,
} from "../../../src/renderer/src/console/seats/index.js";
import { resolvedPaneBody, resolvedSurfaceBody } from "./pane-body-resolution.js";

/**
 * A registry carrying exactly this family's two claims.
 *
 * Built per call rather than shared: the registry is owner-scoped state, and two
 * tiers holding one instance would make the second tier's mount depend on whether
 * the first had run.
 */
function familyPaneRegistry(): ConsolePaneRegistry {
  const registry = new ConsolePaneRegistry();
  registerWorkflowPanes(registry);
  return registry;
}

/**
 * The workflows pane body the deck holds for a kind, loaded.
 *
 * The resolution — build a family-scoped registry, preload, read the descriptor, throw
 * by name — lives once in `test/console/surfaces/pane-body-resolution.ts`; what stays here is
 * this family's registrar and the `{ context }` prop shape its mounts below render with.
 */
async function paneBodyComponent(
  kind: PaneKind,
): Promise<FunctionComponent<{ context: ConsolePaneContext }>> {
  const render = await resolvedPaneBody(kind, registerWorkflowPanes);
  return ({ context }) => render(context);
}

/**
 * The deck context a pane is mounted with, minus the parts each caller supplies.
 *
 * The caller supplies the ADDRESS and the pane id, not a `Pick` of the context: the
 * address is a kind-scoped union, so `entity` is not a key every arm has and a `Pick`
 * naming it does not resolve. Taking the union itself is also the stronger claim —
 * a tier cannot mount a workflow pane over an entity kind the seat refuses.
 */
function paneContext(
  address: ConsolePaneAddress & { readonly paneId: string },
  bridge: ConsoleBridge,
): ConsolePaneContext {
  return {
    ...address,
    frameStore: new FrameStore(),
    uiStateStore: UiStateStore.opening(),
    draftStore: new DraftStore({ maximumDraftCount: MAXIMUM_LIVE_DRAFT_COUNT }),
    // Nothing opened these panes from another: each tier mounts one body directly.
    linkedSourcePaneId: undefined,
    focusHue: undefined,
    bridge,
    sessionStore: new SessionStore({ sessionId: WORKFLOWS_SESSION_ID }),
  };
}

/** The element a tier reads, and the bridge it was mounted against. */
export interface MountedFamilySurface {
  readonly element: HTMLElement;
  readonly bridge: ConsoleBridge;
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
 * The surface body the rail holds for a slot, as a component, or a throw.
 *
 * The pane helper's shape, applied to the other registry: a throw rather than an
 * optional return, so a family that stopped claiming its slot fails here — where the
 * message names the slot — instead of rendering nothing and letting a tier compare an
 * empty box against a baseline.
 */
async function surfaceBodyComponent(): Promise<
  FunctionComponent<{ context: ConsoleSurfaceContext }>
> {
  const render = await resolvedSurfaceBody("workflows", registerWorkflowSurfaces);
  return ({ context }) => render(context);
}

/**
 * The surface context the rail mounts a destination with.
 *
 * The frame store is put in the state a person arrives in by NAVIGATING — into a
 * session, then to the workflows destination — because retaining the last opened
 * session is the store's own rule and writing the member directly would pin a frame
 * the shipped store could no longer produce. The session-store registry is real and
 * empty: this window has opened nothing, which is the ordinary case for a person who
 * reached the rail from a session the route has since left.
 */
function surfaceContext(bridge: ConsoleBridge): ConsoleSurfaceContext {
  const frameStore = new FrameStore({
    initialRoute: { kind: "workspace", sessionId: WORKFLOWS_SESSION_ID },
  });
  frameStore.navigate({ kind: "workflows" });
  return {
    route: { kind: "workflows" },
    bridge,
    frameStore,
    sessionStore: undefined,
    sessionStoreRegistry: new SessionStoreRegistry({ read: () => Promise.resolve(undefined) }),
    // This composition's own board, which is what the surface opens panes out of —
    // the same instance the pane helper above mounts bodies from, so a tier that
    // opens a run from the destination reaches the body this file registered.
    paneRegistry: familyPaneRegistry(),
    uiStateStore: UiStateStore.opening(),
    draftStore: new DraftStore({ maximumDraftCount: MAXIMUM_LIVE_DRAFT_COUNT }),
  };
}

/**
 * The workflows destination, mounted and waited on until its rows have landed.
 *
 * Through the rail's own surface seat, with a session in scope — which is how a
 * person reaches it, and what the definition enumeration's request requires. The
 * announcer is mounted around it because the surface announces the scope it settled
 * on, and `useAnnounce` throws outside its provider rather than falling back to a
 * region created at the moment something spoke.
 *
 * The wait is the difference between a surface and its empty state: the read crosses
 * a promise, so a tier reading straight after the mount would pin three empty groups
 * and compare them against a baseline of the populated list on the next warm run.
 *
 * BOTH READS, because the element this returns holds both. The destination composes
 * the definitions browser AND `WorkflowRuns`, whose own `workflowRunList` read is a
 * second, independent promise with no wait of its own — so a helper that waited on
 * `.meridian-definition-row` alone handed the screenshot and accessibility tiers a
 * surface holding `Reading this session's runs.` in place of four run rows, three park
 * badges, a frozen-pin chip and the summary counts. The two settle in dispatch order
 * today, which is ordering luck rather than a guarantee, and is the same class of luck
 * `phase-graph-settled.ts` was written to remove for the graph chunk.
 */
export async function mountWorkflowsDestination(): Promise<MountedFamilySurface> {
  const bridge = createFixtureBridge({ scenario: WORKFLOWS_SCENARIO });
  const WorkflowsDestinationBody = await surfaceBodyComponent();
  const { container } = await renderSettled(
    <LiveAnnouncerProvider>
      <WorkflowsDestinationBody context={surfaceContext(bridge)} />
    </LiveAnnouncerProvider>,
  );
  const element = container.querySelector<HTMLElement>(".meridian-workflows-destination");
  if (element === null) {
    throw new Error("the workflows destination rendered no root");
  }
  // Deliberately NOT inside `act`: the read resolves in a promise React knows
  // nothing about, and an `act` scope holds the resulting commit back until it
  // exits, so a wait placed inside one waits for a render its own scope prevents.
  // `waitFor` already wraps its polling in the async act the library installs.
  await waitFor(() => {
    if (element.querySelector(".meridian-definition-row") === null) {
      throw new Error("the definition enumeration has not landed yet");
    }
    if (element.querySelector(".meridian-run-row") === null) {
      throw new Error("the run enumeration has not landed yet");
    }
  });
  return { element, bridge };
}

/**
 * The run pane on the scenario's parked run, waited on until its parks have landed.
 *
 * The parked run rather than the working one, for the reason that fixture's own
 * header gives: a run with nothing parked would pin the emptiest frame the surface
 * has instead of its busiest, and the park banner is the thing an operator opens
 * this pane for.
 */
export async function mountWorkflowParkedRunPane(): Promise<MountedFamilySurface> {
  const bridge = createFixtureBridge({ scenario: WORKFLOWS_SCENARIO });
  const WorkflowRunPaneBody = await paneBodyComponent("workflow-run");
  const { container } = await renderSettled(
    <WorkflowRunPaneBody
      context={paneContext(
        {
          kind: "workflow-run",
          paneId: "pane-workflow-run-surface",
          entity: { kind: "workflow-run", id: WORKFLOWS_PARKED_RUN.workflowRunId },
        },
        bridge,
      )}
    />,
  );
  const region = requirePaneNamed(container, "Workflow run");
  await waitFor(() => {
    if (region.querySelector(".meridian-park") === null) {
      throw new Error("the run read has not landed yet");
    }
  });
  return { element: region, bridge };
}

/**
 * The definition the builder pane is opened on: the scenario's own, resolved.
 *
 * The row a run started here would actually pick — the same
 * most-specific-first resolution the browser marks — rather than the first entry in
 * declaration order, so the pane is addressed at a definition the fixture treats as
 * real. A throw rather than a fallback id: an address nothing in the scenario
 * describes would mount a pane whose subject exists nowhere, and a tier would audit
 * it as if it did.
 */
function scenarioDefinitionId(): string {
  const resolved = WORKFLOWS_SCENARIO_DEFINITIONS.find(
    (definition) => definition.resolvesAtThisContext,
  );
  if (resolved === undefined) {
    throw new Error("the workflows scenario declares no definition resolving at this context");
  }
  return resolved.id;
}

/**
 * The builder pane on that definition, which is its one arm that renders a body.
 *
 * ADDRESSED RATHER THAN EMPTY, and that is what makes the mount worth auditing: the
 * unaddressed arm draws a single absence block the frame tier already covers, while
 * this one composes the three things only this pane has — the pane head's action slot
 * carrying an INLINE refusal, the not-checked absence beneath it, and the two reserved
 * slot shells the bodies another plan owns will replace.
 *
 * No wait, deliberately: this pane puts no read on any arm — every authoring
 * operation is off the growth port — so there is nothing in flight to settle and a
 * `waitFor` here would be waiting on a promise that was never made.
 */
export async function mountWorkflowBuilderPane(): Promise<MountedFamilySurface> {
  const bridge = createFixtureBridge({ scenario: WORKFLOWS_SCENARIO });
  const WorkflowBuilderPaneBody = await paneBodyComponent("workflow-builder");
  const { container } = await renderSettled(
    <WorkflowBuilderPaneBody
      context={paneContext(
        {
          kind: "workflow-builder",
          paneId: "pane-workflow-builder-surface",
          entity: { kind: "workflow-definition", id: scenarioDefinitionId() },
        },
        bridge,
      )}
    />,
  );
  return { element: requirePaneNamed(container, "Workflow builder"), bridge };
}
