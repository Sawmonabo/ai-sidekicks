import { useId } from "react";

import { InlineRefusal } from "#renderer/components/Refusal/InlineRefusal.js";
import type { WorkflowActState } from "../hooks/useWorkflowAct.js";
import type { RunControlAvailability } from "../runs/controls.js";
import { ActionButton } from "./ActionButton.js";

/**
 * One of a run's controls. It keeps its place in every state: where the state does not allow it,
 * it stands disabled with the reason beside it; where the daemon refused a press, the daemon's
 * words stand beside it instead.
 */
export function RunControl(props: {
  readonly label: string;
  readonly availability: RunControlAvailability;
  readonly act: WorkflowActState<unknown>;
  readonly onPress: () => void;
}): React.JSX.Element {
  const reasonId = useId();
  const { availability, act } = props;
  const isRefusedByState = availability.kind === "refused";
  return (
    <span className="meridian-workflow-run__control">
      <ActionButton
        disabled={isRefusedByState || act.kind === "sending"}
        aria-describedby={isRefusedByState ? reasonId : undefined}
        onClick={props.onPress}
      >
        {props.label}
      </ActionButton>
      {isRefusedByState ? (
        <span id={reasonId} className="meridian-workflow-run__control-reason">
          {availability.reason}
        </span>
      ) : null}
      {!isRefusedByState && act.kind === "refused" ? (
        <InlineRefusal code={act.refusal.code} detail={act.refusal.detail} />
      ) : null}
    </span>
  );
}
