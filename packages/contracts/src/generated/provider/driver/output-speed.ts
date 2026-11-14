// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The provider's own report of its accelerated-output state on one binding.

/**
 * The provider's own report of its accelerated-output state, held for the binding's life from the
 * first declaration the provider makes; absent until then and never stored.
 */
export interface ProviderOutputSpeedState {
  /**
   * The provider's level as sent; a level the driver does not list is kept, not coerced.
   */
  declared: string;
  /**
   * The provider's own explanation, where it gave one.
   */
  reason?: string;
}

export { validateProviderOutputSpeedState } from "../../checks/provider/driver/output-speed.js";
