// A PNG written a strip of rows at a time, so a picture of any size is encoded while only one
// strip of its pixels is held. The rows are compressed by the platform's own deflate, whose zlib
// stream is what a PNG's data chunks carry, each piece of it written as a data chunk as it comes.

/**
 * A PNG of 8-bit RGBA pixels, `width` by `height`, written from its rows top to bottom. Rejects
 * from `writeRows` or `finish` when the platform's compression fails, and from `finish` when the
 * rows written do not fill the picture.
 */
export class PngStream {
  readonly #height: number;
  readonly #writer: WritableStreamDefaultWriter<Uint8Array<ArrayBuffer>>;
  /** The file's chunks so far, the signature and header first. */
  readonly #chunks: Uint8Array<ArrayBuffer>[];
  /** Settles once every compressed piece has been written as a data chunk. */
  readonly #drained: Promise<void>;
  #rowsWritten = 0;

  public constructor(width: number, height: number) {
    this.#height = height;
    const header = new Uint8Array(13);
    const view = new DataView(header.buffer);
    view.setUint32(0, width);
    view.setUint32(4, height);
    // 8 bits a sample, color with alpha; deflate, adaptive filtering, no interlace.
    header.set([8, 6, 0, 0, 0], 8);
    this.#chunks = [new Uint8Array(PNG_SIGNATURE), chunkOf("IHDR", header)];
    const compression = new CompressionStream("deflate");
    this.#writer = compression.writable.getWriter();
    // Read from the start: the compression holds back each write until its output is read.
    this.#drained = this.#writeDataChunks(compression.readable);
  }

  /**
   * Writes the next `rows` rows from `scanlines`, each row its filter-type byte and then its RGBA
   * bytes; resolves once the compression has taken them, so the caller holds one strip at a time.
   */
  public async writeRows(scanlines: Uint8Array<ArrayBuffer>, rows: number): Promise<void> {
    this.#rowsWritten += rows;
    await this.#writer.write(scanlines);
  }

  /** The whole file, once the rows written fill the picture. */
  public async finish(): Promise<Uint8Array<ArrayBuffer>> {
    if (this.#rowsWritten !== this.#height) {
      await this.#writer.abort();
      throw new Error(
        `A picture of ${String(this.#height)} rows was given ${String(this.#rowsWritten)}.`,
      );
    }
    await this.#writer.close();
    await this.#drained;
    this.#chunks.push(chunkOf("IEND", new Uint8Array()));
    const file = new Uint8Array(this.#chunks.reduce((length, chunk) => length + chunk.length, 0));
    let offset = 0;
    for (const chunk of this.#chunks) {
      file.set(chunk, offset);
      offset += chunk.length;
    }
    return file;
  }

  async #writeDataChunks(compressed: ReadableStream<Uint8Array<ArrayBuffer>>): Promise<void> {
    for await (const piece of compressed) {
      this.#chunks.push(chunkOf("IDAT", piece));
    }
  }
}

/** The eight bytes every PNG file opens with. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** A chunk of `type` holding `data`: its length, type, data and the CRC of type and data. */
function chunkOf(type: string, data: Uint8Array): Uint8Array<ArrayBuffer> {
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  for (let index = 0; index < 4; index += 1) {
    chunk[4 + index] = type.charCodeAt(index);
  }
  chunk.set(data, 8);
  view.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));
  return chunk;
}

/** The CRC-32 a PNG chunk carries, by the PNG specification's table-driven method. */
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** The CRC of each byte value, the polynomial 0xedb88320 the PNG specification names. */
const CRC_TABLE: readonly number[] = Array.from({ length: 256 }, (_unused, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return crc >>> 0;
});
