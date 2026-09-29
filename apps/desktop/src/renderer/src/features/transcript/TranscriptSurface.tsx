import type { ReactNode } from "react";

import "./transcript.css";

export interface TranscriptSurfaceProps {
  readonly children: ReactNode;
}

/**
 * The session screen's full-height wrapper, which lets the pane layout inside it scroll
 * rather than the window.
 *
 * It imports the feature's shared sheet, so the sheet loads with the eagerly registered
 * screen rather than with the lazy pane chunk.
 */
export function TranscriptSurface(props: TranscriptSurfaceProps): React.JSX.Element {
  return <div className="meridian-ledger-surface">{props.children}</div>;
}
