// The sessions on the service, as a view can know them. The service's directory is a different
// question from the set this window has open (`useOpenSessionIds`): a service with six sessions
// and a window that opened none is not empty.

import type { SessionShape } from "@ai-sidekicks/contracts/session/methods";

/**
 * One session the service lists. A session with no title reads by its shape, `New chat` or
 * `New session` (see `sessionDisplayTitleOf` in `display-title.ts`).
 */
export interface SessionDirectoryEntry {
  readonly sessionId: string;
  readonly title?: string;
  readonly shape: SessionShape;
  readonly state: string;
}

/** The call that lists the service's sessions. */
export type SessionDirectoryReadCall = (
  signal: AbortSignal,
) => Promise<readonly SessionDirectoryEntry[]>;

/**
 * What a view knows about the service's sessions at one moment. `failed` carries no cause: the
 * cause goes to diagnostic capture, and the screen says only that the list could not be read.
 */
export type SessionDirectoryState =
  | { readonly status: "reading" }
  | { readonly status: "served"; readonly sessions: readonly SessionDirectoryEntry[] }
  | { readonly status: "failed" };
