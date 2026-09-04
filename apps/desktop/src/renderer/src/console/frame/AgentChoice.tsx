// Which agent inside a session an auxiliary window should follow.
//
// The context picker's second step, and it exists because the agent-console
// route's grammar takes an agent WITH its session or not at all: a target
// carrying a session alone is not a partial descriptor, it is one the shared
// producer refuses. So the window collects both before it navigates, and this is
// where the second one is offered.
//
// It is a component of its own rather than a branch inside the picker because it
// subscribes: the agents are entities in the session's store, read through the
// same partition selector every other surface reads entities through, and React
// forbids a conditional hook — so the one frame in which the pending session has
// no store yet is the picker's to render, and this component takes a store it is
// guaranteed to have.
//
// THREE STATES, AND NOT ONE OF THEM AN EMPTY LIST STANDING IN FOR ANOTHER
// (`Spec-023 §Console Design (Meridian)` §The five kinds of nothing):
//
//   • The store has no base state yet → `not-loaded`. A read is genuinely in
//     flight: the registry requested one when the session opened.
//   • It has one and the session holds no agents → `empty`, saying what an agent
//     console is for so the next move is obvious.
//   • It has agents → the list.
//
// The two states this component does NOT render are the picker's, and for the
// same reason in both cases — neither is a fact about one store: the frame before
// the pending session opens, and a registry that can perform no read at all, whose
// refusal belongs to the registry rather than to anything it opened.

import { useMemo } from "react";

import { Nothing, WireChoiceList } from "../primitives/index.js";
import { useSessionInitialised, useSessionPartition, type SessionStore } from "../store/index.js";

export interface AgentChoiceProps {
  /** The pending session's store. Required: the picker renders the frame before
   * it opens, and its own absence, rather than handing this component nothing to
   * subscribe to. */
  readonly store: SessionStore;
  /** The route's own noun, so the copy reads as the window a person opened. */
  readonly routeNoun: string;
  /** Names the list for assistive technology; the picker's own question. */
  readonly label: string;
  readonly onChoose: (agentId: string) => void;
}

export function AgentChoice(props: AgentChoiceProps): React.JSX.Element {
  const initialised = useSessionInitialised(props.store);
  const agents = useSessionPartition(props.store, "agent");
  // Derived under `useMemo` rather than in the selector: a selector that built an
  // array would hand `useSyncExternalStore` a fresh reference every pass and
  // re-render forever. The partition's identity changes only when an agent does,
  // so this recomputes exactly then.
  const agentIds = useMemo(() => Object.keys(agents), [agents]);

  if (!initialised) {
    return (
      <Nothing
        kind="not-loaded"
        title={`Reading the agents this ${props.routeNoun} could follow.`}
      />
    );
  }
  if (agentIds.length === 0) {
    return (
      <Nothing
        kind="empty"
        title="This session has no agents yet."
        detail={`The ${props.routeNoun} follows one agent at a time. Attach an agent to this session, or choose a session that already has one.`}
      />
    );
  }
  return <WireChoiceList values={agentIds} onSelect={props.onChoose} label={props.label} />;
}
