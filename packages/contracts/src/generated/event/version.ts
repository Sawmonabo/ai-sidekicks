// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The leaf of the session event contracts: the envelope's version. It imports no other event module, so every one of them can import it.

/**
 * A producer's "MAJOR.MINOR" protocol version, written at emit time and never rewritten on read.
 */
export type EventEnvelopeVersion = string & { readonly __brand: "EventEnvelopeVersion" };

export { validateEventEnvelopeVersion } from "../checks/event/version.js";
