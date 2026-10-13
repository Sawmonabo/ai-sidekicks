// A parsed tree's binary buffer, held packed. Once asked, the page's codec packs it at idle moments
// a chunk at a time, keeping plain a chunk whose packed form is no smaller; the whole buffer is
// held until every chunk has been offered, then let go. A read unpacks every chunk into a buffer of
// its own, which nothing here keeps, so a tree read and let go holds only its packed chunks.

import {
  PACKED_CHUNK_MAX_BYTES,
  type PackableChunks,
  type TextCompression,
} from "#renderer/lib/text/compression.js";

/** A tree's buffer, held whole until its chunks are packed, and read back whole. */
export class PackedTreeBuffer implements PackableChunks {
  readonly #compression: TextCompression;
  readonly #byteLength: number;
  /** The buffer as it came, held until every chunk has been offered to the codec. */
  #whole: ArrayBuffer | undefined;
  /** The chunks offered so far, in order, each at most `PACKED_CHUNK_MAX_BYTES` plain. */
  readonly #chunks: TreeChunk[] = [];
  #chunkByteCount = 0;
  #isPackingQueued = false;

  /** `buffer`, held as it is until `queuePacking` asks `compression` to pack it. */
  public constructor(buffer: ArrayBuffer, compression: TextCompression) {
    this.#compression = compression;
    this.#byteLength = buffer.byteLength;
    this.#whole = buffer;
  }

  /** The bytes held now: the whole buffer until it is packed, its chunks once it is. */
  public get heldByteCount(): number {
    return (this.#whole?.byteLength ?? 0) + this.#chunkByteCount;
  }

  /** Asks the codec to pack the buffer at its idle moments; a second ask does nothing. */
  public queuePacking(): void {
    if (this.#isPackingQueued) {
      return;
    }
    this.#isPackingQueued = true;
    this.#compression.queuePacking(this);
  }

  /**
   * Packs the next chunk, then more while `hasTime` answers true, and lets the whole buffer go once
   * every chunk has been offered. A codec that fails drops the chunks packed so far and keeps the
   * buffer whole.
   */
  public packWhile(hasTime: () => boolean): boolean {
    const whole = this.#whole;
    if (whole === undefined) {
      return true;
    }
    do {
      const start = this.#chunks.length * PACKED_CHUNK_MAX_BYTES;
      const plain = new Uint8Array(
        whole,
        start,
        Math.min(PACKED_CHUNK_MAX_BYTES, this.#byteLength - start),
      );
      const packed = this.#compression.pack(plain);
      if (packed === undefined && this.#compression.state === "failed") {
        this.#chunks.length = 0;
        this.#chunkByteCount = 0;
        return true;
      }
      const chunk: TreeChunk =
        packed === undefined
          ? { bytes: plain.slice(), isPacked: false }
          : { bytes: packed, isPacked: true };
      this.#chunks.push(chunk);
      this.#chunkByteCount += chunk.bytes.byteLength;
      if (start + plain.byteLength === this.#byteLength) {
        this.#whole = undefined;
        return true;
      }
    } while (hasTime());
    return false;
  }

  /**
   * The buffer's bytes: the buffer itself while it is held whole, else its chunks unpacked into a
   * new buffer. Throws as `TextCompression.plainBytesOf` does for a chunk the codec cannot unpack.
   */
  public read(): ArrayBuffer {
    if (this.#whole !== undefined) {
      return this.#whole;
    }
    const buffer = new ArrayBuffer(this.#byteLength);
    const bytes = new Uint8Array(buffer);
    let offset = 0;
    for (const chunk of this.#chunks) {
      const plainLength = Math.min(PACKED_CHUNK_MAX_BYTES, this.#byteLength - offset);
      bytes.set(this.#compression.plainBytesOf(chunk.bytes, plainLength, chunk.isPacked), offset);
      offset += plainLength;
    }
    return buffer;
  }
}

/** One chunk of a packed buffer: its bytes, packed or plain. */
interface TreeChunk {
  readonly bytes: Uint8Array;
  readonly isPacked: boolean;
}
