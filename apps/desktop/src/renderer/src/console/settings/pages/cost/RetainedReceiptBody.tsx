// The last figure served, under the notice that says why it is the last one.
//
// Its own module because it is one subject and two of `ReceiptBody.tsx`'s arms reach
// it: what to render when the current read has not answered. The notice above it is
// the caller's — it is the caller that knows whether the read is in flight or refused,
// and paraphrasing either here would put a second sentence beside the daemon's own.
//
// A RETAINED FIGURE IS NEVER PRESENTED AS CURRENT. It carries the instant it was
// served and is drawn under the notice rather than beside it, so the order a person
// reads is "this is not confirmed" and then the number — never the number first.
//
// The instant carries its DAY as well as its clock reading, through the console's
// dated formatter rather than its bare one. `formatClockTime` is for a row sitting
// under a day divider that carries the date once, and a settings page has no such
// divider — a window left open overnight would otherwise stamp yesterday's receipt
// with a reading indistinguishable from this morning's.

import { type ReactNode } from "react";

import { WireFigure, formatDateTime } from "../../../primitives/index.js";
import { type RetainedReceipt } from "./cost-receipt-model.js";
import { ServedReceipt } from "./ServedReceipt.js";

export function RetainedReceiptBody(props: {
  readonly retained: RetainedReceipt | undefined;
  /** What the current read has to say — a settlement notice or the daemon's refusal. */
  readonly notice: ReactNode;
}): ReactNode {
  if (props.retained === undefined) {
    return props.notice;
  }
  return (
    <>
      {props.notice}
      <p className="meridian-cost-receipt__retained-note">
        Below is the last receipt this session was served, at{" "}
        <WireFigure
          value={formatDateTime(props.retained.readAtIso)}
          title={props.retained.readAtIso}
        />
        . It is not being confirmed right now, and nothing here has been recalculated.
      </p>
      <ServedReceipt receipt={props.retained.receipt} />
    </>
  );
}
