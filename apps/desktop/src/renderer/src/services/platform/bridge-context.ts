// The contexts the bridge provider fills and the hooks read.

import { createContext, type Context } from "react";

import type { Clock } from "@renderer/lib/clock.js";
import type { SessionDiagnostics } from "../session-events/session-diagnostics-handle.js";
import type { PlatformBridge } from "./platform-bridge.js";

/** Why the window has no bridge at all. Rendered as the "error" kind of nothing. */
export interface BridgeUnavailable {
  readonly reason: "preload-did-not-run";
  readonly detail: string;
}

/**
 * The resolved bridge and the clock its window runs on, or why there is none. The clock
 * is the resolution's, not the bridge's: it is not a host capability.
 */
export type BridgeResolution =
  | { readonly status: "ready"; readonly bridge: PlatformBridge; readonly clock: Clock }
  | { readonly status: "unavailable"; readonly unavailable: BridgeUnavailable };

/** The end of what a composition built: the provider disposes it once, and reads whether it ran. */
export interface BridgeDisposal {
  dispose(): void;
  readonly isDisposed: boolean;
}

/** A bridge a composition built, the clock its window runs on, and what ends them. */
export interface ComposedBridge {
  readonly bridge: PlatformBridge;
  readonly clock: Clock;
  readonly disposal: BridgeDisposal;
  /** Put what a driver reads about this bridge on the page, and return the removal. */
  installHandles(): () => void;
}

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
  /** Build the bridge. The provider disposes what it builds here. */
  createBridge(): ComposedBridge;
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
