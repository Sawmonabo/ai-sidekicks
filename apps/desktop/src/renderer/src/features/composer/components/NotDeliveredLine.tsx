// The line under a message or steer the background service took and could not hand to the agent:
// red words and a faint `Retry` at the line's right end that sends the same text again.

import { TryAgainButton } from "#renderer/components/TryAgainButton/TryAgainButton.js";
import { type Refusal } from "#renderer/lib/refusal/contract.js";

import "./NotDeliveredLine.css";

/** Props for `NotDeliveredLine`. */
export interface NotDeliveredLineProps {
  /** The undelivered refusal: its detail is the line's words, its code rides on the root. */
  readonly refusal: Pick<Refusal, "code" | "detail">;
  /** Sends the same text again. */
  readonly onRetry: () => void;
}

/** `Not delivered · Retry`, in red, under the box that still holds the text. */
export function NotDeliveredLine(props: NotDeliveredLineProps): React.JSX.Element {
  return (
    <p
      className="meridian-composer__not-delivered"
      role="status"
      data-refusal-code={props.refusal.code}
    >
      {`${props.refusal.detail} · `}
      <TryAgainButton word="Retry" onPress={props.onRetry} />
    </p>
  );
}
