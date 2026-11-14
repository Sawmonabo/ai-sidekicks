// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The id of a runtime binding, one live session's leg on its provider.

/**
 * The id of a runtime binding, one live session's leg on its provider: minted by the
 * daemon's store, or by the driver for a leg it relaunched. Opaque to every client.
 */
export type RuntimeBindingId = string & { readonly __brand: "RuntimeBindingId" };

export { validateRuntimeBindingId } from "../../checks/provider/driver/runtime-binding.js";
