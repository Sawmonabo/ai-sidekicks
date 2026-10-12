// Wakes the app's markdown worker from code the window loads at start. The connection, with the
// worker's script and the page's copy code it imports, arrives on a chunk of its own the first time
// it is asked for, so the window's start does not wait on it.

import { MemoizedLoad } from "#renderer/lib/memoized-load.js";
import type { Unsubscribe } from "#shared/preload-api.js";
import type { MarkdownWorkerConnection } from "./connection.js";

/** Wake the app's markdown worker, loading its connection first if it is not loaded yet. */
export function wakeMarkdownWorker(): void {
  const loaded = markdownWorkerLoad.loadedValue;
  if (loaded !== undefined) {
    loaded.wake();
    return;
  }
  onceMarkdownWorkerLoads((markdownWorker) => {
    markdownWorker.wake();
    return undefined;
  });
}

/**
 * Run `start` with the app's markdown worker connection once it loads, unless the returned stop
 * runs first; the stop also ends what `start` returned.
 */
export function onceMarkdownWorkerLoads(
  start: (markdownWorker: MarkdownWorkerConnection) => Unsubscribe | undefined,
): Unsubscribe {
  let isStopped = false;
  let stop: Unsubscribe | undefined;
  void markdownWorkerLoad.load().then((markdownWorker) => {
    if (!isStopped) {
      stop = start(markdownWorker);
    }
  });
  return () => {
    isStopped = true;
    stop?.();
  };
}

/** The connection, imported the first time it is asked for. */
const markdownWorkerLoad = new MemoizedLoad(
  async () => (await import("./connection.js")).markdownWorker,
);
