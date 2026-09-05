import { type ReactNode } from "react";
import { InlineRefusal, Nothing } from "../../../primitives/index.js";
import { type CostReceiptOutcome } from "./cost-receipt-model.js";
import { ServedReceipt } from "./ServedReceipt.js";

/** The four states a session-scoped read can be in, and what each one renders. */
export function ReceiptBody(props: {
  readonly sessionId: string | undefined;
  readonly outcome: CostReceiptOutcome | undefined;
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
  if (props.outcome === undefined) {
    return (
      <Nothing kind="not-loaded" placement="surface" title="Reading this session's receipt." />
    );
  }
  if (props.outcome.status === "unavailable") {
    return <InlineRefusal code={props.outcome.code} detail={props.outcome.detail} />;
  }
  return <ServedReceipt receipt={props.outcome.value} />;
}
