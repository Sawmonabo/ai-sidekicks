// The five states a session-scoped read can be in, and what each one renders.
//
// TWO OF THEM NO LONGER BLANK THE FIGURE. A read in flight and a read refused both
// replaced the receipt with an absence, so a window coming back from elsewhere lost
// the number it had been showing and a refusal arrived with nothing to weigh it
// against. Where this page has been served a figure for THIS session, that figure
// stays on screen and the notice above it says what it is: the last one served, when
// it was served, and why it is not being confirmed right now.
//
// The retained figure is never presented as current. It carries its own instant and
// the reading's own words above it, which is the difference between showing stale
// data and hiding that it is stale.

import { type ReactNode } from "react";
import { InlineRefusal, Nothing } from "../../../primitives/index.js";
import { type CostReceiptReading, type RetainedReceipt } from "./cost-receipt-model.js";
import { RetainedReceiptBody } from "./RetainedReceiptBody.js";
import { ServedReceipt } from "./ServedReceipt.js";

export function ReceiptBody(props: {
  readonly sessionId: string | undefined;
  readonly reading: CostReceiptReading | undefined;
  /** The last figure served for this session, where one has been. */
  readonly retained: RetainedReceipt | undefined;
}): ReactNode {
  if (props.sessionId === undefined) {
    return (
      <Nothing
        kind="empty"
        placement="surface"
        title="The receipt belongs to a session, and this window has opened none."
        detail="Open a session from the Sessions list and its receipt renders here. Nothing was asked of the accountant for a session nobody has opened."
      />
    );
  }
  if (props.reading === undefined) {
    return (
      <RetainedReceiptBody
        retained={props.retained}
        notice={
          <Nothing kind="not-loaded" placement="surface" title="Reading this session's receipt." />
        }
      />
    );
  }
  // Two refusals, one shape: a port that answered `unavailable` and a call that
  // produced no answer at all are the same thing to a person reading the page — the
  // figure is not here and this is why — and they are kept apart in the value
  // because only one of them is the port speaking.
  if (props.reading.kind === "unreadable") {
    return (
      <RetainedReceiptBody
        retained={props.retained}
        notice={<InlineRefusal {...props.reading.refusal} />}
      />
    );
  }
  if (props.reading.outcome.status === "unavailable") {
    return (
      <RetainedReceiptBody
        retained={props.retained}
        notice={
          <InlineRefusal code={props.reading.outcome.code} detail={props.reading.outcome.detail} />
        }
      />
    );
  }
  return <ServedReceipt receipt={props.reading.outcome.value} />;
}
