// Which line the tokenizing thread is on, in memory both threads share. The worker marks each line
// as it starts and ends it, with no message per line, and the main thread reads the marks only
// when a slice has run past its time limit, to tell a stuck line from a slow file.

const OFFSET_SLOT = 0;
const STARTED_AT_SLOT = 1;
const SLOT_COUNT = 2;

/** The offset slot's value between lines. */
const NO_LINE = -1n;

/** The line a tokenizing thread is on: its offset in the source and when it started, in ms. */
export interface LineInProgress {
  readonly offset: number;
  readonly startedAt: number;
}

/**
 * A clock both threads read alike, in milliseconds: each thread's `performance` counts from its own
 * start, so the time origin is added back.
 */
export function readSharedClock(): number {
  return performance.timeOrigin + performance.now();
}

/** The line marks one tokenizing thread writes and the main thread reads. */
export class LineProgress {
  /** The shared memory, handed to the worker so both sides read the same marks. */
  readonly buffer: SharedArrayBuffer;
  readonly #slots: BigInt64Array;

  /** Opens marks over `buffer`, or over fresh shared memory with no line started. */
  constructor(buffer?: SharedArrayBuffer) {
    this.buffer = buffer ?? new SharedArrayBuffer(SLOT_COUNT * BigInt64Array.BYTES_PER_ELEMENT);
    this.#slots = new BigInt64Array(this.buffer);
    if (buffer === undefined) {
      Atomics.store(this.#slots, OFFSET_SLOT, NO_LINE);
    }
  }

  /** Marks the line at `offset` as started now. */
  markLineStarted(offset: number): void {
    Atomics.store(this.#slots, STARTED_AT_SLOT, BigInt(Math.round(readSharedClock())));
    Atomics.store(this.#slots, OFFSET_SLOT, BigInt(offset));
  }

  /** Marks the line in progress as done. */
  markLineEnded(): void {
    Atomics.store(this.#slots, OFFSET_SLOT, NO_LINE);
  }

  /** The line the thread is on, or `undefined` between lines. */
  readLineInProgress(): LineInProgress | undefined {
    const offset = Atomics.load(this.#slots, OFFSET_SLOT);
    if (offset === NO_LINE) {
      return undefined;
    }
    return {
      offset: Number(offset),
      startedAt: Number(Atomics.load(this.#slots, STARTED_AT_SLOT)),
    };
  }
}
