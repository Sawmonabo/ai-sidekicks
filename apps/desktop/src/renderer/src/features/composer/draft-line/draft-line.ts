// The draft line: what the input says, and where the caret sits.
//
// EDGE OFFSETS, NOT BARE ARROW KEYS. A person editing the middle of a long message
// presses ArrowUp to move up a line, and a composer that hijacked it would eat their
// caret movement. So recall is offered only when the caret is at the very start
// (older) or the very end (newer) of the text, which is the one position where the
// arrow has nothing else to do.

/** Where the caret sits, which is what decides whether an arrow recalls. */
export interface DraftCaret {
  readonly selectionStart: number;
  readonly selectionEnd: number;
  readonly textLength: number;
}

/**
 * The placeholder the line shows.
 *
 * The same for every send, because Send is one button with no mode: what the message
 * does is the target's, and nothing on the line says which path it will take.
 */
export function composeDraftPlaceholder(): string {
  return "Message this session";
}

/** True when the caret is collapsed at the very start of the text. */
export function caretAtStart(caret: DraftCaret): boolean {
  return caret.selectionStart === 0 && caret.selectionEnd === 0;
}

/** True when the caret is collapsed at the very end of the text. */
export function caretAtEnd(caret: DraftCaret): boolean {
  return caret.selectionStart === caret.textLength && caret.selectionEnd === caret.textLength;
}
