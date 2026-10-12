// Tells a message row when its markdown body first draws anything, so the reply's foot never
// stands over a body still waiting for its first tree.

import { createContext, type Context } from "react";

/** Hears that a markdown body has drawn; `undefined` where no row listens. */
export const MarkdownFirstDrawContext: Context<(() => void) | undefined> = createContext<
  (() => void) | undefined
>(undefined);
