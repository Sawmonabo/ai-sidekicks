// One shell's scrollback window: the newest output, its marks taken out, bounded in bytes. Once
// full it drops its oldest whole lines, so it always starts at the first whole line it holds and a
// redraw never begins mid-line. Output nobody watches is held here the same way.

/** The most output one shell's scrollback window holds, in bytes. */
export const SCROLLBACK_WINDOW_BYTES: number = 1024 * 1024;

const LINE_FEED = 0x0a;

// One appended chunk and where its first line break is, so a trim finds the next line start
// without scanning the whole window again.
interface ScrollbackChunk {
  bytes: Uint8Array;
  firstLineFeed: number;
}

function chunkOf(bytes: Uint8Array): ScrollbackChunk {
  return { bytes, firstLineFeed: bytes.indexOf(LINE_FEED) };
}

/** Whether `byte` continues a UTF-8 character rather than starting one. */
export function isContinuationByte(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

/**
 * The scrollback window of one shell, appended in output order. A burst larger than the window
 * keeps its tail from its first whole line; a window holding no line break at all keeps its last
 * bytes from the first character that starts in them.
 */
export class ScrollbackWindow {
  #chunks: ScrollbackChunk[] = [];
  #byteCount = 0;

  /** Appends output, dropping the oldest whole lines past the window's bound. */
  append(output: Uint8Array): void {
    if (output.byteLength === 0) {
      return;
    }
    this.#chunks.push(chunkOf(output));
    this.#byteCount += output.byteLength;
    if (this.#byteCount > SCROLLBACK_WINDOW_BYTES) {
      this.#dropOldest(this.#byteCount - SCROLLBACK_WINDOW_BYTES);
    }
  }

  /** The window's bytes, oldest first. */
  read(): Uint8Array {
    return Buffer.concat(
      this.#chunks.map((chunk) => chunk.bytes),
      this.#byteCount,
    );
  }

  // Drops `excess` bytes from the front, then, unless they ended a line, on through the end of
  // the line they cut into.
  #dropOldest(excess: number): void {
    let wholeChunks = 0;
    let remaining = excess;
    let lastDroppedByte: number | undefined;
    while (remaining > 0) {
      const head = this.#chunks[wholeChunks];
      if (head === undefined) {
        break;
      }
      if (head.bytes.byteLength > remaining) {
        lastDroppedByte = head.bytes[remaining - 1];
        this.#chunks[wholeChunks] = chunkOf(head.bytes.subarray(remaining));
        this.#byteCount -= remaining;
        break;
      }
      lastDroppedByte = head.bytes[head.bytes.byteLength - 1];
      remaining -= head.bytes.byteLength;
      this.#byteCount -= head.bytes.byteLength;
      wholeChunks += 1;
    }
    this.#chunks.splice(0, wholeChunks);
    if (lastDroppedByte !== LINE_FEED) {
      this.#dropThroughCutLine();
    }
  }

  // Starts the window after the first line break it holds, or, with none, at its first whole
  // character.
  #dropThroughCutLine(): void {
    const lineChunk = this.#chunks.findIndex((chunk) => chunk.firstLineFeed !== -1);
    const firstLineChunk = this.#chunks[lineChunk];
    if (firstLineChunk === undefined) {
      this.#trimToCharacterStart();
      return;
    }
    for (const dropped of this.#chunks.splice(0, lineChunk)) {
      this.#byteCount -= dropped.bytes.byteLength;
    }
    this.#chunks[0] = chunkOf(firstLineChunk.bytes.subarray(firstLineChunk.firstLineFeed + 1));
    this.#byteCount -= firstLineChunk.firstLineFeed + 1;
  }

  // With no line break left to cut at, the window starts at its first whole character.
  #trimToCharacterStart(): void {
    const head = this.#chunks[0];
    if (head === undefined) {
      return;
    }
    let start = 0;
    while (start < head.bytes.byteLength && isContinuationByte(head.bytes[start] ?? 0)) {
      start += 1;
    }
    this.#chunks[0] = chunkOf(head.bytes.subarray(start));
    this.#byteCount -= start;
  }
}
