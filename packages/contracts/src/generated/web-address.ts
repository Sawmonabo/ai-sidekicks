// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The one rule every web address the app opens is held to: only `http:` and `https:`.

/**
 * The schemes a web address may carry, in the WHATWG parser's form, which is always lower
 * case and ends in a colon.
 */
export const WEB_ADDRESS_SCHEMES = ["http:", "https:"] as const;

/** Every [`WebAddressFault`]. */
export const WEB_ADDRESS_FAULTS = ["scheme"] as const;

/**
 * Why a parsed address is not a web address the app opens: `scheme` when its scheme is neither
 * `http:` nor `https:`.
 */
export type WebAddressFault = "scheme";
