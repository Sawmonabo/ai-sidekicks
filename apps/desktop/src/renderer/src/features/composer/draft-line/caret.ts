// The draft line: what the input says, where the caret sits, and when the line may take it. Recall
// is offered only when the caret is at the very start (older) or very end (newer), where the arrow
// has nothing else to do; elsewhere it would eat caret movement. The line takes the caret unless
// a field outside its composer is taking typing, so a shell that has the caret keeps it.

import type { SessionShape } from "@ai-sidekicks/contracts/session/methods";

import { isTextEntryTarget } from "#renderer/lib/editable-target.js";

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

/** The class the message line's box carries, by which its composer region finds the line. */
export const DRAFT_LINE_CLASS_NAME = "meridian-composer__line";

/** The message line inside `region`, never another field the region holds. */
export function draftLineIn(region: HTMLElement): HTMLTextAreaElement | null {
  return region.querySelector<HTMLTextAreaElement>(`.${DRAFT_LINE_CLASS_NAME} textarea`);
}

/**
 * Whether the message line inside `region` may take the caret: no text field outside the region
 * has it. A shell or another field that is taking typing keeps it; a button or the page does not.
 */
export function isCaretFreeFor(region: HTMLElement): boolean {
  const focused = region.ownerDocument.activeElement;
  return !isTextEntryTarget(focused) || (focused !== null && region.contains(focused));
}

/** True when the caret is collapsed at the very start of the text. */
export function caretAtStart(caret: DraftCaret): boolean {
  return caret.selectionStart === 0 && caret.selectionEnd === 0;
}

/** True when the caret is collapsed at the very end of the text. */
export function caretAtEnd(caret: DraftCaret): boolean {
  return caret.selectionStart === caret.textLength && caret.selectionEnd === caret.textLength;
}
