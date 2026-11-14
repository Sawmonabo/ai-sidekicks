// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// What every method table shares: the payload of a method whose request or reply carries nothing, and the `null` reply of an act that reads nothing back.

/**
 * A request or reply that carries nothing: the method's whole effect is what it changed. Any
 * member is refused.
 */
export type EmptyPayload = Record<string, never>;
/**
 * The reply of an act that reads nothing back: `null`.
 */
export type NullPayload = null;

export { validateEmptyPayload, validateNullPayload } from "./checks/method-descriptor.js";
