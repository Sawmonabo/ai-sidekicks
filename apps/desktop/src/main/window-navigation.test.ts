// Plan-023 Phase 1B (T-023p-1B-2) — the navigation policy, as installed.
//
// `assert-webprefs.ts` proves the locked `webPreferences` literal is correct and
// singular. It says nothing about NAVIGATION, and a locked window that can be
// navigated to a remote origin is a locked window protecting somebody else's
// content: the same preload, the same bridge, the same partition, now behind
// attacker-served markup.
//
// `./navigation.test.ts` is the unit suite over `classifyNavigation` — the pure
// verdict function, exhaustively. THIS suite is the wiring: that a constructed
// window carries the classification on every seam that can change its document,
// and that each seam does the same thing with the same verdict.
//
// Three seams, not two. `will-navigate` fires on the ORIGINAL target, so an
// admitted origin answering `302 Location: https://evil.test` is already past it
// by the time the redirect is known; `will-redirect` is where that is caught.
// The redirect cases below are deliberately the navigate cases with one string
// changed, because "the same classification and the same refusal" is the claim.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createElectronMock } from "../../test/helpers/electron-mock.js";
import {
  DEV_SERVER_URL,
  INDEX_URL,
  navigationListenerOf,
  windowOpenHandlerOf,
} from "../../test/helpers/window-test-harness.js";

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

    // Asserted as REGISTRATION, separately from the verdict cases below: a
    // policy that classified correctly on a seam nobody registered would pass
    // every case that invokes the listener it just fetched.
    for (const seam of NAVIGATION_SEAMS) {
      expect(navigationListenerOf(browserWindow, seam)).toBeDefined();
    }
    expect(windowOpenHandlerOf(browserWindow)).toBeDefined();
  });

  describe.each(NAVIGATION_SEAMS)("on %s", (seam) => {
    it("allows an in-window target within the renderer scheme", async () => {
      const { createMainWindow } = await loadWindowModule();
      const browserWindow = createMainWindow();
      const preventDefault = vi.fn();

      navigationListenerOf(browserWindow, seam)(
        { preventDefault },
        `${INDEX_URL}#/window/timeline`,
      );

      expect(preventDefault).not.toHaveBeenCalled();
      expect(electronMock.externalOpens).toEqual([]);
    });

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

      // Stopped in-window, and handed to the browser rather than rendered here:
      // `http:` is an allowlisted EXTERNAL scheme, and the packaged build has no
      // dev origin to render it in. Awaited rather than left in flight, because
      // the external open is deferred by one turn and an unawaited one lands in
      // the NEXT case's recording.
      expect(preventDefault).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => {
        expect(electronMock.externalOpens).toEqual([`${DEV_SERVER_URL}/index.html`]);
      });
    });

    it("allows the dev-server origin in-window under the dev branch", async () => {
      electronMock.setPackaged(false);
      process.env["ELECTRON_RENDERER_URL"] = DEV_SERVER_URL;
      const { createMainWindow } = await loadWindowModule();
      const browserWindow = createMainWindow();
      const preventDefault = vi.fn();

      navigationListenerOf(browserWindow, seam)({ preventDefault }, `${DEV_SERVER_URL}/index.html`);

      expect(preventDefault).not.toHaveBeenCalled();
      expect(electronMock.externalOpens).toEqual([]);
    });
  });

  // The two seams take the same decision and still say WHICH one fired: a
  // refusal log that could not tell "the page tried to navigate there" from "a
  // server redirected it there" describes two quite different incidents with one
  // sentence. This is the only place the seams are allowed to differ, so it is
  // asserted rather than left to the reader of the log.
  it.each([
    ["will-navigate", "refused an in-window navigation"],
    ["will-redirect", "refused an in-window redirect"],
  ] as const)("names %s in the refusal it logs", async (seam, expectedText) => {
    const { createMainWindow } = await loadWindowModule();
    const browserWindow = createMainWindow();
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

    navigationListenerOf(browserWindow, seam)({ preventDefault: vi.fn() }, "file:///etc/passwd");

    expect(consoleWarn.mock.calls.flat().join(" ")).toContain(expectedText);
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
