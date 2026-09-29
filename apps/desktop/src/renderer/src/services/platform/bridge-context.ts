// The contexts the bridge provider fills and the hooks read.

import { createContext, type Context } from "react";

import type { SessionDiagnostics } from "../session-events/session-diagnostics-handle.js";
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

/**
 * How a window that was handed no bridge builds one, and what it puts on the page for a
 * driver to read.
 *
 * The provider calls it and knows nothing of what it builds: a window with no composition
 * reads the preload, and one with a composition plays whatever the composition built. The
 * installs return their removal, so a replaced bridge or a closed window takes down exactly
 * what it put up.
 */
export interface BridgeComposition {
  /** Build the bridge. The provider disposes the scenario engine of a bridge built here. */
  createBridge(): ConsoleBridge;
  /** Put what a driver reads about this bridge on the page. */
  installBridgeHandles(bridge: ConsoleBridge): () => void;
  /** Put what a driver reads about this window's session subscriptions on the page. */
  installSessionDiagnostics(diagnostics: SessionDiagnostics): () => void;
}

/** The composition the provider was given; `undefined` for a window that reads the preload. */
export const BridgeCompositionContext: Context<BridgeComposition | undefined> = createContext<
  BridgeComposition | undefined
>(undefined);

/** The resolved bridge, or why there is none; `undefined` outside the provider. */
export const BridgeContext: Context<BridgeResolution | undefined> = createContext<
  BridgeResolution | undefined
>(undefined);
