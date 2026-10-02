// The draft line: what the input says, and where the caret sits. Recall is offered only when
// the caret is at the very start (older) or very end (newer), where the arrow has nothing else
// to do; elsewhere it would eat caret movement.

/** Where the caret sits, which decides whether an arrow recalls. */
export interface DraftCaret {
  readonly selectionStart: number;
  readonly selectionEnd: number;
  readonly textLength: number;
}

/** The placeholder the line shows; the same for every send, since Send has no mode. */
export const DRAFT_PLACEHOLDER = "Message this session";

/** True when the caret is collapsed at the very start of the text. */
export function caretAtStart(caret: DraftCaret): boolean {
  return caret.selectionStart === 0 && caret.selectionEnd === 0;
}

/** True when the caret is collapsed at the very end of the text. */
export function caretAtEnd(caret: DraftCaret): boolean {
  return caret.selectionStart === caret.textLength && caret.selectionEnd === caret.textLength;
}
