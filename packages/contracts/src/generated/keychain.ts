// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// Why this machine's keychain could not be used: the one cause a refused seal or erase carries.

/** Every [`KeychainRefusalCause`], one line each on the paste-token and erase refusals. */
export const KEYCHAIN_REFUSAL_CAUSES = ["locked", "unavailable"] as const;

/**
 * Why this machine's keychain could not be used: it is `locked`, or it cannot be used now or at
 * all (`unavailable`). A secret that cannot be sealed is refused and stored nowhere else.
 */
export type KeychainRefusalCause = "locked" | "unavailable";

export { validateKeychainRefusalCause } from "./checks/keychain.js";
