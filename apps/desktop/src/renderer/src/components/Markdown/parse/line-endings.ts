// Where lines end in a markdown text: commonmark ends a line at a line feed, a carriage return, or
// a carriage return and line feed together, which end one line.

/** A line feed's code unit. */
export const LINE_FEED = 0x0a;

/** A carriage return's code unit. */
export const CARRIAGE_RETURN = 0x0d;

/** One line ending, to split a text into its lines. */
export const LINE_ENDING: RegExp = /\r\n|\r|\n/u;

/** Whether `unit` is a line feed or a carriage return, either of which ends a line. */
export function isLineEnding(unit: number): boolean {
  return unit === LINE_FEED || unit === CARRIAGE_RETURN;
}

/**
 * Where the line holding `offset` starts in `text`, looking back no further than `floor`: after
 * the last line ending before it, or `floor`.
 */
export function lineStartOf(text: string, offset: number, floor = 0): number {
  let index = offset;
  while (index > floor) {
    if (isLineEnding(text.charCodeAt(index - 1))) {
      return index;
    }
    index -= 1;
  }
  return floor;
}

/** Where the line holding `from` ends in `text`: its line ending, or the text's end. */
export function lineEndOf(text: string, from: number): number {
  // The engine's own search, several times faster than reading the text a code unit at a time.
  LINE_ENDING_SEARCH.lastIndex = from;
  const lineEnding = LINE_ENDING_SEARCH.exec(text);
  return lineEnding === null ? text.length : lineEnding.index;
}

/**
 * How long the line ending at `index` in `text` is: 2 for a carriage return and line feed, 1 for
 * either alone, 0 where none is.
 */
export function lineEndingLengthAt(text: string, index: number): number {
  const unit = text.charCodeAt(index);
  if (unit === CARRIAGE_RETURN) {
    return text.charCodeAt(index + 1) === LINE_FEED ? 2 : 1;
  }
  return unit === LINE_FEED ? 1 : 0;
}

/** The first line ending from where its `lastIndex` is set; set before each search. */
const LINE_ENDING_SEARCH = /[\r\n]/gu;
