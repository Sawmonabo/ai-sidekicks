import { useContext } from "react";

import { PaneControlsContext, type PaneControls } from "./controls.js";

/** The host's acts for the pane this component is inside, or `undefined`. */
export function usePaneControls(): PaneControls | undefined {
  return useContext(PaneControlsContext);
}
