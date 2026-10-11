// The draft line: what the input says, and where the caret sits. Recall is offered only when
// the caret is at the very start (older) or very end (newer), where the arrow has nothing else
// to do; elsewhere it would eat caret movement.

import type { SessionShape } from "@ai-sidekicks/contracts/session/methods";

/** Where the caret sits, which decides whether an arrow recalls. */
export interface DraftCaret {
  readonly selectionStart: number;
  readonly selectionEnd: number;
  readonly textLength: number;
}

/**
 * What the empty line says, by the session's shape; the same for every send, since Send has no
 * mode.
 */
export const DRAFT_PLACEHOLDERS: Readonly<Record<SessionShape, string>> = {
  chat: "Ask, think out loud, or paste something… Shift+Enter for a new line",
  project: "Message the sidekick… Shift+Enter for a new line, @ to mention a file",
};

/** True when the caret is collapsed at the very start of the text. */
export function caretAtStart(caret: DraftCaret): boolean {
  return caret.selectionStart === 0 && caret.selectionEnd === 0;
}

/** True when the caret is collapsed at the very end of the text. */
export function caretAtEnd(caret: DraftCaret): boolean {
  return caret.selectionStart === caret.textLength && caret.selectionEnd === caret.textLength;
}
