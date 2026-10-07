// The line under a message or steer the background service took and could not hand to the agent:
// red words and a faint `Retry` at the line's right end, which sends again what the box holds.

import { TryAgainButton } from "#renderer/components/TryAgainButton/TryAgainButton.js";
import { NOT_DELIVERED_WORDS } from "../not-delivered.js";

import "./NotDeliveredLine.css";

/** Props for `NotDeliveredLine`. */
export interface NotDeliveredLineProps {
  /** The undelivered dispatch's `failureReason`, carried on the root for diagnostics. */
  readonly failureReason: string;
  /** Sends the box's text again, through the same path as its Send. */
  readonly onRetry: () => void;
}

/** `Not delivered · Retry`, in red, under the box that still holds the text. */
export function NotDeliveredLine(props: NotDeliveredLineProps): React.JSX.Element {
  return (
    <p
      className="meridian-composer__not-delivered"
      role="status"
      data-refusal-code={props.failureReason}
    >
      {`${NOT_DELIVERED_WORDS} · `}
      <TryAgainButton word="Retry" onPress={props.onRetry} />
    </p>
  );
}
