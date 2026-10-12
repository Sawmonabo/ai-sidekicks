// The hidden frames content is laid out in so it can be measured before a reader sees it: long
// tables before their rows are listed, a long output's undrawn lines, and a long diff's undrawn
// steps of rows. The frames sit in the
// window's document, outside the conversation, where no reader, selection or Find reaches them.

import { createPortal } from "react-dom";

import "./MeasuringFrames.css";

/** What the hidden frames hold, and the document they are drawn in. */
export interface MeasuringFramesProps {
  /** The window's own document, whose fonts the frames are set in. */
  readonly ownerDocument: Document;
  readonly children: React.ReactNode;
}

/** Draws `children` laid out but hidden, in the body of `ownerDocument`. */
export function MeasuringFrames(props: MeasuringFramesProps): React.ReactPortal {
  return createPortal(
    <div className="meridian-measuring-frames" aria-hidden="true" inert>
      {props.children}
    </div>,
    props.ownerDocument.body,
  );
}
