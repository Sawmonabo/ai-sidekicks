// The lock the browser tier's traces take turns on, held in the test server. Chromium runs one trace
// at a time across the whole browser, and Vitest opens each of its pages in a browser context of
// its own, which shares no Web Lock with the others, so only the server sees every page.

import type { BrowserCommand } from "vitest/node";

/** The two commands a page takes the browser's trace with and gives it back. */
export interface BrowserTraceLockCommands {
  /** Resolves once the calling page holds the trace; a page holding it already is refused. */
  readonly holdBrowserTrace: BrowserCommand<[]>;
  /** Gives the calling page's hold back; a page holding none is refused. */
  readonly releaseBrowserTrace: BrowserCommand<[]>;
}

/** A fresh lock's commands, for one tier's `browser.commands`: every page of the tier shares it. */
export function browserTraceLockCommands(): BrowserTraceLockCommands {
  const lock = new BrowserTraceLock();
  return {
    holdBrowserTrace: async (context) => {
      await lock.hold(context.sessionId);
    },
    releaseBrowserTrace: (context) => {
      lock.release(context.sessionId);
    },
  };
}

// The pages' holds in the order they asked: each waits on the hold asked before it.
class BrowserTraceLock {
  #lastHold: Promise<void> = Promise.resolve();
  readonly #releaseByPage = new Map<string, () => void>();

  public async hold(pageId: string): Promise<void> {
    if (this.#releaseByPage.has(pageId)) {
      throw new Error("this page already holds the browser's trace");
    }
    let release = (): void => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const turn = this.#lastHold;
    this.#lastHold = turn.then(() => released);
    this.#releaseByPage.set(pageId, release);
    await turn;
  }

  public release(pageId: string): void {
    const release = this.#releaseByPage.get(pageId);
    if (release === undefined) {
      throw new Error("this page holds no browser trace to give back");
    }
    this.#releaseByPage.delete(pageId);
    release();
  }
}
