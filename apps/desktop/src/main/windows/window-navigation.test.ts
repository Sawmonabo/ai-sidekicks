// The navigation policy as installed. `assert-webprefs.ts` proves the locked `webPreferences`
// literal; it says nothing about navigation, and a locked window navigated to a remote origin
// runs attacker markup with the same preload, bridge and partition. `./navigation.test.ts` covers
// the pure classifier; this covers the wiring: every seam that can change a window's document
// carries the classification and takes the same decision. The redirect cases are the navigate
// cases with one string changed, because `will-navigate` fires on the original target and
// `will-redirect` is where a 302 to an outside origin is caught.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createElectronMock } from "@test/helpers/electron-mock.js";
import {
  DEV_SERVER_URL,
  INDEX_URL,
  navigationListenerOf,
  windowOpenHandlerOf,
} from "@test/helpers/window-test-harness.js";

const electronMock = createElectronMock();

vi.mock("electron", () => electronMock.moduleExports);

type WindowModule = typeof import("./window.js");

async function loadWindowModule(): Promise<WindowModule> {
  vi.resetModules();
  return import("./window.js");
}

/** The two seams that can change a live window's document, by event name. */
const NAVIGATION_SEAMS = ["will-navigate", "will-redirect"] as const;

describe("the navigation policy", () => {
  beforeEach(() => {
    electronMock.reset();
    delete process.env["ELECTRON_RENDERER_URL"];
  });

  afterEach(() => {
    delete process.env["ELECTRON_RENDERER_URL"];
    vi.restoreAllMocks();
  });

  it("registers both navigation seams and the popup handler on every window", async () => {
    const { createMainWindow } = await loadWindowModule();

    const browserWindow = createMainWindow();

    // Registration is asserted apart from the verdicts: a policy that classified correctly on
    // a seam nobody registered would pass every case that fetches its own listener.
    for (const seam of NAVIGATION_SEAMS) {
      expect(navigationListenerOf(browserWindow, seam)).toBeDefined();
    }
    expect(windowOpenHandlerOf(browserWindow)).toBeDefined();
  });

  describe.each(NAVIGATION_SEAMS)("on %s", (seam) => {
    it("stops a remote origin and opens it externally instead", async () => {
      const { createMainWindow } = await loadWindowModule();
      const browserWindow = createMainWindow();
      const preventDefault = vi.fn();

      navigationListenerOf(browserWindow, seam)({ preventDefault }, "https://example.test/docs");
      await vi.waitFor(() => {
        expect(electronMock.externalOpens).toEqual(["https://example.test/docs"]);
      });

      expect(preventDefault).toHaveBeenCalledTimes(1);
    });

    it("stops a scheme outside the allowlist and opens nothing", async () => {
      const { createMainWindow } = await loadWindowModule();
      const browserWindow = createMainWindow();
      const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const preventDefault = vi.fn();

      navigationListenerOf(browserWindow, seam)({ preventDefault }, "file:///etc/passwd");

      expect(preventDefault).toHaveBeenCalledTimes(1);
      expect(electronMock.externalOpens).toEqual([]);
      expect(consoleWarn).toHaveBeenCalledTimes(1);
    });

    it("refuses the dev-server origin in a packaged build", async () => {
      electronMock.setPackaged(true);
      process.env["ELECTRON_RENDERER_URL"] = DEV_SERVER_URL;
      const { createMainWindow } = await loadWindowModule();
      const browserWindow = createMainWindow();
      const preventDefault = vi.fn();

      navigationListenerOf(browserWindow, seam)({ preventDefault }, `${DEV_SERVER_URL}/index.html`);

      // Stopped, and handed to the browser rather than rendered: `http:` is an allowlisted
      // external scheme and a packaged build has no dev origin. Awaited because the open is
      // deferred a turn and would otherwise land in the next case's recording.
      expect(preventDefault).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => {
        expect(electronMock.externalOpens).toEqual([`${DEV_SERVER_URL}/index.html`]);
      });
    });
  });

  it("denies every popup, same origin included", async () => {
    const { createMainWindow } = await loadWindowModule();
    const browserWindow = createMainWindow();

    expect(windowOpenHandlerOf(browserWindow)({ url: INDEX_URL })).toEqual({ action: "deny" });
    expect(windowOpenHandlerOf(browserWindow)({ url: "https://example.test/docs" })).toEqual({
      action: "deny",
    });
    expect(electronMock.externalOpens).toEqual([]);
    await vi.waitFor(() => {
      expect(electronMock.externalOpens).toEqual(["https://example.test/docs"]);
    });
  });
});
