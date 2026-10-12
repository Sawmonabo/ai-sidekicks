// A window a copy's build can run its slices in under a test, where the page schedules no tasks,
// and a built copy's content as main joins it from its pieces.

import { expect, vi } from "vitest";

import type { TextClipboardContent } from "#shared/preload-api.js";
import { joinPieces, TEXT_PIECE_LENGTH, type PiecedText } from "#renderer/lib/text/pieces.js";
import type { PiecedTextClipboardContent } from "#renderer/services/platform/clipboard/late-copy.js";
import { TASKS_AT_ONCE } from "#test/helpers/tasks-at-once.js";

/** A window running its tasks at once, its clock past each slice's end: a slice holds one part. */
export function windowCuttingEveryPart(): Window {
  let nowMs = 0;
  vi.spyOn(performance, "now").mockImplementation(() => (nowMs += 10));
  return TASKS_AT_ONCE;
}

/**
 * `content` as main joins it from the pieces it is sent, checking that no piece is longer than
 * `TEXT_PIECE_LENGTH` and that each flavor's pieces join to the text it holds whole.
 */
export function piecesJoinedOf(
  content: PiecedTextClipboardContent | undefined,
): TextClipboardContent | undefined {
  if (content === undefined) {
    return undefined;
  }
  const { text, html } = content;
  return html === undefined
    ? { text: joinedOf(text) }
    : { text: joinedOf(text), html: joinedOf(html) };
}

function joinedOf({ text, pieces }: PiecedText): string {
  expect(pieces.filter((piece) => piece.length > TEXT_PIECE_LENGTH)).toStrictEqual([]);
  expect(joinPieces(pieces)).toBe(text);
  return text;
}
