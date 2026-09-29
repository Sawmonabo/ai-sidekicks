import { useState } from "react";

import { DeckLayout, type DeckLayoutOptions } from "../pane-layout-store.js";

/**
 * Hold one layout for the lifetime of the component that owns the deck.
 *
 * A hook rather than a construction in a render body: store construction stays out of
 * render, and a `new DeckLayout()` evaluated during a render React discards would
 * leave the deck subscribed to a layout nothing will ever mutate again.
 */
export function useDeckLayout(options: DeckLayoutOptions): DeckLayout {
  const [layout] = useState(() => new DeckLayout(options));
  return layout;
}
