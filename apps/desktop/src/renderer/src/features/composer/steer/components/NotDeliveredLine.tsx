// The line under a child's steer box when the background service took the steer and could not
// hand it to the child: red words, and `Retry` at the line's right end in the same red, which
// sends that steer again.
// Not a live region: the words speak through the app's announcer, on the assertive lane a failure
// takes, so a retry that fails again says them again.

import { TryAgainButton } from "#renderer/components/TryAgainButton/TryAgainButton.js";
import { useAnnounceWhenChanged } from "#renderer/hooks/announce/useAnnounceWhenChanged.js";
import { NOT_DELIVERED_WORDS } from "../not-delivered.js";

import "./NotDeliveredLine.css";

/** Props for `NotDeliveredLine`. */
export interface NotDeliveredLineProps {
  /** Why the delivery failed, in the daemon's own word, carried on the root for diagnostics. */
  readonly failureReason: string;
  /** Sends the steer that was not delivered again, under its own key. */
  readonly onRetry: () => void;
  /**
   * The delivery this line answers: a new value, a retry that failed too, says the words again.
   * Keep its identity across renders.
   */
  readonly attempt: unknown;
}

/** `Not delivered · Retry`, in red, under the box that still holds the text. */
export function NotDeliveredLine(props: NotDeliveredLineProps): React.JSX.Element {
  useAnnounceWhenChanged(NOT_DELIVERED_WORDS, "assertive", { attempt: props.attempt });
  return (
    <p className="meridian-composer__not-delivered" data-refusal-code={props.failureReason}>
      {`${NOT_DELIVERED_WORDS} · `}
      <TryAgainButton word="Retry" onPress={props.onRetry} />
    </p>
  );
}
