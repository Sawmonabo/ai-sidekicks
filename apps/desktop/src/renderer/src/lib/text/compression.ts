// The page's text codec and the one cache of decoded chunks every packed text reads through. The
// codec is the lz4 WebAssembly module the markdown worker compiles and posts; the page never
// compiles, it instantiates the module the first time a full chunk needs packing, which costs the
// module's fixed 128 KiB of memory. Full chunks are packed at idle moments, never while a body is
// admitted, and a chunk whose packed form is no smaller stays plain. Until a module arrives, while
// no worker could compile one, or once the codec fails, every chunk stays plain UTF-8 and reads
// back exactly the same. A codec that failed, to start or inside the module, stays failed; a
// packed chunk the module cannot unpack throws rather than read as other text.

import { recordRejectedRequest } from "../diagnostic-capture/rejected-request-record.js";
import { queueIdleTaskIn } from "../idle-task.js";
import { startSlice } from "../work-slices.js";

/** A text whose full chunks wait to be packed, as its compression asks it at an idle moment. */
export interface PackableText {
  /**
   * Packs at least one waiting chunk, then more while `hasTime` answers true, through this
   * compression's `pack`; answers whether none is left waiting.
   */
  packWhile(hasTime: () => boolean): boolean;
}

/**
 * Where the codec stands: no word yet from a worker, posted absent until a later worker posts a
 * module, handed but not started, running, or failed for good.
 */
export type TextCompressionState = "waiting" | "absent" | "provided" | "running" | "failed";

/**
 * The most UTF-8 bytes one chunk of a packed text holds: the size of the codec's plain buffer,
 * which the compression crate declares as 16 KiB.
 */
export const TEXT_CHUNK_MAX_BYTES: number = 16 * 1024;

/**
 * The page's codec and decoded-chunk cache. `view` is the window whose idle moments pack the texts
 * that wait.
 */
export class TextCompression {
  readonly #view: Window;
  /** The decoded chunks read last, newest first, at most `DECODED_CHUNK_CACHE_SIZE`. */
  readonly #decodedChunks: DecodedChunk[] = [];
  /** The texts with full chunks waiting to be packed, oldest first, held weakly. */
  #waitingTexts: WeakRef<PackableText>[] = [];
  /** How many texts waited after the last sweep of those let go, which spaces the sweeps. */
  #sweptWaitingCount = 0;
  #isPackingQueued = false;
  #state: TextCompressionState = "waiting";
  #module: WebAssembly.Module | undefined;
  #codec: TextCodec | undefined;

  public constructor(view: Window) {
    this.#view = view;
  }

  /** Where the codec stands now. */
  public get state(): TextCompressionState {
    return this.#state;
  }

  /** Whether the codec has no module in hand and has not failed: a worker compiles one for it. */
  public get isModuleWanted(): boolean {
    return this.#state === "waiting" || this.#state === "absent";
  }

  /**
   * Takes the module a markdown worker compiled, or its word that it compiled none, which leaves
   * the chunks plain until a later worker posts one. A module in hand, started or not, is kept
   * whatever a later worker posts, and a codec that failed stays failed.
   */
  public provide(module: WebAssembly.Module | undefined): void {
    if (!this.isModuleWanted) {
      return;
    }
    if (module === undefined) {
      this.#state = "absent";
      return;
    }
    this.#module = module;
    this.#state = "provided";
    this.#queuePacking();
  }

  /**
   * Asks for `text`'s full chunks to be packed at an idle moment; a text is asked for once until
   * it answers that none is left. While no module is in hand the text waits, held weakly, for one;
   * nothing is packed once the codec failed.
   */
  public queuePacking(text: PackableText): void {
    if (this.#state === "failed") {
      return;
    }
    this.#waitingTexts.push(new WeakRef(text));
    if (this.isModuleWanted) {
      this.#sweepLetGoTexts();
      return;
    }
    this.#queuePacking();
  }

  /**
   * `chunk`'s bytes packed, in a buffer of their own, or `undefined` when they would not be smaller
   * or the codec cannot run, so the chunk stays plain. Starts the codec on first need; a codec that
   * fails, an error answer or a trap in the module alike, is recorded and packs nothing more. A
   * cached decode of `chunk` moves to the packed bytes.
   */
  public pack(chunk: Uint8Array): Uint8Array | undefined {
    const codec = this.#runningCodec();
    if (codec === undefined) {
      return undefined;
    }
    let packedLength: number;
    try {
      codec.plainView(chunk.byteLength).set(chunk);
      packedLength = codec.exports.compress(chunk.byteLength) >>> 0;
    } catch (error: unknown) {
      this.#fail(error);
      return undefined;
    }
    if (packedLength === CODEC_FAILED) {
      this.#fail(
        new Error(`The text codec could not pack a chunk of ${String(chunk.byteLength)} bytes`),
      );
      return undefined;
    }
    if (packedLength >= chunk.byteLength) {
      return undefined;
    }
    const packed = codec.packedView(packedLength).slice();
    for (const decoded of this.#decodedChunks) {
      if (decoded.bytes === chunk) {
        decoded.bytes = packed;
      }
    }
    return packed;
  }

  /**
   * The text a chunk holds, through the cache of the chunks read last: `bytes` holds its first
   * `byteLength` UTF-8 bytes plain, or holds them packed when `isPacked`. A chunk is the same
   * text for as long as its bytes and length are. Throws when packed bytes do not unpack to
   * `byteLength`, which no chunk this codec packed does, or when the module traps unpacking them.
   */
  public decodedChunk(bytes: Uint8Array, byteLength: number, isPacked: boolean): string {
    const cached = this.#decodedChunks.findIndex(
      (decoded) => decoded.bytes === bytes && decoded.byteLength === byteLength,
    );
    if (cached !== -1) {
      const [decoded] = this.#decodedChunks.splice(cached, 1);
      if (decoded !== undefined) {
        this.#decodedChunks.unshift(decoded);
        return decoded.text;
      }
    }
    const text = this.decode(bytes, byteLength, isPacked);
    this.#decodedChunks.unshift({ bytes, byteLength, text });
    this.#decodedChunks.length = Math.min(this.#decodedChunks.length, DECODED_CHUNK_CACHE_SIZE);
    return text;
  }

  /** The text a chunk holds, decoded now and kept nowhere, as `decodedChunk` reads it. */
  public decode(bytes: Uint8Array, byteLength: number, isPacked: boolean): string {
    return UTF8_DECODER.decode(this.plainBytesOf(bytes, byteLength, isPacked));
  }

  /**
   * A chunk's plain UTF-8 bytes, as `decode` reads them: its own for a plain chunk, and for a
   * packed one the codec's buffer it unpacks into, which the codec's next call overwrites. Throws
   * as `decodedChunk` does.
   */
  public plainBytesOf(bytes: Uint8Array, byteLength: number, isPacked: boolean): Uint8Array {
    if (!isPacked) {
      return bytes.subarray(0, byteLength);
    }
    const codec = this.#codec;
    if (codec === undefined) {
      throw new Error("A packed chunk was read with no text codec running");
    }
    let plainLength: number;
    try {
      codec.packedView(bytes.byteLength).set(bytes);
      plainLength = codec.exports.decompress(bytes.byteLength) >>> 0;
    } catch (error: unknown) {
      this.#fail(error);
      throw new Error(`A packed chunk of ${String(byteLength)} bytes could not be unpacked`, {
        cause: error,
      });
    }
    if (plainLength !== byteLength) {
      throw new Error(
        `A packed chunk of ${String(byteLength)} bytes unpacked to ${
          plainLength === CODEC_FAILED ? "nothing" : `${String(plainLength)} bytes`
        }`,
      );
    }
    return codec.plainView(plainLength);
  }

  /** Packs the waiting texts at the view's next idle moment, unless a pass is queued already. */
  #queuePacking(): void {
    if (this.#isPackingQueued || this.#waitingTexts.length === 0) {
      return;
    }
    this.#isPackingQueued = true;
    queueIdleTaskIn(this.#view, (deadline) => {
      this.#isPackingQueued = false;
      this.#packWaitingTexts(
        deadline.didTimeout ? startSlice() : () => deadline.timeRemaining() > 0,
      );
    });
  }

  /** Packs waiting texts, oldest first, while the idle moment lasts, and queues what is left. */
  #packWaitingTexts(hasTime: () => boolean): void {
    let packedCount = 0;
    for (const waiting of this.#waitingTexts) {
      const text = waiting.deref();
      if (text !== undefined && !text.packWhile(hasTime)) {
        break;
      }
      packedCount += 1;
      if (!hasTime() || this.#state === "failed") {
        break;
      }
    }
    // A codec that failed let go of every waiting text.
    if (this.#state === "failed") {
      return;
    }
    this.#waitingTexts = this.#waitingTexts.slice(packedCount);
    this.#queuePacking();
  }

  /**
   * Drops the waiting texts that were let go once their count has doubled since the last sweep,
   * so texts admitted while no word has come from the worker hold nothing they did not.
   */
  #sweepLetGoTexts(): void {
    if (this.#waitingTexts.length < 2 * this.#sweptWaitingCount + SWEEP_FLOOR) {
      return;
    }
    this.#waitingTexts = this.#waitingTexts.filter((waiting) => waiting.deref() !== undefined);
    this.#sweptWaitingCount = this.#waitingTexts.length;
  }

  /** The running codec, started from the provided module on first need, or `undefined`. */
  #runningCodec(): TextCodec | undefined {
    if (this.#state === "provided" && this.#module !== undefined) {
      try {
        this.#codec = textCodecOf(new WebAssembly.Instance(this.#module, {}));
        this.#state = "running";
      } catch (error: unknown) {
        this.#fail(error);
      }
      this.#module = undefined;
    }
    return this.#state === "running" ? this.#codec : undefined;
  }

  /**
   * Records why the codec failed, the first time it does, and packs nothing more; packed chunks
   * still read back.
   */
  #fail(error: unknown): void {
    if (this.#state === "failed") {
      return;
    }
    recordRejectedRequest(TEXT_COMPRESSION_SOURCE, "text-codec-failed", error);
    this.#state = "failed";
    this.#module = undefined;
    this.#waitingTexts = [];
  }
}

/** The app's codec, which the markdown worker's connection provides with the module it posts. */
export const appTextCompression: TextCompression = new TextCompression(window);

/** One decoded chunk the cache holds: its bytes and plain length, which say it is the same text. */
interface DecodedChunk {
  bytes: Uint8Array;
  readonly byteLength: number;
  readonly text: string;
}

/** The exports of the compression module, as its crate declares them. */
interface TextCodecExports {
  readonly memory: WebAssembly.Memory;
  plain_ptr(): number;
  packed_ptr(): number;
  /** Returns `u32::MAX` on failure, which a JavaScript caller reads as -1. */
  compress(length: number): number;
  decompress(length: number): number;
}

/** A running module, with views of its two buffers. */
interface TextCodec {
  readonly exports: TextCodecExports;
  plainView(length: number): Uint8Array;
  packedView(length: number): Uint8Array;
}

/** How many decoded chunks the cache keeps, across every text. */
const DECODED_CHUNK_CACHE_SIZE = 4;

/** What `compress` and `decompress` return, read unsigned, when they fail. */
const CODEC_FAILED = 0xff_ff_ff_ff;

/** The fewest waiting texts that start a sweep of those let go. */
const SWEEP_FLOOR = 64;

/** Where a codec failure is recorded from in the window's diagnostics. */
const TEXT_COMPRESSION_SOURCE = "lib/text/compression";

/** Stateless, so one decoder serves every chunk. */
const UTF8_DECODER = new TextDecoder();

/** The functions the compression module exports. */
const CODEC_FUNCTION_NAMES = ["plain_ptr", "packed_ptr", "compress", "decompress"] as const;

/**
 * The codec `instance` runs. Throws when the instance lacks the exports the crate declares, as an
 * instance of some other module would.
 */
function textCodecOf(instance: WebAssembly.Instance): TextCodec {
  const exports = instance.exports;
  const { memory } = exports;
  if (
    !(memory instanceof WebAssembly.Memory) ||
    CODEC_FUNCTION_NAMES.some((name) => typeof exports[name] !== "function")
  ) {
    throw new Error("The text codec's module lacks the exports it declares");
  }
  const codecExports = exports as unknown as TextCodecExports;
  const plainAt = codecExports.plain_ptr();
  const packedAt = codecExports.packed_ptr();
  return {
    exports: codecExports,
    plainView: (length) => new Uint8Array(codecExports.memory.buffer, plainAt, length),
    packedView: (length) => new Uint8Array(codecExports.memory.buffer, packedAt, length),
  };
}
