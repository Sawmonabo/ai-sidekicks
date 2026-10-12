// How many UTF-8 bytes a running command's output holds so far, the size its tail's control names.
// Counted as the output grows: each revision measures only the text past what was counted, unless
// a rewrite cut below it, so a long stream costs its growth per frame, not its whole length.

import { useState } from "react";

import { measureUtf8ByteLength } from "#renderer/lib/utf8-byte-length.js";
import { type PublishedText } from "#renderer/features/transcript/reveal/published-text.js";

/** The UTF-8 bytes `liveText` holds now, or `undefined` for an output that is not arriving. */
export function useLiveOutputByteLength(liveText: PublishedText | undefined): number | undefined {
  const [byteCount] = useState(() => new GrowingTextByteCount());
  return liveText === undefined ? undefined : byteCount.measure(liveText);
}

/** The bytes one growing text holds, counted past what an earlier revision already counted. */
class GrowingTextByteCount {
  #text: PublishedText | undefined;
  #revision = 0;
  /** The characters counted: the text's length, less a high surrogate whose pair has not come. */
  #countedLength = 0;
  #byteLength = 0;

  public measure(text: PublishedText): number {
    if (text === this.#text && text.revision === this.#revision) {
      return this.#byteLength;
    }
    if (text !== this.#text || !text.keepsPrefix(this.#revision, this.#countedLength)) {
      this.#countedLength = 0;
      this.#byteLength = 0;
    }
    // A pair split across two revisions is counted once whole, not as two replaced halves.
    const end = isHighSurrogate(text.slice(text.length - 1)) ? text.length - 1 : text.length;
    if (end > this.#countedLength) {
      this.#byteLength += measureUtf8ByteLength(text.slice(this.#countedLength, end));
      this.#countedLength = end;
    }
    this.#text = text;
    this.#revision = text.revision;
    return this.#byteLength;
  }
}

function isHighSurrogate(character: string): boolean {
  const code = character.charCodeAt(0);
  return code >= 0xd800 && code <= 0xdbff;
}
