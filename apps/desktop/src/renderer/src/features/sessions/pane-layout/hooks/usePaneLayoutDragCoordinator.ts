import { useState } from "react";

import { DeckDragCoordinator } from "../pane-drag.js";

/** Hold one coordinator for the lifetime of the deck that owns it. */
export function useDeckDragCoordinator(): DeckDragCoordinator {
  const [coordinator] = useState(() => new DeckDragCoordinator());
  return coordinator;
}
