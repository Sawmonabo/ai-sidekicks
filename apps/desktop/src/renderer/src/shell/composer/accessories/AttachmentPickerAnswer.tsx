// What the attachment picker's seat says once the daemon has answered it.
//
// Split from `AttachmentPickerSeat.tsx`, which owns the ask and the state it
// advances, while this owns the sentence each phase renders.
//
// EVERY PHASE RENDERS SOMETHING, INCLUDING THE ONES THAT ARE NOT ANSWERS. A picker
// that was never asked and one whose ask was refused are different facts, and a
// surface that showed nothing for both would report the refusal as a state nobody
// had reached yet.

import { InlineRefusal, Nothing, formatByteQuantity } from "../../../console/primitives/index.js";
import { ATTACHMENT_CARRIER_COUNT_CAP } from "./accessory-bounds.js";
import { type PickerState } from "./attachment-picker-state.js";

/**
 * What the allow-list read answered.
 *
 * The served arm is reachable only from a fixture that serves the growth port, and
 * it is written out rather than left for later so the surface has one shape whether
 * or not the wire is registered — the day the wire lands, this file's diff is the
 * port entry's, not this component's.
 */
export function AttachmentPickerAnswer(props: {
  readonly state: PickerState;
}): React.JSX.Element | null {
  const { state } = props;
  if (state.phase === "unasked") {
    return null;
  }
  if (state.phase === "asking") {
    return <Nothing kind="computing" title="Reading what this session accepts." />;
  }
  if (state.phase === "refused") {
    return <InlineRefusal code={state.refusal.code} detail={state.refusal.detail} />;
  }
  return (
    <p className="meridian-attachment-seat__hint">
      Up to {String(ATTACHMENT_CARRIER_COUNT_CAP)} files on one send, each at most{" "}
      {formatByteQuantity(state.maximumByteLength).text}. The session accepts{" "}
      {state.contentTypes.join(", ")}. This is a hint from the daemon, not a gate the console
      enforces.
    </p>
  );
}
