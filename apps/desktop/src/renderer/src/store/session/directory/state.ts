// The sessions on the service, as a view can know them. The service's directory is a different
// question from the set this window has open (`useOpenSessionIds`): a service with six sessions
// and a window that opened none is not empty.

import type {
  SessionListChange,
  SessionListEntry,
} from "@ai-sidekicks/contracts/session/directory";

import type { Unsubscribe } from "#shared/preload-api.js";

/**
 * What a view knows about the service's sessions at one moment. A served list carries
 * `chatCount`, the chats the service counts for the Chats header, so no view counts them.
 * `failed` carries no cause: the cause goes to diagnostic capture, and the screen says only that
 * the list could not be read.
 */
export type SessionDirectoryState =
  | { readonly status: "reading" }
  | {
      readonly status: "served";
      readonly sessions: readonly SessionListEntry[];
      readonly chatCount: number;
    }
  | { readonly status: "failed" };

/**
 * One delivery on the service's session list feed: the list as it stands with its chat count,
 * whole once `isComplete` is true and otherwise continued by `page` changes; one change to it,
 * which carries the count after it; or word that the feed lost its place, so the list is not to
 * be trusted until it is restated.
 */
export type SessionDirectoryFrame =
  | {
      readonly kind: "list";
      readonly sessions: readonly SessionListEntry[];
      readonly chatCount: number;
      readonly isComplete: boolean;
    }
  | { readonly kind: "change"; readonly change: SessionListChange }
  | { readonly kind: "lost" };

/**
 * Open the service's session list feed, handing each frame on, until the handle releases it. The
 * composition supplies it, held stable per window, so `store/` stays below `services/`.
 */
export type SessionDirectoryFeed = (onFrame: (frame: SessionDirectoryFrame) => void) => Unsubscribe;

/**
 * The session `sessionId` as the service's list names it, or `undefined` while the list is not
 * served or does not name that session yet.
 */
export function listedSessionOf(
  directory: SessionDirectoryState,
  sessionId: string,
): SessionListEntry | undefined {
  return directory.status === "served"
    ? directory.sessions.find((session) => session.sessionId === sessionId)
    : undefined;
}
