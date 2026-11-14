// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The open id a provider's driver answers to, checked against the registered drivers wherever a request or a provider message brings one in.

/**
 * A provider's id as its driver declares it: a lowercase letter, then up to 31 lowercase
 * letters, digits or hyphens. Opaque to every client, which never branches on its value.
 */
export type ProviderId = string & { readonly __brand: "ProviderId" };

export { validateProviderId } from "../checks/provider/id.js";
