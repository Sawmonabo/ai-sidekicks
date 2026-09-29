import { useState } from "react";

import { PaneLayoutStore, type PaneLayoutStoreOptions } from "../pane-layout-store.js";

/**
 * Hold one layout for the lifetime of the component that owns the deck.
 *
 * A hook rather than a construction in a render body: store construction stays out of
 * render, and a `new PaneLayoutStore()` evaluated during a render React discards would
 * leave the deck subscribed to a layout nothing will ever mutate again.
 */
export function usePaneLayoutStore(options: PaneLayoutStoreOptions): PaneLayoutStore {
  const [layout] = useState(() => new PaneLayoutStore(options));
  return layout;
}
