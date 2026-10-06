// What a session is called on screen: its title, or the words an untitled session reads by.

import type { SessionShape } from "@ai-sidekicks/contracts/session/methods";

import type { SessionDirectoryEntry } from "./state.js";

/** The words a session is named by on screen, and whether they stand in for a missing title. */
export interface SessionDisplayTitle {
  readonly text: string;
  readonly isUntitled: boolean;
}

/**
 * What a session is called wherever a surface names it: its title, or for an untitled session
 * `New chat` on a chat and `New session` on a project, which a surface draws faint and italic.
 */
export function sessionDisplayTitleOf(
  entry: Pick<SessionDirectoryEntry, "title" | "shape">,
): SessionDisplayTitle {
  if (entry.title !== undefined) {
    return { text: entry.title, isUntitled: false };
  }
  return { text: UNTITLED_SESSION_WORDS[entry.shape], isUntitled: true };
}

// What an untitled session reads, by its shape.
const UNTITLED_SESSION_WORDS: Readonly<Record<SessionShape, string>> = {
  chat: "New chat",
  project: "New session",
};
