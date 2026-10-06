// The sessions on the service, as a view can know them. The service's directory is a different
// question from the set this window has open (`useOpenSessionIds`): a service with six sessions
// and a window that opened none is not empty.

import type {
  SessionListChange,
  SessionListEntry,
} from "@ai-sidekicks/contracts/session/directory";

import type { Unsubscribe } from "#shared/preload-api.js";

/**
 * What a view knows about the service's sessions at one moment. `failed` carries no cause: the
 * cause goes to diagnostic capture, and the screen says only that the list could not be read.
 */
export type SessionDirectoryState =
  | { readonly status: "reading" }
  | { readonly status: "served"; readonly sessions: readonly SessionListEntry[] }
  | { readonly status: "failed" };

/**
 * One delivery on the service's session list feed: the list as it stands, one change to it, or
 * word that the feed lost its place, so the list is not to be trusted until it is restated.
 */
export type SessionDirectoryFrame =
  | { readonly kind: "list"; readonly sessions: readonly SessionListEntry[] }
  | { readonly kind: "change"; readonly change: SessionListChange }
  | { readonly kind: "lost" };

/**
 * Open the service's session list feed, handing each frame on, until the handle releases it. The
 * composition supplies it, held stable per window, so `store/` stays below `services/`.
 */
export type SessionDirectoryFeed = (onFrame: (frame: SessionDirectoryFrame) => void) => Unsubscribe;
