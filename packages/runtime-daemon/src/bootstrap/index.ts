// Daemon bootstrap orchestrator — sequences `SecureDefaults.load` ahead of any
// listener bind, and exposes the load-before-bind guard the local IPC gateway
// calls at the top of its bind path.
//
// Invariant: `SecureDefaults.load(config)` MUST run before any daemon listener
// binds. Binding a listener before `SecureDefaults.load` completes is a
// programmer error and MUST throw.
//
// The daemon binds only its OS-local socket or named pipe; `/metrics` is its
// one network listener.
//
// Design: a stateless guard (`assertLoadedForBind`) plus a sequence
// orchestrator (`bootstrap`), rather than a `BootstrapHandle` that bind paths
// take as proof of load. `SecureDefaults` already owns the load-state
// singleton (`SecureDefaults.isLoaded()`); a handle would duplicate that state
// without runtime enforcement (handle-as-evidence is a TypeScript-only
// convention a caller could construct out-of-band), and the guard lets every
// bind path check synchronously without threading a handle through
// constructors. The trade: each bind path must call `assertLoadedForBind()`
// itself.

import type { SecureDefaultsConfig } from "./secure-defaults.js";
import { SecureDefaults } from "./secure-defaults.js";

/**
 * Run the daemon bootstrap sequence: `SecureDefaults.load(config)`, which must
 * precede every listener `bind()` so the validated settings are in force before
 * any IPC entry point is reachable.
 *
 * Throws `SecureDefaultsValidationError` on any validation failure and keeps
 * the previously loaded settings; a later successful call replaces them.
 */
export function bootstrap(config: SecureDefaultsConfig): void {
  // `SecureDefaults.load` runs FIRST so every listener the daemon subsequently
  // exposes is gated on the validated settings.
  SecureDefaults.load(config);
}

/**
 * Throws when a listener tries to bind before `SecureDefaults.load(config)` has
 * completed; every bind path calls it first. The throw is a programmer-error
 * guard, fixed by calling `bootstrap(config)` earlier, never by retrying.
 */
export function assertLoadedForBind(): void {
  if (!SecureDefaults.isLoaded()) {
    throw new Error(
      "assertLoadedForBind: SecureDefaults.load(config) must complete before any listener bind()",
    );
  }
}
