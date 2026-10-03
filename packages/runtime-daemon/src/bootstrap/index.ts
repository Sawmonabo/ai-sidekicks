// Daemon bootstrap: runs `SecureDefaults.load` ahead of any listener bind, and exposes the
// load-before-bind guard the local IPC gateway calls at the top of its bind path.
//
// Binding a listener before `SecureDefaults.load` has completed is a programmer error and
// throws. The guard is stateless because `SecureDefaults` already owns the load state;
// the trade is that each bind path must call `assertLoadedForBind()` itself.

import type { SecureDefaultsConfig } from "./secure-defaults.js";
import { SecureDefaults } from "./secure-defaults.js";

/**
 * Run the daemon bootstrap sequence: `SecureDefaults.load(config)`, which must
 * precede every listener `bind()` so the validated settings are in force before
 * any IPC entry point is reachable.
 *
 * Throws `SecureDefaultsValidationError` on any validation failure and keeps
 * the settings already loaded; a later successful call replaces them.
 */
export function bootstrap(config: SecureDefaultsConfig): void {
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
