// A byte order mark (U+FEFF) in a markdown text. The parser drops one that opens the text it is
// given and counts its offsets after it, and reads one anywhere else as text. A body's own leading
// mark is not part of its markdown, so a whole parse of the body drops it; a block, a window or a
// tail cut from past the body's start keeps one it opens on, as the whole parse does there. So the
// app never lets the parser drop one: every text it parses is a slice past its body's leading mark.

/**
 * How long the byte order mark `text` opens on is: 1, or 0 for none. A whole document's caller
 * parses `text` past it, as the document's own markdown starts there.
 */
export function byteOrderMarkLengthOf(text: string): number {
  return text.charCodeAt(0) === BYTE_ORDER_MARK ? 1 : 0;
}

/**
 * What the parser is given ahead of `text`, so it reads a byte order mark `text` opens on as text:
 * a line feed, a blank line no block reads, or nothing. Every offset of the parse counts it, and a
 * reader of the parse moves each back by its length.
 */
export function parseLeadOf(text: string): string {
  return byteOrderMarkLengthOf(text) === 0 ? "" : "\n";
}

const BYTE_ORDER_MARK = 0xfeff;
