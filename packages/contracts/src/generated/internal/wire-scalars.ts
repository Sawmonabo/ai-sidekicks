// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The scalars every contract module shares: an instant and a calendar date on the wire, a count, the text the daemon composes, text that is not blank, a port and the placeholder a byte member is written as.

/**
 * An RFC 3339 instant with its offset, as a peer sent it.
 */
export type WireInstant = string;
/**
 * An ISO 8601 calendar date, `YYYY-MM-DD`, as a peer sent it.
 */
export type WireDate = string;
/**
 * A count of things, or a number of seconds or bytes: a whole number, zero or more.
 */
export type SafeInt0 = number;
/**
 * Text the daemon composed: a path, a provider's words, a name; never empty.
 */
export type ComposedText = string;
/**
 * Text holding at least one character outside ECMAScript's `\s` set; unlike free-form text it
 * may hold a NUL.
 */
export type NonBlankText = string;
/**
 * A TCP port number: a whole number from 1 to 65535.
 */
export type Port = number;
/**
 * Bytes that travel beside the message's JSON, as the attachment the placeholder names.
 */
export type Bytes = Uint8Array;

export {
  validateBytes,
  validateComposedText,
  validateNonBlankText,
  validatePort,
  validateSafeInt0,
  validateWireDate,
  validateWireInstant,
} from "../checks/internal/wire-scalars.js";
