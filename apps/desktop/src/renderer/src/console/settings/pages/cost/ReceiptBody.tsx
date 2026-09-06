import { type ReactNode } from "react";
import { InlineRefusal, Nothing } from "../../../primitives/index.js";
import { type CostReceiptReading } from "./cost-receipt-model.js";
import { ServedReceipt } from "./ServedReceipt.js";

/** The five states a session-scoped read can be in, and what each one renders. */
export function ReceiptBody(props: {
  readonly sessionId: string | undefined;
  readonly reading: CostReceiptReading | undefined;
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
      <Nothing kind="not-loaded" placement="surface" title="Reading this session's receipt." />
    );
  }
  // Two refusals, one shape: a port that answered `unavailable` and a call that
  // produced no answer at all are the same thing to a person reading the page — the
  // figure is not here and this is why — and they are kept apart in the value
  // because only one of them is the port speaking.
  if (props.reading.kind === "unreadable") {
    return <InlineRefusal {...props.reading.refusal} />;
  }
  if (props.reading.outcome.status === "unavailable") {
    return (
      <InlineRefusal code={props.reading.outcome.code} detail={props.reading.outcome.detail} />
    );
  }
  return <ServedReceipt receipt={props.reading.outcome.value} />;
}
