// One settled switch, as one line.
//
// The projection is `switch-settlement.ts` and this file is the layout, which is the
// whole split: the mapping from the reply's four arms, three continuity arms, and
// closed loss vocabulary to WORDS is testable without a DOM, and this component
// decides only where those words sit and which of them carries a caution.
//
// EXACTLY ONE ARM READS AS A CAUTION. The failed arm is the participant asking for a
// change that did not happen, and a row implying otherwise would be worse than none.
// The `memo` settlement is not a failure and is not an ordinary success either: it
// gets the same line plus the loss clause, and a lossless switch gets no decoration
// at all.
//
// WHY THE TWO TERMINAL EVENTS ARE NOT RENDERED HERE. `agent.provider_switched` and
// `agent.provider_switch_failed` are absent from the shipped `SessionEventType`
// union, so no store admits them and no timeline row can carry one. What this
// console can show today is the HELD-OPEN reply, which is what this renders. The
// absence is stated rather than approximated with a row composed from the reply,
// because a row in the timeline claims the log carried it.

import { Chip } from "../../primitives/index.js";
import { describeSwitchSettlement } from "./switch-settlement.js";
import type { AgentSwitchSettlement } from "../../bridge/index.js";

export interface SwitchSettlementLineProps {
  readonly settlement: AgentSwitchSettlement;
  /** The agent's already-resolved name. This surface resolves no identity. */
  readonly agentLabel: string;
}

export function SwitchSettlementLine(props: SwitchSettlementLineProps): React.JSX.Element {
  const rendering = describeSwitchSettlement(props.settlement, props.agentLabel);
  return (
    <p
      className={`meridian-settlement meridian-settlement--${rendering.tone}`}
      aria-label="Switch settlement"
    >
      {rendering.isKnownStatus ? null : <Chip tone="attention" label="unrecognized state" />}
      <span className="meridian-settlement__headline">{rendering.headline}</span>
      {rendering.continuityClause === undefined ? null : (
        <span className="meridian-settlement__continuity"> {rendering.continuityClause}</span>
      )}
      {rendering.lossClause === undefined ? null : (
        <span className="meridian-settlement__losses"> {rendering.lossClause}</span>
      )}
      {rendering.supersededSwitchId === undefined ? null : (
        <span className="meridian-settlement__superseded">
          {" "}
          It displaced {rendering.supersededSwitchId}, which reaches no settlement of its own.
        </span>
      )}
    </p>
  );
}
