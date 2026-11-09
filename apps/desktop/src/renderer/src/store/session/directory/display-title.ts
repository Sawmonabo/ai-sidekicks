// What a session is called on screen: its name, the first message's preview while it has none,
// or the words an untitled session reads by.

import type { SessionListEntry } from "@ai-sidekicks/contracts/session/directory";
import {
  UNTITLED_CHAT_NAME,
  UNTITLED_PROJECT_NAME,
  type SessionShape,
} from "@ai-sidekicks/contracts/session/methods";

/** The words a session is named by on screen, and whether they stand in for a missing title. */
export interface SessionDisplayTitle {
  readonly text: string;
  readonly isUntitled: boolean;
}

/** What a session's on-screen title is chosen from, its shape absent where nothing named it. */
export type SessionTitleSource = {
  readonly [Member in "name" | "firstMessagePreview"]?: SessionListEntry[Member] | undefined;
} & {
  readonly shape: SessionShape | undefined;
};

/**
 * What a session is called wherever a surface names it: its name, else its first message's
 * preview, else the contracts' untitled words for its shape, which a surface draws faint and
 * italic. `undefined` only where the shape is unknown too, so nothing names it.
 */
export function sessionDisplayTitleOf(
  source: SessionTitleSource & { readonly shape: SessionShape },
): SessionDisplayTitle;
export function sessionDisplayTitleOf(source: SessionTitleSource): SessionDisplayTitle | undefined;
export function sessionDisplayTitleOf(source: SessionTitleSource): SessionDisplayTitle | undefined {
  const text = source.name ?? source.firstMessagePreview;
  if (text !== undefined) {
    return { text, isUntitled: false };
  }
  return source.shape === undefined
    ? undefined
    : { text: UNTITLED_SESSION_WORDS[source.shape], isUntitled: true };
}

// What an untitled session reads, by its shape.
const UNTITLED_SESSION_WORDS: Readonly<Record<SessionShape, string>> = {
  chat: UNTITLED_CHAT_NAME,
  project: UNTITLED_PROJECT_NAME,
};
