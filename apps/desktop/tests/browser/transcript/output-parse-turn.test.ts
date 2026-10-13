// Command outputs parsed in turn, one of them failing: its error reaches the window's own error
// report, its row is told its parse is over, and the outputs waiting behind it are still parsed.

import { afterEach, describe, expect, it, vi } from "vitest";

import { publishedTextOf } from "#renderer/lib/text/published.js";
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
  it("reports its error, tells its row, and leaves the outputs behind it parsed", async () => {
    // The window's error report is where the app's diagnostics hear an error nothing caught; the
    // case takes the report's place, so the error the case asked for reaches no runner listener.
    const reportError = vi.spyOn(window, "reportError").mockImplementation(() => undefined);
    teardowns.push(() => {
      reportError.mockRestore();
    });
    const outputs = new PreparedBodies();
    const waiting = new AnsiOutputPreparation("waiting", outputs, window, () => undefined);
    const onFailingReady = vi.fn<() => void>();
    const failing = new AnsiOutputPreparation("failing", outputs, window, onFailingReady);
    teardowns.push(() => {
      waiting.release();
      failing.release();
    });

    // The output read last parses first, so the failing one runs ahead of the waiting one.
    waiting.read(publishedTextOf("ok\n"), "band");
    const unreadable = {
      ...publishedTextOf("fails\n"),
      slice: () => {
        throw new Error(UNREADABLE);
      },
    };
    failing.read(unreadable, "band");

    await expect.poll(() => waiting.isReady).toBe(true);
    expect(outputs.chunksOf("waiting")?.count).toBe(1);
    expect(reportError.mock.calls.map(([error]) => (error as Error).message)).toEqual([UNREADABLE]);
    expect(failing.isReady).toBe(true);
    expect(onFailingReady).toHaveBeenCalledTimes(1);
    expect(outputs.isInTurn(failing)).toBe(false);

    // The same text is not parsed, and thrown on, again.
    failing.read(unreadable, "band");
    expect(outputs.isInTurn(failing)).toBe(false);
  });
});
