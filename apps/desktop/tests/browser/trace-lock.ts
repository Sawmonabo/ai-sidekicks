// A trace of the test browser taken one page at a time. Tracing is the browser's own, so a second
// page starting a trace while one runs is refused, and the runner runs test files in pages of their
// own at once, each in a browser context that shares no Web Lock with the others. The lock is held
// in the test server (`vitest/trace-lock.ts`), which every page reaches.

import { commands } from "vitest/browser";

declare module "vitest/browser" {
  interface BrowserCommands {
    holdBrowserTrace: () => Promise<void>;
    releaseBrowserTrace: () => Promise<void>;
  }
}

/** Runs `trace` while no other page of the test browser holds a trace, and answers what it did. */
export async function traceAlone<Result>(trace: () => Promise<Result>): Promise<Result> {
  await commands.holdBrowserTrace();
  try {
    return await trace();
  } finally {
    await commands.releaseBrowserTrace();
  }
}
