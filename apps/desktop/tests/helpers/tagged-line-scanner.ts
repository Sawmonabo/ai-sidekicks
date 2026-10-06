// Reads tagged lines off a child's output stream. A chunk boundary can fall inside a line, so the
// unfinished tail is carried into the next chunk; use one scanner per stream, since sharing one
// would splice the tail of stdout onto the head of stderr.

import { describeFailure } from "#shared/failure-message.js";

/** Returns the text after `tag` on every line a chunk completes. */
export class TaggedLineScanner {
  readonly #tag: string;
  #pending = "";

  constructor(tag: string) {
    this.#tag = tag;
  }

  /** Feeds one chunk; returns the tagged payloads it completed, in order. */
  push(chunk: string): string[] {
    this.#pending += chunk;
    const lines = this.#pending.split("\n");
    this.#pending = lines.pop() ?? "";
    const payloads: string[] = [];
    for (const line of lines) {
      const marker = line.indexOf(this.#tag);
      if (marker >= 0) {
        payloads.push(line.slice(marker + this.#tag.length).trim());
      }
    }
    return payloads;
  }
}

/**
 * Collects the JSON reading a probe prints after its tag. The last line that parses is the
 * reading; a tagged line that is not valid JSON is kept, so a failure can show it instead of
 * reporting that no line arrived.
 */
export class TaggedJsonReadingScanner<Reading> {
  readonly #lines: TaggedLineScanner;
  #reading: Reading | null = null;
  readonly #malformedLines: string[] = [];

  constructor(tag: string) {
    this.#lines = new TaggedLineScanner(tag);
  }

  /** Feeds one chunk of the stream the probe prints on. */
  push(chunk: string): void {
    for (const payload of this.#lines.push(chunk)) {
      if (!payload.startsWith("{")) {
        continue;
      }
      try {
        this.#reading = JSON.parse(payload) as Reading;
      } catch (parseFailure: unknown) {
        this.#malformedLines.push(`${payload} (${describeFailure(parseFailure)})`);
      }
    }
  }

  /** The last reading that parsed, or `null`. */
  get reading(): Reading | null {
    return this.#reading;
  }

  /** Every tagged line that did not parse, each with the parser's reason. */
  get malformedLines(): readonly string[] {
    return this.#malformedLines;
  }
}
