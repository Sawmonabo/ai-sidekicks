import type { ReactNode } from "react";

import "./transcript.css";

export interface SessionScreenContainerProps {
  readonly children: ReactNode;
}

/**
 * The session screen's full-height wrapper. It imports the feature's shared sheet so the
 * sheet loads with the eagerly registered screen, not with the lazy pane chunk.
 */
export function SessionScreenContainer(props: SessionScreenContainerProps): React.JSX.Element {
  return <div className="meridian-session-screen-container">{props.children}</div>;
}
