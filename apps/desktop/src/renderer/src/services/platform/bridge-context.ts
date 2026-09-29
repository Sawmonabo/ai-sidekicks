// The context the bridge provider fills and the hooks read.

import { createContext, type Context } from "react";

import type { ConsoleBridge } from "./platform-bridge.js";

/** Why the window has no bridge at all. Rendered as the "error" kind of nothing. */
export interface BridgeUnavailable {
  readonly reason: "preload-did-not-run";
  readonly detail: string;
}

/** The resolved bridge, or why there is none. */
export type BridgeResolution =
  | { readonly status: "ready"; readonly bridge: ConsoleBridge }
  | { readonly status: "unavailable"; readonly unavailable: BridgeUnavailable };

/** The provider's one value; `undefined` outside the provider. */
export const BridgeContext: Context<BridgeResolution | undefined> = createContext<
  BridgeResolution | undefined
>(undefined);
