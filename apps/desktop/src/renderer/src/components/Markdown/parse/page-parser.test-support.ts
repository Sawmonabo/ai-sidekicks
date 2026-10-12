// Starting a page parser in a suite, which waits for the start a body's first draw waits for.

import type { PageParser } from "./page-parser.js";

/** Starts `parser` from `module`; resolves once it is ready, and rejects if it fails to start. */
export function startPageParser(parser: PageParser, module: WebAssembly.Module): Promise<void> {
  return new Promise((resolve, reject) => {
    const settle = (): boolean => {
      if (parser.state === "ready") {
        resolve();
        return true;
      }
      if (parser.state === "failed") {
        reject(new Error("The page's markdown parser failed to start"));
        return true;
      }
      return false;
    };
    const stop = parser.subscribe(() => {
      if (settle()) {
        stop();
      }
    });
    parser.start(module);
    if (settle()) {
      stop();
    }
  });
}
