// The past-tense receipt a settled machine turn leaves.
//
// Its own module for the one-component rule, and the split keeps the cost chokepoint
// visible: this line reports the body's recorded size and media type and NOTHING
// metered, because a card that summed or restated a cost would be the second source of
// truth that chokepoint exists to prevent.

import { formatByteQuantity } from "../../primitives/index.js";

export interface MessageReceiptProps {
  readonly contentType: string | undefined;
  readonly contentLength: number | undefined;
}

/**
 * What the row itself recorded about its body, on one line.
 *
 * `Spec-023 §Console Design (Meridian)`'s receipt rule is that an action lands as a
 * record of what happened, so this line reports only what the row itself carries — the
 * body's recorded size and the media type its producer set.
 *
 * A turn that carries neither renders no receipt at all, rather than a line saying
 * nothing was recorded — an absence of descriptive members is the ordinary case for a
 * body-less row and not a fact worth a line in the log.
 */
export function MessageReceipt(props: MessageReceiptProps): React.JSX.Element | null {
  if (props.contentType === undefined && props.contentLength === undefined) {
    return null;
  }
  return (
    <p className="meridian-message-card__receipt">
      Recorded
      {props.contentLength === undefined
        ? null
        : ` · ${formatByteQuantity(props.contentLength).text}`}
      {props.contentType === undefined ? null : ` · ${props.contentType}`}
    </p>
  );
}
