// The workflows family's surfaces, mounted once for the two tiers that look at them.
//
// Not a test file — no `include` glob reaches it. The screenshot tier and the
// accessibility tier need the same two surfaces this family ships, and a per-tier
// copy of the mount would be two chances to compose them differently and then read
// the results as if they were comparable. `console-harness.tsx` owns HOW the console
// is mounted, one level down; this module owns WHAT of this family is mounted into it.
//
// THE BODIES COME OUT OF THE DECK'S REGISTRY, NOT OUT OF AN IMPORT, on the
// browser-terminal tiers' precedent: both surfaces are resolved through
// `ConsolePaneRegistry` after the family registers into it, so a tier renders the
// body the deck would mount rather than a component that happens to sit beside it —
// and the family's stylesheet arrives on the edge its barrel already owns, which is
// what makes the captured pixels the ones a person would see.
//
// BOTH SURFACES ARE DRIVEN BY THE SCENARIO AND NOT BY HAND-BUILT ROWS. The workflows
// scenario scripts the definition enumeration and the run read, and the fixture
// growth port answers both from it — so the browser shows the definitions a daemon
// would have listed, and the run pane shows the run that fixture's own header calls
// the parked one: two park kinds at once, one with an armed resume and one without,
// which is the pair a park banner most easily conflates and therefore the frame worth
// pinning.
//
// WHY THE REGION IS FOUND BY ITS HEADING RATHER THAN BY AN `aria-label`. This
// family's chrome names its region with `aria-labelledby` pointing at the visible
// heading, deliberately, so the announced name and the read name cannot disagree.
// The browser-terminal helper's `[aria-label=…]` lookup would therefore find nothing
// here; the lookup below is the same claim — find the region by the name a person
// navigating with assistive technology would hear — expressed against the way this
// family spells it.

import { waitFor } from "@testing-library/react";
import type { FunctionComponent } from "react";

import { renderSettled } from "./console-harness.js";

import {
  createFixtureBridge,
  type ConsoleBridge,
} from "../../src/renderer/src/console/bridge/index.js";
import { WORKFLOWS_SCENARIO } from "../../src/renderer/src/console/bridge/scenarios/workflows.js";
import {
  WORKFLOWS_PARKED_RUN,
  WORKFLOWS_SESSION_ID,
} from "../../src/renderer/src/console/bridge/scenarios/workflow-fixture-data.js";
import { DraftStore, UiStateStore } from "../../src/renderer/src/console/persistence/index.js";
import { FrameStore, SessionStore } from "../../src/renderer/src/console/store/index.js";
import { registerWorkflowPanes } from "../../src/renderer/src/console/workflows/index.js";
import {
  ConsolePaneRegistry,
  type ConsolePaneContext,
  type PaneKind,
} from "../../src/renderer/src/console/workspace/index.js";

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
 * The pane body the deck holds for a kind, as a component, or a throw.
 *
 * A throw rather than an optional return, so a family that stopped registering its
 * kind fails here — where the message names the kind — instead of rendering nothing
 * and letting a tier compare an empty box against a baseline.
 *
 * The descriptor's `render` is handed back for React to MOUNT rather than called
 * here: both bodies hold hooks, and a plain call outside a render would run them
 * against no dispatcher.
 */
function paneBodyComponent(kind: PaneKind): FunctionComponent<{ context: ConsolePaneContext }> {
  const descriptor = familyPaneRegistry().descriptorFor(kind);
  if (descriptor === undefined) {
    throw new Error(`no console pane is registered for the \`${kind}\` kind`);
  }
  return ({ context }) => descriptor.render(context);
}

/** The deck context a pane is mounted with, minus the parts each caller supplies. */
function paneContext(
  overrides: Pick<ConsolePaneContext, "kind" | "paneId" | "entity">,
  bridge: ConsoleBridge,
): ConsolePaneContext {
  return {
    frameStore: new FrameStore(),
    uiStateStore: UiStateStore.opening(),
    draftStore: new DraftStore(),
    focusHue: undefined,
    bridge,
    sessionStore: new SessionStore({ sessionId: WORKFLOWS_SESSION_ID }),
    ...overrides,
  };
}

/** The element a tier reads, and the bridge it was mounted against. */
export interface MountedFamilySurface {
  readonly element: HTMLElement;
  readonly bridge: ConsoleBridge;
}

/**
 * Find the one region a workflows surface renders itself as, by its heading.
 *
 * Scoped by the accessible name rather than by a class, because that is what a
 * person using assistive technology navigates by — a surface that lost its name
 * would still match a class selector and would still be captured as if nothing had
 * changed.
 */
function requireRegionNamed(container: HTMLElement, headingText: string): HTMLElement {
  for (const region of container.querySelectorAll("section[aria-labelledby]")) {
    const labelId = region.getAttribute("aria-labelledby");
    const label = labelId === null ? null : container.querySelector(`#${CSS.escape(labelId)}`);
    if (region instanceof HTMLElement && label?.textContent === headingText) {
      return region;
    }
  }
  throw new Error(`no region in the mounted tree is named \`${headingText}\``);
}

/**
 * The definitions browser, mounted and waited on until its rows have landed.
 *
 * Through the builder pane's no-subject arm, which is where the browser lives
 * inside a session — and a session is what the enumeration's request requires. The
 * wait is the difference between a surface and its empty state: the read crosses a
 * promise, so a tier reading straight after the mount would pin three empty groups
 * and compare them against a baseline of the populated list on the next warm run.
 */
export async function mountWorkflowDefinitionsBrowser(): Promise<MountedFamilySurface> {
  const bridge = createFixtureBridge({ scenario: WORKFLOWS_SCENARIO });
  const WorkflowBuilderPaneBody = paneBodyComponent("workflow-builder");
  const { container } = await renderSettled(
    <WorkflowBuilderPaneBody
      context={paneContext(
        { kind: "workflow-builder", paneId: "pane-workflow-builder-surface", entity: undefined },
        bridge,
      )}
    />,
  );
  const region = requireRegionNamed(container, "Workflows");
  // Deliberately NOT inside `act`: the read resolves in a promise React knows
  // nothing about, and an `act` scope holds the resulting commit back until it
  // exits, so a wait placed inside one waits for a render its own scope prevents.
  // `waitFor` already wraps its polling in the async act the library installs.
  await waitFor(() => {
    if (region.querySelector(".meridian-definition-row") === null) {
      throw new Error("the definition enumeration has not landed yet");
    }
  });
  return { element: region, bridge };
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
  const WorkflowRunPaneBody = paneBodyComponent("workflow-run");
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
  const region = requireRegionNamed(container, "Workflow run");
  await waitFor(() => {
    if (region.querySelector(".meridian-park") === null) {
      throw new Error("the run read has not landed yet");
    }
  });
  return { element: region, bridge };
}
