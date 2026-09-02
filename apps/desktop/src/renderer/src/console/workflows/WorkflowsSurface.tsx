// The definitions browser — the workflows destination's own surface.
//
// Its job is to show every definition visible from here, grouped by scope in
// RESOLUTION ORDER, and to mark the one a run would pick. The order is the daemon's
// rule rather than a layout preference, which is why the three groups are named and
// rendered even when all three are empty: the scope model has to be legible before
// anything exists, or an author cannot read which definition would win.
//
// TWO THINGS THIS SURFACE NEVER DOES, both of them rules rather than omissions.
// It never derives the resolution order and never recomputes which row resolves —
// that answer arrives on the row as the daemon computed it, and a renderer that
// re-walked the scopes would be a second authority on a question the daemon owns.
// And it never draws a control that leads nowhere: "absent, not disabled" means an
// entry point appears when its caller supplies the action and not before, so the
// empty state of a console that cannot yet author a definition says so by having no
// button rather than by having a dead one.
//
// WHERE THE GROUPS THEMSELVES LIVE. This file is the destination's chrome — heading,
// one primary action, and which of the absence grammars the state calls for. The
// scope groups and their rows are `DefinitionsBrowser.tsx`, because those are the
// browser and this is the frame around it, and a surface that also owned the rows
// would be the place a second grouping quietly appeared beside the first.
//
// WHAT IS RESERVED HERE. Starting a run by talking to it is Plan-017's body, mounted
// through `owner-slots.ts` and standing empty until that plan fills it. The version
// chain, the content hash, the schema marker and the parent hash are one click away
// in the detail pane by design (rule 7's density budget), so none of them appears in
// this list.

import type { ConsoleRefusal } from "../core/index.js";
import { WorkflowChrome } from "./WorkflowChrome.js";
import { WorkflowSlotMount } from "./WorkflowSlotMount.js";
import { WORKFLOW_CHAT_START_SLOT } from "./owner-slots.js";
import type { WorkflowChromeState } from "./chrome-state.js";
import {
  DefinitionsBrowser,
  type WorkflowDefinitionRow,
  type WorkflowDefinitionScope,
} from "./DefinitionsBrowser.js";

export interface WorkflowsSurfaceProps {
  readonly state: WorkflowChromeState;
  /** Every definition this context can see. Empty until a read supplies some. */
  readonly definitions?: readonly WorkflowDefinitionRow[] | undefined;
  /** Scopes whose page is still in flight, so their absence reads as a wait. */
  readonly pendingScopes?: readonly WorkflowDefinitionScope[] | undefined;
  /** A daemon refusal belonging to one scope, rendered with its message verbatim. */
  readonly scopeRefusals?:
    | Readonly<Partial<Record<WorkflowDefinitionScope, ConsoleRefusal>>>
    | undefined;
  /** Opens the builder on a new definition. Absent while nothing can author one. */
  readonly onNewDefinition?: () => void;
  /** Reads a definition file in and submits it. Absent while nothing can import one. */
  readonly onImportDefinition?: () => void;
  /** Opens one definition's detail. Absent while nothing can open one. */
  readonly onOpenDefinition?: ((definition: WorkflowDefinitionRow) => void) | undefined;
  /** Asks for the page after the ones shown. Absent while no cursor is held. */
  readonly onContinueReading?: (() => void) | undefined;
  /** True while that page is in flight, so its absence reads as a wait. */
  readonly isContinuing?: boolean | undefined;
  /** A refused continuation, rendered beside the control. The rows shown stay. */
  readonly continuationRefusal?: ConsoleRefusal | undefined;
}

/** The definitions browser's chrome, grouped by scope in resolution order. */
export function WorkflowsSurface(props: WorkflowsSurfaceProps): React.JSX.Element {
  const showsGroups = props.state.kind === "empty" || props.state.kind === "ready";
  return (
    <WorkflowChrome
      glyph="workflow"
      heading="Workflows"
      summary="Definitions visible from here, in the order a run resolves them."
      state={showsGroups ? { kind: "ready" } : props.state}
      primaryAction={
        props.onNewDefinition === undefined ? undefined : (
          <button
            type="button"
            className="meridian-workflow__action"
            onClick={props.onNewDefinition}
          >
            New definition
          </button>
        )
      }
    >
      <DefinitionsBrowser
        definitions={props.definitions ?? []}
        pendingScopes={props.pendingScopes}
        scopeRefusals={props.scopeRefusals}
        onOpenDefinition={props.onOpenDefinition}
        onImportDefinition={props.onImportDefinition}
        onContinueReading={props.onContinueReading}
        isContinuing={props.isContinuing}
        continuationRefusal={props.continuationRefusal}
      />
      <WorkflowSlotMount
        slot={WORKFLOW_CHAT_START_SLOT}
        title="Starting a workflow by talking to it is not built yet."
        detail="Runs start from a definition in the list above. This area is reserved for the conversational start."
      />
    </WorkflowChrome>
  );
}
