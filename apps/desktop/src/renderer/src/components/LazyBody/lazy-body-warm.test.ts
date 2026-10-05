// The idle walk over a board whose chunks fail: it asks for each key once and ends.

import { describe, expect, it } from "vitest";

import { ManualIdleWarmScheduler } from "#test/helpers/idle-warm.js";
import { LazyBodyIdleWarm } from "./lazy-body-warm.js";
import { type PreloadableRegistry } from "./lazy-body.js";

/** A board whose unloaded set the case controls, recording what was asked for. */
class RecordingBoard implements PreloadableRegistry<string> {
  #unloaded: string[];
  public readonly preloaded: string[] = [];
  readonly #rejectingKeys: ReadonlySet<string>;

  public readonly unloadedKeys = (): readonly string[] => this.#unloaded;

  public readonly preload = async (key: string): Promise<void> => {
    this.preloaded.push(key);
    // A real board drops the key synchronously on preload, so the fake does too.
    this.#unloaded = this.#unloaded.filter((unloadedKey) => unloadedKey !== key);
    if (this.#rejectingKeys.has(key)) {
      // A real board releases the memo when the load rejects; the fake re-adds the key.
      this.#unloaded.push(key);
      throw new Error(`chunk for ${key} could not be fetched`);
    }
  };

  public constructor(unloaded: readonly string[], rejectingKeys: readonly string[] = []) {
    this.#unloaded = [...unloaded];
    this.#rejectingKeys = new Set(rejectingKeys);
  }
}

describe("the warm walk — a chunk that will not load", () => {
  it("asks for each key once and ends, when every chunk fails", async () => {
    // A released memo makes a failed key look never-asked; the attempted set stops two failing
    // keys from being refetched forever.
    const board = new RecordingBoard(["diff", "inspector"], ["diff", "inspector"]);
    const scheduler = new ManualIdleWarmScheduler();
    new LazyBodyIdleWarm(board, scheduler).start();
    scheduler.runToQuiescence();
    expect(board.preloaded).toStrictEqual(["diff", "inspector"]);
    expect(scheduler.pendingCount).toBe(0);
    await Promise.resolve();
  });
});
