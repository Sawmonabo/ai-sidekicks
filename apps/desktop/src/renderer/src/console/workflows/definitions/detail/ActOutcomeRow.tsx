// One act's last answer, or nothing at all.
//
// ITS OWN MODULE BECAUSE EVERY `.tsx` HOLDS ONE COMPONENT — the package rule, checked
// by the architecture tier. It is composed from the act strip in
// `DefinitionAuthoringActs.tsx` and from nothing else.
//
// `idle` RENDERS NOTHING, deliberately: a row saying an act has not been attempted is
// the console narrating its own inactivity, and rule 8's kinds of nothing are about
// READS a person is waiting on rather than controls they have not pressed.

import { InlineRefusal } from "../../../primitives/index.js";
import type { WorkflowDetailActOutcome } from "./definition-authoring.js";

export interface ActOutcomeRowProps {
  readonly label: string;
  readonly outcome: WorkflowDetailActOutcome;
}

/** One row of the act strip's outcome list, or nothing where the act is untouched. */
export function ActOutcomeRow(props: ActOutcomeRowProps): React.JSX.Element | null {
  const { label, outcome } = props;
  if (outcome.kind === "idle") {
    return null;
  }
  return (
    <li className="meridian-definition-detail__outcome">
      <span className="meridian-definition-detail__outcome-act">{label}</span>
      {outcome.kind === "dispatching" ? <span>Submitting…</span> : null}
      {outcome.kind === "settled" ? <span>{outcome.detail}</span> : null}
      {outcome.kind === "refused" ? <InlineRefusal {...outcome.refusal} /> : null}
    </li>
  );
}
