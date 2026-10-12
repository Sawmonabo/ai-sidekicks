// Command outputs parsed in turn, one of them failing: its error reaches the page, and the outputs
// waiting behind it are still parsed.

import { afterEach, describe, expect, it } from "vitest";

import { publishedTextOf } from "#renderer/features/transcript/reveal/published-text.js";
import { AnsiOutputPreparation } from "#renderer/features/transcript/rows/ansi/preparation.js";
import { PreparedBodies } from "#renderer/features/transcript/rows/prepared-bodies.js";

const UNREADABLE = "the output's text could not be read";

const teardowns: (() => void)[] = [];

afterEach(() => {
  for (const teardown of teardowns.splice(0)) {
    teardown();
  }
});

describe("an output whose parse throws while others wait in turn", () => {
  it("surfaces its error and leaves the outputs behind it parsed", async () => {
    const rejections: unknown[] = [];
    const hearRejection = (event: PromiseRejectionEvent): void => {
      event.preventDefault();
      rejections.push(event.reason);
    };
    window.addEventListener("unhandledrejection", hearRejection);
    teardowns.push(() => {
      window.removeEventListener("unhandledrejection", hearRejection);
    });
    const outputs = new PreparedBodies();
    const waiting = new AnsiOutputPreparation("waiting", outputs, window, () => undefined);
    const failing = new AnsiOutputPreparation("failing", outputs, window, () => undefined);
    teardowns.push(() => {
      waiting.release();
      failing.release();
    });

    // The output read last parses first, so the failing one runs ahead of the waiting one.
    waiting.read(publishedTextOf("ok\n"), "band");
    failing.read(
      {
        ...publishedTextOf("fails\n"),
        slice: () => {
          throw new Error(UNREADABLE);
        },
      },
      "band",
    );

    await expect.poll(() => waiting.isReady).toBe(true);
    expect(outputs.chunksOf("waiting")?.count).toBe(1);
    await expect
      .poll(() => rejections.map((reason) => (reason as Error).message))
      .toEqual([UNREADABLE]);
  });
});
