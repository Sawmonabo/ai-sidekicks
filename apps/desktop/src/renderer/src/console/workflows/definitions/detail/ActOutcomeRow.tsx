// One act's last answer, or nothing at all.
//
// ITS OWN MODULE BECAUSE EVERY `.tsx` HOLDS ONE COMPONENT — `apps/desktop/AGENTS.md`
// §Module shape, held in review. It is composed from the act strip in
// `DefinitionAuthoringActs.tsx` and from nothing else.
//
// `idle` RENDERS NOTHING, deliberately: a row saying an act has not been attempted is
// the console narrating its own inactivity, and rule 8's kinds of nothing are about
// READS a person is waiting on rather than controls they have not pressed.
//
// AND THE IN-FLIGHT SENTENCE IS THE ACT'S, NOT THIS ROW'S. One word here read
// "Submitting…" under every act, which is false of the export — it submits nothing and
// hands bytes to the host — so the sentence travels on the arm, exactly as the settled
// one does, and this component renders whichever it was given.

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
      {outcome.kind === "dispatching" ? <span>{outcome.detail}</span> : null}
      {outcome.kind === "settled" ? <span>{outcome.detail}</span> : null}
      {outcome.kind === "refused" ? <InlineRefusal {...outcome.refusal} /> : null}
    </li>
  );
}
