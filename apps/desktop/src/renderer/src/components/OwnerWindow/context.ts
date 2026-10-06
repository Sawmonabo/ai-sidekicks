import { createContext, type Context } from "react";

/**
 * The window the tree below is drawn in, provided by `OwnerWindowProvider`; `undefined` outside
 * any, where the global is it.
 */
export const OwnerWindowContext: Context<Window | undefined> = createContext<Window | undefined>(
  undefined,
);
