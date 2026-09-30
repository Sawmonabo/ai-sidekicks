// What the context meter puts on screen: the not-checked state before the daemon has reported
// anything, the share the reading carries once it has, and never a color or a hint however full
// the window is. Uses the real `SessionStore`.

import { describe, expect, it } from "vitest";

import {
  ADDRESSED,
  RUN_ID,
  contextWindowEvent,
  mountToolbar,
} from "./composer-toolbar.test-support.js";

describe("ComposerToolbar — the context meter", () => {
  it("renders the not-checked meter when the daemon has reported nothing", () => {
    const container = mountToolbar([], ADDRESSED);
    expect(container.querySelector(".meridian-context-ring")).toBeNull();
    expect(container.querySelector(".meridian-nothing--not-checked")).not.toBeNull();
  });

  it("negative control: a session with a reading draws the meter instead", () => {
    const container = mountToolbar([contextWindowEvent(1)], ADDRESSED);
    const meter = container.querySelector('[role="progressbar"]');
    expect(meter?.getAttribute("aria-valuenow")).toBe("84");
  });

  it("is never colored and adds no hint at 80% or past the window", () => {
    // Fullness changes the figure and never the color or the copy beside it.
    const nearFull = mountToolbar([contextWindowEvent(1)], ADDRESSED);
    const pastTheWindow = mountToolbar(
      [
        {
          ...contextWindowEvent(1),
          payload: {
            runId: RUN_ID,
            windowUsedTokens: 210_000,
            windowMaxTokens: 200_000,
            windowSource: "provider_reported",
            exceeded: true,
          },
        },
      ],
      ADDRESSED,
    );

    for (const container of [nearFull, pastTheWindow]) {
      expect(container.querySelector(".meridian-context-ring__hint")).toBeNull();
      expect(
        container.querySelector(".meridian-context-ring__fill")?.getAttributeNames(),
      ).toStrictEqual(["class", "style"]);
      expect(container.querySelector('[role="status"]')).toBeNull();
    }
    expect(nearFull.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe(
      "84",
    );
    expect(pastTheWindow.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe(
      "100",
    );
  });
});
