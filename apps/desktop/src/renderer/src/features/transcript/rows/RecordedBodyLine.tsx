// The receipt a settled machine turn leaves: the body's recorded size and media type, and
// nothing metered, so no card becomes a second source of cost.

import { formatByteQuantity } from "@renderer/lib/wire-figures.js";

/** The descriptive members a row recorded about its body. */
export interface RecordedBodyLineProps {
  readonly contentType: string | undefined;
  readonly contentLength: number | undefined;
}

/**
 * What the row itself recorded about its body, on one line: the recorded size and the media
 * type its producer set. A turn that carries neither renders no receipt, since absent
 * descriptors are the ordinary case for a body-less row.
 */
export function RecordedBodyLine(props: RecordedBodyLineProps): React.JSX.Element | null {
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
