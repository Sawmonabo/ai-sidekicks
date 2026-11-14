// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The scalars the git modules share.

/**
 * A commit's short id, git's own abbreviation, which is as long as the repository needs.
 */
export type GitShortObjectId = string;
/**
 * An id the hosting service minted (a thread, a comment, a check), opaque to every client.
 */
export type HostHandle = string & { readonly __brand: "HostHandle" };
/**
 * A change request's number on its host: `#482` on GitHub, `!482` on GitLab.
 */
export type ChangeRequestNumber = number;
/**
 * An `http:` or `https:` address on the hosting service, written with its `//` and opened in
 * the system browser.
 */
export type HostingAddress = string;

export {
  validateChangeRequestNumber,
  validateGitShortObjectId,
  validateHostHandle,
  validateHostingAddress,
} from "../checks/git/shared.js";
