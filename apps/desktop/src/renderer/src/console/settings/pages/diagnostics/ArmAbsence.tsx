// The two arms of a diagnostics reading that are not an answer.
//
// TWO DIFFERENT ABSENCES AND NEVER ONE. `unasked` is `not-checked` — the console put
// no question, because there was no run to address it to or no session open at all —
// and `refused` is `error`, carrying the refuser's own code and sentence verbatim. A
// page that rendered both as "nothing to show" would let a machine nobody asked about
// read exactly like a machine that reported nothing wrong, which is the one confusion
// this whole surface exists to prevent.
//
// GENERIC OVER THE SERVED VALUE IT WILL NEVER RENDER, so one component serves all four
// regions and none of them has to widen its own arm union to reach it. The `served`
// arm returns `null` rather than throwing: the caller has already narrowed on it and
// rendered the reading, and a component whose job is the absences should not be the
// thing that fails when it is handed a presence.

import type { ReactNode } from "react";

import { Nothing } from "../../../primitives/index.js";
import type { DiagnosticsArm } from "./diagnostics-reading.js";

export function ArmAbsence<TValue>(props: {
  readonly arm: DiagnosticsArm<TValue>;
  /** What this region would have shown, said as the thing that did not happen. */
  readonly unaskedTitle: string;
}): ReactNode {
  const { arm, unaskedTitle } = props;
  if (arm.kind === "refused") {
    return (
      <Nothing
        kind="error"
        placement="surface"
        title={arm.refusal.code}
        detail={arm.refusal.detail}
      />
    );
  }
  if (arm.kind === "unasked") {
    return (
      <Nothing kind="not-checked" placement="surface" title={unaskedTitle} detail={arm.because} />
    );
  }
  return null;
}
