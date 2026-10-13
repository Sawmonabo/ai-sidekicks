// A text held as UTF-8 bytes rather than as a string. The bytes sit in chunks of at most
// `PACKED_CHUNK_MAX_BYTES`, each cut at a code-point boundary so it decodes alone, beside the
// UTF-16 offset each chunk starts at, so a read finds its chunks by binary search and decodes only
// those, through the one cache of decoded chunks every packed text shares. Closed chunks are packed
// by the page's codec at idle moments; a growing text's last chunk stays open, and a sealed text's
// packs too. A text held whole at once encodes a short last chunk straight into bytes of its own
// size, so a short body takes no full chunk to trim. UTF-8 holds no half of a surrogate pair, so a
// high surrogate an append ends on waits as a code unit of its own until the next append brings its
// other half; a lone surrogate anywhere else is held as U+FFFD, as every UTF-8 encoder writes it.

import {
  appTextCompression,
  PACKED_CHUNK_MAX_BYTES,
  type PackableChunks,
  type TextCompression,
} from "./compression.js";
import { isHighSurrogate, isLowSurrogate } from "./pieces.js";
import { ESCAPE, type StoredText } from "./published.js";

/**
 * One text as packed UTF-8 chunks. It grows by `append` and is cut back by `truncate` until it is
 * sealed, after which it never changes; a body read from the log is sealed as it is admitted, so
 * the string it came as can be let go.
 */
export class PackedText implements StoredText, PackableChunks {
  readonly #compression: TextCompression;
  /** The chunks, oldest first: every one but an open last one is closed. */
  readonly #chunks: HeldChunk[] = [];
  /** The UTF-16 offset each chunk starts at, by its index; grown by doubling. */
  #chunkStarts = new Uint32Array(INITIAL_CHUNK_CAPACITY);
  /** The UTF-16 length the chunks hold; a waiting high surrogate follows it. */
  #chunkedLength = 0;
  /** A high surrogate the text ends on, held as a string until its other half arrives. */
  #waitingHighSurrogate = "";
  /** The UTF-8 bytes the chunks hold, unpacked. */
  #chunkedByteLength = 0;
  /** Where the first `ESCAPE` is, or -1. */
  #escapeIndex = -1;
  #revision = 0;
  /** The revision of the last cut; a reader older than it is told its prefix may have changed. */
  #truncationRevision = 0;
  #isSealed = false;
  /** How many leading chunks were offered to the codec; the closed ones after them wait. */
  #offeredChunkCount = 0;
  #isWaitingToPack = false;

  /** An empty text, packed through `compression`. */
  public constructor(compression: TextCompression = appTextCompression) {
    this.#compression = compression;
  }

  /** `text` held packed and sealed; the string can be let go once this returns. */
  public static of(text: string, compression: TextCompression = appTextCompression): PackedText {
    const packed = new PackedText(compression);
    packed.#add(text, true);
    packed.seal();
    return packed;
  }

  public get length(): number {
    return this.#chunkedLength + this.#waitingHighSurrogate.length;
  }

  public get revision(): number {
    return this.#revision;
  }

  /**
   * How many bytes the text takes as UTF-8, a waiting high surrogate as the U+FFFD it encodes as.
   */
  public get byteLength(): number {
    return this.#chunkedByteLength + (this.#waitingHighSurrogate === "" ? 0 : REPLACEMENT_BYTES);
  }

  public get holdsEscape(): boolean {
    return this.#escapeIndex !== -1;
  }

  /** Where the first `ESCAPE` is, or -1 where the text holds none. */
  public get firstEscapeIndex(): number {
    return this.#escapeIndex;
  }

  /** Adds `text` at the end. Throws once the text is sealed. */
  public append(text: string): void {
    this.#refuseWhenSealed();
    this.#add(text, false);
  }

  /**
   * Cuts the text back to its first `length` characters; a cut between the halves of a surrogate
   * pair keeps the first half waiting. Throws once the text is sealed.
   */
  public truncate(length: number): void {
    this.#refuseWhenSealed();
    const keptLength = Math.max(0, length);
    if (keptLength >= this.length) {
      return;
    }
    this.#revision += 1;
    this.#truncationRevision = this.#revision;
    if (this.#escapeIndex >= keptLength) {
      this.#escapeIndex = -1;
    }
    this.#waitingHighSurrogate = "";
    if (keptLength === this.#chunkedLength) {
      return;
    }
    const index = this.#chunkIndexAt(keptLength);
    const chunkStart = this.#chunkStarts[index] ?? 0;
    const keptText = this.#decodedChunkAt(index).slice(0, keptLength - chunkStart);
    for (const dropped of this.#chunks.splice(index)) {
      this.#chunkedByteLength -= dropped.byteLength;
    }
    this.#chunkedLength = chunkStart;
    this.#offeredChunkCount = Math.min(this.#offeredChunkCount, index);
    this.#hold(keptText, false);
  }

  /** Ends the text: its last chunk is trimmed and packs too, and it takes no more changes. */
  public seal(): void {
    if (this.#isSealed) {
      return;
    }
    this.#isSealed = true;
    this.#closeLastChunk();
    this.#queuePacking();
  }

  public slice(start: number, end: number = this.length): string {
    const length = this.length;
    const from = Math.min(length, Math.max(0, start));
    const to = Math.min(length, Math.max(0, end));
    if (to <= from) {
      return "";
    }
    const chunkedEnd = Math.min(to, this.#chunkedLength);
    let text = "";
    if (from < chunkedEnd) {
      for (
        let index = this.#chunkIndexAt(from);
        index < this.#chunks.length && (this.#chunkStarts[index] ?? 0) < chunkedEnd;
        index += 1
      ) {
        const chunkStart = this.#chunkStarts[index] ?? 0;
        text += this.#decodedChunkAt(index).slice(
          Math.max(0, from - chunkStart),
          chunkedEnd - chunkStart,
        );
      }
    }
    return to > this.#chunkedLength ? text + this.#waitingHighSurrogate : text;
  }

  public indexOf(character: string, from: number): number {
    const start = Math.max(0, from);
    if (start < this.#chunkedLength) {
      for (let index = this.#chunkIndexAt(start); index < this.#chunks.length; index += 1) {
        const chunkStart = this.#chunkStarts[index] ?? 0;
        const found = this.#decodedChunkAt(index).indexOf(
          character,
          Math.max(0, start - chunkStart),
        );
        if (found !== -1) {
          return chunkStart + found;
        }
      }
    }
    return this.#waitingHighSurrogate === character && start <= this.#chunkedLength
      ? this.#chunkedLength
      : -1;
  }

  /** Each chunk decoded as it is reached and kept nowhere, so a whole read evicts no cached one. */
  public *chunks(): Generator<string> {
    for (const chunk of this.#chunks) {
      yield this.#compression.decode(chunk.bytes, chunk.byteLength, chunk.state === "packed");
    }
    if (this.#waitingHighSurrogate !== "") {
      yield this.#waitingHighSurrogate;
    }
  }

  public keepsPrefix(revision: number, length: number): boolean {
    return length <= this.length && revision >= this.#truncationRevision;
  }

  /**
   * Whether `text` starts with this text as it is held, a lone surrogate in `text` matching the
   * U+FFFD it is held as. Compared as UTF-8 a chunk at a time against the bytes held, so no chunk
   * is decoded and only a packed one is unpacked.
   */
  public isPrefixOf(text: string): boolean {
    if (text.length < this.length) {
      return false;
    }
    const encoded = new Uint8Array(PACKED_CHUNK_MAX_BYTES);
    for (const [index, chunk] of this.#chunks.entries()) {
      const start = this.#chunkStarts[index] ?? 0;
      const end =
        index === this.#chunks.length - 1
          ? this.#chunkedLength
          : (this.#chunkStarts[index + 1] ?? 0);
      // A chunk ends on a whole character, so a pair `text` holds across the end differs from it.
      if (isHighSurrogate(text.charCodeAt(end - 1)) && isLowSurrogate(text.charCodeAt(end))) {
        return false;
      }
      const { read, written } = UTF8_ENCODER.encodeInto(text.slice(start, end), encoded);
      if (read !== end - start || written !== chunk.byteLength) {
        return false;
      }
      const held = this.#compression.plainBytesOf(
        chunk.bytes,
        chunk.byteLength,
        chunk.state === "packed",
      );
      for (let offset = 0; offset < written; offset += 1) {
        if (held[offset] !== encoded[offset]) {
          return false;
        }
      }
    }
    return (
      this.#waitingHighSurrogate === "" ||
      text.charCodeAt(this.#chunkedLength) === this.#waitingHighSurrogate.charCodeAt(0)
    );
  }

  public packWhile(hasTime: () => boolean): boolean {
    const closedChunkCount = this.#closedChunkCount();
    while (this.#offeredChunkCount < closedChunkCount) {
      const index = this.#offeredChunkCount;
      const chunk = this.#chunks[index];
      const packed = chunk === undefined ? undefined : this.#compression.pack(chunk.bytes);
      if (chunk !== undefined && packed !== undefined) {
        this.#chunks[index] = { bytes: packed, byteLength: chunk.byteLength, state: "packed" };
      }
      this.#offeredChunkCount += 1;
      if (!hasTime()) {
        break;
      }
    }
    const isDone = this.#offeredChunkCount >= closedChunkCount;
    if (isDone) {
      this.#isWaitingToPack = false;
    }
    return isDone;
  }

  /** Adds `text` at the end, `isWhole` when nothing more will be added. */
  #add(text: string, isWhole: boolean): void {
    if (text === "") {
      return;
    }
    if (this.#escapeIndex === -1) {
      const escapeAt = text.indexOf(ESCAPE);
      this.#escapeIndex = escapeAt === -1 ? -1 : this.length + escapeAt;
    }
    this.#hold(this.#waitingHighSurrogate + text, isWhole);
    this.#revision += 1;
  }

  /**
   * Encodes `text` at the end, holding back a high surrogate it ends on, and offers closed chunks.
   * The rest of a whole text that surely fits one chunk is encoded into bytes of its exact size.
   */
  #hold(text: string, isWhole: boolean): void {
    let source = text;
    this.#waitingHighSurrogate = "";
    if (source !== "" && isHighSurrogate(source.charCodeAt(source.length - 1))) {
      this.#waitingHighSurrogate = source.slice(-1);
      source = source.slice(0, -1);
    }
    let start = 0;
    while (start < source.length) {
      const restLength = source.length - start;
      if (
        isWhole &&
        this.#chunks.at(-1)?.state !== "open" &&
        restLength * MAX_UTF8_BYTES_PER_CODE_UNIT <= PACKED_CHUNK_MAX_BYTES
      ) {
        const bytes = UTF8_ENCODER.encode(source.slice(start));
        this.#addChunk({ bytes, byteLength: bytes.length, state: "plain" });
        this.#chunkedByteLength += bytes.length;
        this.#chunkedLength += restLength;
        break;
      }
      const open = this.#openChunk();
      // A chunk's room in bytes bounds the code units that fit, as each takes at least a byte. A
      // pair cut at the slice's end never splits: the lone half would take 3 bytes as U+FFFD,
      // more room than the units before it leave, so it is read with its other half next.
      const end = Math.min(source.length, start + PACKED_CHUNK_MAX_BYTES - open.byteLength);
      const { read, written } = UTF8_ENCODER.encodeInto(
        source.slice(start, end),
        open.bytes.subarray(open.byteLength),
      );
      if (read === 0) {
        // The next character does not fit: the chunk is full.
        this.#closeLastChunk();
        continue;
      }
      this.#chunks[this.#chunks.length - 1] = {
        bytes: open.bytes,
        byteLength: open.byteLength + written,
        state: "open",
      };
      this.#chunkedByteLength += written;
      this.#chunkedLength += read;
      start += read;
    }
    if (this.#closedChunkCount() > this.#offeredChunkCount) {
      this.#queuePacking();
    }
  }

  /** The last chunk while it is open, else a new open chunk of the full size, added at the end. */
  #openChunk(): HeldChunk {
    const last = this.#chunks.at(-1);
    if (last?.state === "open") {
      return last;
    }
    return this.#addChunk({
      bytes: new Uint8Array(PACKED_CHUNK_MAX_BYTES),
      byteLength: 0,
      state: "open",
    });
  }

  /** Adds `chunk` at the end, starting where the chunked text ends. */
  #addChunk(chunk: HeldChunk): HeldChunk {
    const count = this.#chunks.length;
    if (count === this.#chunkStarts.length) {
      const grown = new Uint32Array(count * 2);
      grown.set(this.#chunkStarts);
      this.#chunkStarts = grown;
    }
    this.#chunkStarts[count] = this.#chunkedLength;
    this.#chunks.push(chunk);
    return chunk;
  }

  /** Closes an open last chunk into bytes of its own exact length. */
  #closeLastChunk(): void {
    const last = this.#chunks.at(-1);
    if (last?.state === "open") {
      this.#chunks[this.#chunks.length - 1] = {
        bytes: last.bytes.slice(0, last.byteLength),
        byteLength: last.byteLength,
        state: "plain",
      };
    }
  }

  /** How many leading chunks are closed: every one but an open last one. */
  #closedChunkCount(): number {
    return this.#chunks.at(-1)?.state === "open" ? this.#chunks.length - 1 : this.#chunks.length;
  }

  #queuePacking(): void {
    if (!this.#isWaitingToPack && this.#closedChunkCount() > this.#offeredChunkCount) {
      this.#isWaitingToPack = true;
      this.#compression.queuePacking(this);
    }
  }

  /** The index of the chunk holding `offset`, which is inside the chunked text. */
  #chunkIndexAt(offset: number): number {
    let low = 0;
    let high = this.#chunks.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >>> 1;
      if ((this.#chunkStarts[middle] ?? 0) <= offset) {
        low = middle;
      } else {
        high = middle - 1;
      }
    }
    return low;
  }

  #decodedChunkAt(index: number): string {
    const chunk = this.#chunks[index];
    return chunk === undefined
      ? ""
      : this.#compression.decodedChunk(chunk.bytes, chunk.byteLength, chunk.state === "packed");
  }

  #refuseWhenSealed(): void {
    if (this.#isSealed) {
      throw new Error("A sealed text never changes");
    }
  }
}

/**
 * One chunk's bytes: open, a buffer of the full chunk size the text still writes into; plain,
 * exactly its bytes; or packed, smaller than them. `byteLength` is its plain UTF-8 length.
 */
interface HeldChunk {
  readonly bytes: Uint8Array;
  readonly byteLength: number;
  readonly state: "open" | "plain" | "packed";
}

/** How many chunk starts a text makes room for at first: 64 KiB of text, then doubled. */
const INITIAL_CHUNK_CAPACITY = 4;

/** The UTF-8 bytes of U+FFFD, which a lone surrogate encodes as. */
const REPLACEMENT_BYTES = 3;

/** The most UTF-8 bytes one UTF-16 code unit takes: 3, where a pair's two take 4. */
const MAX_UTF8_BYTES_PER_CODE_UNIT = 3;

/** Stateless, so one encoder serves every text. */
const UTF8_ENCODER = new TextEncoder();
