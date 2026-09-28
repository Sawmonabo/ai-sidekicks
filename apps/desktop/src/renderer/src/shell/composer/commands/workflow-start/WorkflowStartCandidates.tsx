// The definitions a half-typed `/workflow start <name>` could still become.
//
// THE LIST IS OFFERED WHILE THE NAME IS BEING TYPED, WHICH IS THE WHOLE POINT. The
// accelerator reads the enumeration only after Enter, to resolve a name somebody had
// to know already, so a person who did not know it was told the name they guessed does
// not exist and offered nothing instead. This is the other half: the same enumeration,
// held by the caller while the argument is still open, offered as a list. The caller
// walks it with `definition-enumeration.ts`, so a candidate offered here is a name the
// dispatch will resolve. Nothing here reads a wire: the definitions arrive as props,
// and the filtering as somebody types is arithmetic over the list already in hand.
//
// SELECTING ONE COMPLETES THE LINE — this console's own command, this console's own
// grammar, and a line the send path accepts. The popover's standing rule that nothing
// is inserted into the message box is about PROVIDER entries, whose text the
// provider-bound send path refuses outright; it is not a rule about completing the
// argument of a command the runtime itself intercepts.

import type { WorkflowDefinitionSummary } from "../../../../console/bridge/index.js";
import { Nothing, PartialRead } from "../../../../console/primitives/index.js";
import { workflowDefinitionCandidates } from "./definition-match.js";

/** What the workflow candidate list is given: the enumeration and the name typed so far. */
export interface WorkflowStartCandidatesProps {
  /** What the walk read of the definitions this session can start. */
  readonly definitions: readonly WorkflowDefinitionSummary[];
  /** False when the walk stopped short, so an empty match proves nothing. */
  readonly complete: boolean;
  /** What has been typed after the verb so far. `undefined` offers everything. */
  readonly typedPrefix: string | undefined;
  /** Put this name on the line. The caller owns the draft; this surface owns none. */
  readonly onComplete: (definitionName: string) => void;
}

/**
 * The candidate list, for the caller to mount while a `/workflow start` argument is open.
 */
export function WorkflowStartCandidates(props: WorkflowStartCandidatesProps): React.JSX.Element {
  const { definitions, complete, typedPrefix, onComplete } = props;
  return (
    <div className="meridian-workflow-start__candidates">
      <p className="meridian-workflow-start__candidates-lede">Workflows this session can start</p>
      {renderReading(definitions, complete, typedPrefix, onComplete)}
    </div>
  );
}

/** The list, or the one honest sentence about why there is not one. */
function renderReading(
  definitions: readonly WorkflowDefinitionSummary[],
  complete: boolean,
  typedPrefix: string | undefined,
  onComplete: (definitionName: string) => void,
): React.JSX.Element {
  const candidates = workflowDefinitionCandidates(definitions, typedPrefix);
  if (candidates.length === 0) {
    // Withheld under an incomplete walk, exactly as the provider enumeration withholds
    // its own empty claim: a search that stopped short answers no question about what
    // is missing.
    return complete ? (
      <Nothing
        kind="empty"
        title="No workflow this session can start matches what you have typed"
        detail="Clear the name to see every definition this session resolves."
      />
    ) : (
      <PartialRead
        states={[{ kind: "cut", servedCount: definitions.length }]}
        subject="this session's workflow definitions"
      />
    );
  }
  return (
    <ul className="meridian-workflow-start__candidate-list" aria-label="Workflow definitions">
      {candidates.map((definition) => (
        <li key={definition.id} className="meridian-workflow-start__candidate">
          <button
            type="button"
            className="meridian-workflow-start__candidate-name"
            onClick={() => {
              onComplete(definition.name);
            }}
          >
            {definition.name}
          </button>
          <span className="meridian-workflow-start__candidate-scope">{definition.scope}</span>
        </li>
      ))}
    </ul>
  );
}
