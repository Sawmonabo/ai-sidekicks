// The definitions a half-typed `/workflow start <name>` could still become, offered as a list while
// the name is typed. Nothing here reads a wire: definitions arrive as props and filtering is over
// the list in hand. Selecting one completes the line; the popover's rule against inserting text
// covers provider entries only, not the argument of a command the runtime itself intercepts.

import type { WorkflowDefinitionSummary } from "@ai-sidekicks/contracts/workflow/definition/methods";
import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import { PartialRead } from "#renderer/components/PartialRead/PartialRead.js";
import { workflowDefinitionCandidates } from "../definition/match.js";
import "./WorkflowStartCandidates.css";

/** What the workflow candidate list is given: the enumeration and the name typed so far. */
export interface WorkflowStartCandidatesProps {
  /** What the walk read of the definitions this session can start. */
  readonly definitions: readonly WorkflowDefinitionSummary[];
  /** False when the walk stopped short, so an empty match proves nothing. */
  readonly complete: boolean;
  /** What has been typed after the verb so far. `undefined` offers everything. */
  readonly typedPrefix: string | undefined;
  /** Put this name on the line. The caller owns the draft; this list owns none. */
  readonly onComplete: (definitionName: string) => void;
}

/** The candidate list, for the caller to mount while a `/workflow start` argument is open. */
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
  if (complete && definitions.length === 0) {
    return <Nothing kind="empty" title="No workflows yet" />;
  }
  const candidates = workflowDefinitionCandidates(definitions, typedPrefix);
  if (candidates.length === 0) {
    // Withheld under an incomplete walk: a search that stopped short says nothing about what is
    // missing.
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
