// The definitions a half-typed `/workflow start <name>` could still become.
//
// THE READ HAPPENS WHILE THE NAME IS BEING TYPED, WHICH IS THE WHOLE POINT. The
// autocomplete enumerates candidates via `workflow.definitionList`. The accelerator
// already read that enumeration — but only after Enter, to resolve a name somebody had
// to know already, so a person who did not know it was told the name they guessed does
// not exist and offered nothing instead. This is the other half: the same enumeration,
// read while the argument is still open, offered as a list.
//
// IT IS THE SAME DOOR AND NOT A SECOND ONE. `definition-enumeration.ts` walks the
// wire's cursor to exhaustion for both readers, so a candidate offered here is a name
// the dispatch will resolve, and a name past the first page is offered rather than
// refused.
//
// AND THE READ GOES THROUGH THE CONSOLE'S OWN CHOKEPOINT. `useSettledGrowthRead`
// holds the answer against the SUBJECT it was asked for, so a reply arriving after
// the composer has been re-addressed writes nowhere; the walk takes a liveness
// predicate besides, so a superseded read stops asking for pages instead of spending
// them to publish nothing. Nothing polls: the read is put once per session the
// surface opens over, and the filtering as somebody types is arithmetic over the list
// already in hand.
//
// SELECTING ONE COMPLETES THE LINE — this console's own command, this console's own
// grammar, and a line the send path accepts. The popover's standing rule that nothing
// is inserted into the message box is about PROVIDER entries, whose text the
// provider-bound send path refuses outright; it is not a rule about completing the
// argument of a command the runtime itself intercepts.

import { useEffect, useRef } from "react";

import {
  useSettledGrowthRead,
  type GrowthPort,
  type SettledReadRefusal,
  type WorkflowDefinitionSummary,
} from "../../../../console/bridge/index.js";
import { InlineRefusal, Nothing, PartialRead } from "../../../../console/primitives/index.js";
import {
  readWorkflowDefinitions,
  type WorkflowDefinitionEnumeration,
} from "./definition-enumeration.js";
import { workflowDefinitionCandidates } from "./definition-match.js";

/** What this surface holds about its own read. */
type WorkflowCandidateReadState =
  | { readonly phase: "not-loaded" }
  | {
      readonly phase: "served";
      readonly definitions: readonly WorkflowDefinitionSummary[];
      readonly complete: boolean;
    }
  | { readonly phase: "refused"; readonly refusal: SettledReadRefusal };

const NOT_LOADED: WorkflowCandidateReadState = { phase: "not-loaded" };

export interface WorkflowStartCandidatesProps {
  readonly growth: GrowthPort;
  /** The session whose startable definitions these are, or nothing where none. */
  readonly sessionId: string | undefined;
  /** What has been typed after the verb so far. `undefined` offers everything. */
  readonly typedPrefix: string | undefined;
  /** Put this name on the line. The caller owns the draft; this surface owns none. */
  readonly onComplete: (definitionName: string) => void;
}

/** The candidate list, mounted only while a `/workflow start` argument is open. */
export function WorkflowStartCandidates(
  props: WorkflowStartCandidatesProps,
): React.JSX.Element | null {
  const { growth, sessionId, typedPrefix, onComplete } = props;
  // The walk's liveness, which is this surface's own: a read whose surface has closed
  // has nowhere to publish, so it stops paging rather than finishing for nobody.
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const { value } = useSettledGrowthRead<WorkflowDefinitionEnumeration, WorkflowCandidateReadState>(
    growth,
    sessionId,
    (key) =>
      key === undefined
        ? undefined
        : readWorkflowDefinitions(growth, key, () => isMountedRef.current),
    { unsettled: () => NOT_LOADED, settled: projectEnumeration },
  );

  if (sessionId === undefined) {
    // Nothing was asked: this composer is addressed within no session, so there is no
    // enumeration to offer and the dispatch would refuse for the same reason.
    return null;
  }
  return (
    <div className="meridian-workflow-start__candidates">
      <p className="meridian-workflow-start__candidates-lede">Workflows this session can start</p>
      {renderReading(value, typedPrefix, onComplete)}
    </div>
  );
}

/** One settled walk, as the state this surface renders. */
function projectEnumeration(
  settlement: WorkflowDefinitionEnumeration | SettledReadRefusal,
): WorkflowCandidateReadState {
  if (settlement.status === "served") {
    return {
      phase: "served",
      definitions: settlement.definitions,
      complete: settlement.complete,
    };
  }
  // Both refusal arms are one sentence to a reader: the walk's own refused page, and
  // the settlement seam's arm for a read that rejected before it answered.
  return {
    phase: "refused",
    refusal: settlement.status === "refused" ? settlement.refusal : settlement,
  };
}

/** The list, or the one honest sentence about why there is not one. */
function renderReading(
  reading: WorkflowCandidateReadState,
  typedPrefix: string | undefined,
  onComplete: (definitionName: string) => void,
): React.JSX.Element {
  if (reading.phase === "not-loaded") {
    return <Nothing kind="not-loaded" title="Reading this session's workflow definitions" />;
  }
  if (reading.phase === "refused") {
    return <InlineRefusal code={reading.refusal.code} detail={reading.refusal.detail} />;
  }
  const candidates = workflowDefinitionCandidates(reading.definitions, typedPrefix);
  if (candidates.length === 0) {
    // Withheld under an incomplete walk, exactly as the provider enumeration withholds
    // its own empty claim: a search that stopped short answers no question about what
    // is missing.
    return reading.complete ? (
      <Nothing
        kind="empty"
        title="No workflow this session can start matches what you have typed"
        detail="Clear the name to see every definition this session resolves."
      />
    ) : (
      <PartialRead
        states={[{ kind: "cut", servedCount: reading.definitions.length }]}
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
