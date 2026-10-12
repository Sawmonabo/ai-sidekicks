import { useState } from "react";

import { PaneLayoutStore } from "../store.js";

/**
 * Holds one layout store for the lifetime of the component that owns it.
 *
 * Construction stays out of the render body, where React may discard the result and leave
 * subscribers on a store nothing mutates.
 */
export function usePaneLayoutStore(): PaneLayoutStore {
  const [layout] = useState(() => new PaneLayoutStore());
  return layout;
}
