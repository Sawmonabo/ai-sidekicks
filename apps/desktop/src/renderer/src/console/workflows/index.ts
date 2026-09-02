// The workflows family's door.
//
// The family is the workflows destination's own surface — the definitions browser
// — plus the two pane kinds `Spec-023 §Console Design (Meridian)` reserves for it,
// `workflow-run` and `workflow-builder`. The panes live under `console/panes/`
// because that is where the deck's bodies live and the pane-kind set is what a
// reader finds them from; the shared vocabulary lives here because it is the
// family's, not the deck's. The two directories are ONE family under one task, so
// the imports between them are deep and intra-family rather than through a second
// barrel, which would be a seam drawn where there is no boundary.
//
// WHAT LEAVES THE FAMILY IS TWO REGISTRATIONS AND NOTHING ELSE. Not the surface,
// not the panes, not the chrome: the console composes this family by calling
// `registerWorkflowPanes` at its pane seat and `registerWorkflowSurfaces` at its
// surface seat, and nothing above needs a handle on a body. An export beyond those
// would be an invitation for another family to mount a workflows surface itself,
// which is the coupling the deck's and the frame's single mount doors exist to
// prevent.
//
// TWO SEATS BECAUSE THERE ARE TWO BOARDS. The deck's board is keyed by pane kind
// and the frame's by surface slot; this family occupies one seat on each — the two
// pane kinds it claims, and the rail destination the spec's surface set gives it.
// Until the surface seat was filled, pressing the rail's middle destination reached
// the frame's reserved-slot absence, which was a true sentence about a browser this
// family had in fact already built.
//
// THE STYLESHEET IS IMPORTED HERE AND NOWHERE ELSE, so the bundler sees one edge
// into it and a surface can never render a chrome that arrived without its rules.
//
// WHY THIS BARREL BUILDS ELEMENTS RATHER THAN BEING A `.tsx`. It owns a TABLE —
// kind, owner, body, and the tear-off answer — not a view, which is the same reason
// `frame/legacy-surfaces.ts` builds its mounts with `createElement`. Written as a
// component file it would be a `.tsx` holding no component at all.

import "./workflows.css";

import { createElement } from "react";

// Deep, and this is the one import in the family that must be. The frame's barrel
// also exports `ConsoleRoot`, which composes the families — so a family reaching the
// surface seat THROUGH that barrel closes a cycle the layering gate rejects
// (`families.ts → workflows/index.ts → frame/index.ts → ConsoleRoot.tsx →
// families.ts`). `families.ts` deep-imports this same module for the same reason.
// The seat is a registry type and nothing else; the family reaches no other part of
// the frame.
import type { ConsoleSurfaceRegistry } from "../frame/surface-registry.js";
import { WorkflowBuilderPane } from "../panes/workflow-builder/index.js";
import { WorkflowRunPane } from "../panes/workflow-run/index.js";
import type { ConsolePaneDescriptor, ConsolePaneRegistry } from "../workspace/index.js";
import { WorkflowsBrowser } from "./WorkflowsBrowser.js";

/**
 * The family's owner string, as the pane registry's duplicate policy reads it.
 *
 * One binding rather than two literals: the registry's policy is owner-scoped, so a
 * hot reload re-registering under the same owner replaces and a DIFFERENT owner
 * claiming a taken kind raises. Two literals that drifted by a character would make
 * the second registration a conflict with the first — a failure that reads as a seat
 * collision between families when it is one typo inside one.
 */
const WORKFLOWS_OWNER = "workflows";

/**
 * Both pane kinds this family claims, with the tear-off answer each one gives.
 *
 * Neither opens in an auxiliary window. `Spec-023 §Console Design (Meridian)` ships
 * exactly two auxiliary windows, `timeline` and `agent-console`, and a kind that is
 * not one of them answers `false` — not because a workflow could not usefully be
 * detached, but because the window set is closed by the spec and a pane claiming a
 * window that does not exist would fail at the detach rather than at the claim.
 */
const WORKFLOW_PANES: readonly ConsolePaneDescriptor[] = [
  {
    kind: "workflow-run",
    owner: WORKFLOWS_OWNER,
    render: (context) => createElement(WorkflowRunPane, { context }),
    openInWindow: false,
  },
  {
    kind: "workflow-builder",
    owner: WORKFLOWS_OWNER,
    render: (context) => createElement(WorkflowBuilderPane, { context }),
    openInWindow: false,
  },
];

/**
 * Claim this family's pane kinds against a registry.
 *
 * Takes the registry rather than reaching for the module-scope singleton, for
 * `registerConsolePanes`' reason: a test composes the same bodies into a registry it
 * owns, and an auxiliary window composes a different subset without a second code
 * path.
 */
export function registerWorkflowPanes(registry: ConsolePaneRegistry): void {
  for (const descriptor of WORKFLOW_PANES) {
    registry.register(descriptor);
  }
}

/**
 * Claim the rail's workflows destination against a registry.
 *
 * Takes the registry rather than the module-scope singleton, for
 * `registerWorkflowPanes`' reason: a test composes the same surface into a registry
 * it owns, and an auxiliary window composes a different subset without a second code
 * path.
 *
 * The descriptor is built here rather than kept in a table beside the pane
 * descriptors: there is exactly one of it, and a one-row table is a shape that
 * invites a second row nobody decided to add.
 */
export function registerWorkflowSurfaces(registry: ConsoleSurfaceRegistry): void {
  registry.register({
    slot: "workflows",
    owner: WORKFLOWS_OWNER,
    // The two inputs the browser cannot get for itself, and no more of the context
    // than that: handing the whole surface context down would make every later
    // member of it reachable from a browser that needs two.
    render: (context) =>
      createElement(WorkflowsBrowser, {
        growth: context.bridge.growth,
        sessionId: context.sessionStore?.sessionId,
      }),
  });
}
