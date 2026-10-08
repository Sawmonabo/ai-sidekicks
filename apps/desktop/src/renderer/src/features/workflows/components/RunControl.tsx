import { HoverLabel } from "#renderer/components/HoverLabel/HoverLabel.js";
import { InlineRefusal } from "#renderer/components/Refusal/InlineRefusal.js";
import type { WorkflowCallState } from "../hooks/useWorkflowCall.js";
import type { RunControlAvailability } from "../runs/controls.js";
import { ActionButton } from "./ActionButton.js";

/**
 * One of a run's controls. It keeps its place in every state: where the state does not allow it,
 * it stands disabled, still reachable by Tab, and the reason is its description, read by a screen
 * reader and shown in its hover label, so the control never grows a second line; where the daemon refused a press, the
 * daemon's words stand beside it instead.
 */
export function RunControl(props: {
  readonly label: string;
  readonly availability: RunControlAvailability;
  readonly act: WorkflowCallState<unknown>;
  readonly onPress: () => void;
  /** Extra classes for the button, such as the destructive face. */
  readonly className?: string;
}): React.JSX.Element {
  const { availability, act } = props;
  const reason = availability.kind === "refused" ? availability.reason : undefined;
  return (
    <span className="meridian-workflow-run__control">
      <HoverLabel text={reason} textIs="description">
        <ActionButton
          disabled={reason !== undefined || act.kind === "sending"}
          focusableWhenDisabled
          className={props.className}
          onClick={props.onPress}
        >
          {props.label}
        </ActionButton>
      </HoverLabel>
      {reason === undefined && act.kind === "refused" ? (
        <InlineRefusal code={act.refusal.code} detail={act.refusal.detail} />
      ) : null}
    </span>
  );
}
