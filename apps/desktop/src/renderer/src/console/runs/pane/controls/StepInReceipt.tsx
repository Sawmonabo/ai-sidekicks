// The step-in receipt: what the pause did, in the daemon's own figures.
//
// Its own module because `apps/desktop/AGENTS.md` allows one component per `.tsx`,
// and because the two have different jobs — `StepIn.tsx` performs the three acts and
// this one only renders what the last of them answered. It is reached by a relative
// deep import from its host rather than through the family door: nothing outside this
// family renders a step-in receipt, and a door line for it would advertise a seam
// that has no reader.

import { InlineRefusal, WireFigure } from "../../../primitives/index.js";
import type { StepInState } from "./step-in-state.js";

/** What happened, said once, in the daemon's own figures. */
export function StepInReceipt(props: {
  readonly agentLabel: string;
  readonly state: StepInState;
}): React.JSX.Element | null {
  const { state } = props;
  if (state.phase === "refused") {
    return <InlineRefusal code={state.refusal.code} detail={state.refusal.detail} />;
  }
  if (state.phase !== "paused") {
    return null;
  }
  return (
    <span className="meridian-step-in__receipt" role="status">
      Paused {props.agentLabel} at <WireFigure value={state.acknowledgment.currentState} />, version{" "}
      <WireFigure value={String(state.acknowledgment.runVersion)} />. You have the floor.
    </span>
  );
}
