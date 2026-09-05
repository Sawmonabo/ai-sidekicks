// The terminal chip: the wire's own state string, or the refusal's own code.
//
// Its own module because a `.tsx` declares one component. It stays a sibling of
// `InterventionRow.tsx` and is reached by its deep import alone — nothing else
// renders an intervention's terminal, and a door line for it would advertise a seam
// with no reader.

import { Chip } from "../../../primitives/index.js";
import type { RunControlRecord } from "../controls/run-control-surface.js";

/**
 * The tone each of the six intervention states takes. Total over the closed set.
 *
 * `degraded` is `attention` and not `failure`: a degraded steer is a real outcome
 * rather than an error, and colouring it as a failure would be the console
 * disagreeing with the daemon about what happened.
 */
const TERMINAL_TONES = {
  requested: "neutral",
  accepted: "neutral",
  applied: "accent",
  rejected: "failure",
  degraded: "attention",
  expired: "attention",
} as const satisfies Readonly<Record<string, "neutral" | "accent" | "attention" | "failure">>;

/** The terminal chip: the wire's own state string, or the refusal's own code. */
export function InterventionTerminal(props: {
  readonly record: RunControlRecord;
}): React.JSX.Element {
  const { outcome } = props.record;
  if (outcome.kind === "refused") {
    return <Chip tone="failure" label={outcome.refusal.code} mono />;
  }
  if (outcome.kind === "acknowledged") {
    return <Chip tone="accent" label={outcome.ack.currentState} mono />;
  }
  return <Chip tone={TERMINAL_TONES[outcome.response.state]} label={outcome.response.state} mono />;
}
