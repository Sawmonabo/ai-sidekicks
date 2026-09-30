// One act's last answer, or nothing at all. `idle` renders nothing: a row saying an act has not
// been attempted would narrate the console's inactivity. The in-flight sentence travels on the
// outcome arm, since one word would read "Submitting…" under an export that submits nothing.

import { InlineRefusal } from "@renderer/components/Refusal/InlineRefusal.js";
import type { WorkflowDetailActOutcome } from "../definition-authoring.js";

/** An act's label and its last outcome. */
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
