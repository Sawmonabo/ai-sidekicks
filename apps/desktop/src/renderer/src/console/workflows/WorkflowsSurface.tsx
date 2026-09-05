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
// button rather than by having a dead one. A control whose action nothing can EVER
// supply is a different thing and is not reserved here either: an import entry point
// was threaded through two components to a button no caller in this repository could
// reach, which reads as coverage and is inert. It is gone until a producer exists.
//
// WHERE THE GROUPS THEMSELVES LIVE. This file is the destination's chrome — heading,
// one primary action, and which of the absence grammars the state calls for. The
// scope groups and their rows are `definitions/DefinitionsBrowser.tsx`, because those are the
// browser and this is the frame around it, and a surface that also owned the rows
// would be the place a second grouping quietly appeared beside the first.
//
// WHAT IS RESERVED HERE. Starting a run by talking to it is Plan-017's body, mounted
// through `ChatStartSlot` — the family's own typed wrapper, and the same one the run
// pane mounts — and standing empty until that plan fills it. The wrapper rather than
// the raw slot mount, because the slot's obligation is that every mount supplies the
// session a start binds to: a mount that carried no payload could only ever be an
// unfillable shell, and a second one worded here would say the reservation twice. The
// version chain, the content hash, the schema marker and the parent hash are one
// click away in the detail pane by design (rule 7's density budget), so none of them
// appears in this list.

import type { ReadingState } from "../primitives/index.js";
import type { WorkflowDefinitionScope } from "../bridge/index.js";
import { ChatStartSlot } from "./ChatStartSlot.js";
import { WorkflowChrome } from "./WorkflowChrome.js";
import type { WorkflowChromeState } from "./chrome-state.js";
import { DefinitionsBrowser } from "./definitions/DefinitionsBrowser.js";
import type { WorkflowDefinitionRow } from "./definitions/definition-rows.js";

export interface WorkflowsSurfaceProps {
  readonly state: WorkflowChromeState;
  /**
   * The session a run started from here would bind to, or nothing where none is in
   * scope.
   *
   * Required-carrying-undefined, which is `ChatStartMount`'s own rule carried up one
   * level rather than restated: a surface mounted on a bare rail address has no
   * session to hand over and has to say so, and an absent key would read identically
   * to one that simply forgot to look.
   */
  readonly sessionId: string | undefined;
  /** Every definition this context can see. Empty until a read supplies some. */
  readonly definitions?: readonly WorkflowDefinitionRow[] | undefined;
  /** Scopes whose page is still in flight, so their absence reads as a wait. */
  readonly pendingScopes?: readonly WorkflowDefinitionScope[] | undefined;
  /** True while the enumeration holds pages nobody has read, so no group is empty yet. */
  readonly hasUnreadPages?: boolean | undefined;
  /** Opens one definition's detail. Absent while nothing can open one. */
  readonly onOpenDefinition?: ((definition: WorkflowDefinitionRow) => void) | undefined;
  /** Asks for the page after the ones shown. Absent while no cursor is held. */
  readonly onContinueReading?: (() => void) | undefined;
  /** How complete the pages shown are: a wait, a refusal beside them, or nothing. */
  readonly continuationReading?: ReadingState | undefined;
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
    >
      <DefinitionsBrowser
        definitions={props.definitions ?? []}
        pendingScopes={props.pendingScopes}
        hasUnreadPages={props.hasUnreadPages}
        onOpenDefinition={props.onOpenDefinition}
        onContinueReading={props.onContinueReading}
        continuationReading={props.continuationReading}
      />
      <ChatStartSlot sessionId={props.sessionId} />
    </WorkflowChrome>
  );
}
