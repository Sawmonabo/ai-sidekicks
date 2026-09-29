import { useState } from "react";

import { PaneLayoutDragCoordinator } from "../pane-drag.js";

/** Hold one coordinator for the lifetime of the deck that owns it. */
export function usePaneLayoutDragCoordinator(): PaneLayoutDragCoordinator {
  const [coordinator] = useState(() => new PaneLayoutDragCoordinator());
  return coordinator;
}
