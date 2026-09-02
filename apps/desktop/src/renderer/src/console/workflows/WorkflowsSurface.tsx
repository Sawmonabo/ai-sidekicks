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
// WHAT IS RESERVED HERE. Starting a run by talking to it is Plan-017's body, mounted
// through `owner-slots.ts` and standing empty until that plan fills it. The version
// chain, the content hash, the schema marker and the parent hash are one click away
// in the detail pane by design (rule 7's density budget), so none of them appears in
// this list.

import { Nothing } from "../primitives/index.js";
import { WorkflowChrome } from "./WorkflowChrome.js";
import { WorkflowSlotMount } from "./WorkflowSlotMount.js";
import { WORKFLOW_CHAT_START_SLOT } from "./owner-slots.js";
import type { WorkflowChromeState } from "./chrome-state.js";

/**
 * The three definition scopes, in the daemon's own resolution order.
 *
 * A tuple because the ORDER is the claim. Written as three headings in the markup,
 * the order would be a fact about where someone happened to paste a block; declared
 * here, it is a value a test can compare against the rule it encodes.
 */
export const WORKFLOW_DEFINITION_SCOPES = ["session", "project", "shared"] as const;

/** One definition scope. Derived from the enumeration, never restated. */
export type WorkflowDefinitionScope = (typeof WORKFLOW_DEFINITION_SCOPES)[number];

/** What each group is, in a line, so the scope model teaches itself. */
const SCOPE_SUMMARIES: Readonly<Record<WorkflowDefinitionScope, string>> = {
  session: "Authored in this session. Checked first, so a session definition wins.",
  project: "Shared by everyone working in this project checkout. Checked second.",
  shared: "Available across projects, and never edited in place — editing forks a copy.",
};

export interface WorkflowsSurfaceProps {
  readonly state: WorkflowChromeState;
  /** Opens the builder on a new definition. Absent while nothing can author one. */
  readonly onNewDefinition?: () => void;
  /** Reads a definition file in and submits it. Absent while nothing can import one. */
  readonly onImportDefinition?: () => void;
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
      <ol className="meridian-workflow__scopes">
        {WORKFLOW_DEFINITION_SCOPES.map((scope) => (
          <li className="meridian-workflow__scope" key={scope}>
            <h3 className="meridian-workflow__scope-heading">{scope}</h3>
            <p className="meridian-workflow__scope-summary">{SCOPE_SUMMARIES[scope]}</p>
            <Nothing
              kind="empty"
              placement="surface"
              title={`No ${scope} definitions.`}
              detail="A definition saved at this scope appears here, and the one a run would pick is marked."
              action={
                scope === "session" && props.onImportDefinition !== undefined ? (
                  <button
                    type="button"
                    className="meridian-workflow__action"
                    onClick={props.onImportDefinition}
                  >
                    Import a definition file
                  </button>
                ) : undefined
              }
            />
          </li>
        ))}
      </ol>
      <WorkflowSlotMount
        slot={WORKFLOW_CHAT_START_SLOT}
        title="Starting a workflow by talking to it is not built yet."
        detail="Runs start from a definition in the list above. This area is reserved for the conversational start."
      />
    </WorkflowChrome>
  );
}
