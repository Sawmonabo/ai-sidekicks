// The provider crash window: the waits before each automatic restart, the crash loop at the fifth
// crash inside three minutes, and a crash that has left the window or was cleared no longer
// counting.

import { describe, expect, it } from "vitest";

import { CrashWindow } from "../crash-window.js";

const THREE_MINUTES_MS = 180_000;

describe("CrashWindow", () => {
  it("restarts after 0, 1, 2 and 4 seconds and ends the restarts at the fifth crash", () => {
    const crashWindow = new CrashWindow();

    const answers = [0, 10_000, 20_000, 30_000, 40_000].map((at) => crashWindow.recordCrash(at));

    expect(answers).toEqual([
      { restartAfterMs: 0 },
      { restartAfterMs: 1_000 },
      { restartAfterMs: 2_000 },
      { restartAfterMs: 4_000 },
      { crashLoop: true },
    ]);
  });

  it("counts only the crashes inside the window, and none after a clear", () => {
    const crashWindow = new CrashWindow();
    for (const at of [0, 1_000, 2_000, 3_000]) {
      crashWindow.recordCrash(at);
    }

    // The first crash has left the window, so three are held and this is the fourth.
    expect(crashWindow.recordCrash(THREE_MINUTES_MS)).toEqual({ restartAfterMs: 4_000 });
    expect(crashWindow.recordCrash(THREE_MINUTES_MS + 1)).toEqual({ crashLoop: true });

    crashWindow.clear();
    expect(crashWindow.recordCrash(THREE_MINUTES_MS + 2)).toEqual({ restartAfterMs: 0 });
  });
});
