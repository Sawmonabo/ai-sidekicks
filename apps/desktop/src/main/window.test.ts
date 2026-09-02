// Plan-023 Phase 1B (T-023p-1B-2) — window construction and the load ordering.
//
// Three properties are asserted here that nothing else in the suite reaches:
//
//   1. The main window loads the bundle over `sidekicks-renderer://`, and the
//      dev-server URL is loaded ONLY under the two-condition dev branch
//      (`!app.isPackaged` AND `ELECTRON_RENDERER_URL` set). A packaged build
//      that inherited a stray `ELECTRON_RENDERER_URL` from its parent shell
//      would otherwise load whatever that variable pointed at — remote content
//      inside a window whose `webPreferences` were locked down precisely so
//      that could not happen (Plan-023 I-023-2).
//   2. The window is constructed with the locked `webPreferences` block and is
//      shown only once its first paint is ready. `assert-webprefs.ts` proves the
//      literal is correct and appears exactly once in the source; this proves
//      the factory routes through it at runtime.
//   3. `beforeLoad` runs with the constructed window, after the navigation
//      policy and before `loadURL` — asserted as an ORDER, because the property
//      is the sequence and not the fact that both happened.
//
// The three neighbouring suites own the rest: `./window-navigation.test.ts` the
// policy's verdicts, `./window-load-failure.test.ts` the rejected-load ladder,
// and `./auxiliary-window.test.ts` the second factory.
//
// The `electron` module is mocked because a real `BrowserWindow` needs a
// running Electron process; these are `main-unit` tests (node environment, the
// project T-023p-1B-3 registers), not the smoke suite.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createElectronMock } from "../../test/helpers/electron-mock.js";
import {
  asMockWindow,
  DEV_SERVER_URL,
  INDEX_URL,
  POLICY_OPERATIONS,
} from "../../test/helpers/window-test-harness.js";

// `recordOrder` is on because the ordering cases below assert a SEQUENCE — a
// listener registered before the load began — which two independent per-window
// arrays cannot express.
const electronMock = createElectronMock({ recordOrder: true });

vi.mock("electron", () => electronMock.moduleExports);

type WindowModule = typeof import("./window.js");

/** Re-imports `window.ts` so each case observes a clean construction log. */
async function loadWindowModule(): Promise<WindowModule> {
  vi.resetModules();
  return import("./window.js");
}

describe("the main window factory", () => {
  beforeEach(() => {
    electronMock.reset();
    delete process.env["ELECTRON_RENDERER_URL"];
  });

  afterEach(() => {
    delete process.env["ELECTRON_RENDERER_URL"];
    vi.restoreAllMocks();
  });

  describe("the document URL", () => {
    it("loads the bundle over the renderer scheme in a packaged build", async () => {
      const { createMainWindow } = await loadWindowModule();

      const browserWindow = createMainWindow();

      expect(asMockWindow(browserWindow).loadedUrls).toEqual([INDEX_URL]);
    });

    it("loads the dev-server URL only when unpackaged AND the variable is set", async () => {
      electronMock.setPackaged(false);
      process.env["ELECTRON_RENDERER_URL"] = DEV_SERVER_URL;
      const { createMainWindow } = await loadWindowModule();

      const browserWindow = createMainWindow();

      expect(asMockWindow(browserWindow).loadedUrls).toEqual([DEV_SERVER_URL]);
    });

    // The load-bearing half: a packaged binary that inherited the variable
    // must still refuse it. This is the arm that would ship remote content
    // into a hardened window if the condition were an OR.
    it("refuses the dev-server URL when packaged even though the variable is set", async () => {
      electronMock.setPackaged(true);
      process.env["ELECTRON_RENDERER_URL"] = DEV_SERVER_URL;
      const { createMainWindow } = await loadWindowModule();

      const browserWindow = createMainWindow();

      expect(asMockWindow(browserWindow)).toBeDefined();
      expect(asMockWindow(browserWindow).loadedUrls).toEqual([INDEX_URL]);
    });

    it("refuses the dev-server URL when unpackaged and the variable is unset", async () => {
      electronMock.setPackaged(false);
      const { createMainWindow } = await loadWindowModule();

      const browserWindow = createMainWindow();

      expect(asMockWindow(browserWindow).loadedUrls).toEqual([INDEX_URL]);
    });

    // An empty string is a set-but-meaningless variable; treating it as set
    // would produce `loadURL("#/window/timeline")`, which is not a URL at all.
    it("refuses the dev-server URL when the variable is set to an empty string", async () => {
      electronMock.setPackaged(false);
      process.env["ELECTRON_RENDERER_URL"] = "";
      const { createMainWindow } = await loadWindowModule();

      const browserWindow = createMainWindow();

      expect(asMockWindow(browserWindow).loadedUrls).toEqual([INDEX_URL]);
    });
  });

  it("constructs the window through the locked webPreferences block", async () => {
    const { createMainWindow } = await loadWindowModule();

    createMainWindow();

    const options = electronMock.constructed[0]?.options;
    // Asserted here at runtime as well as at build time — `assert-webprefs.ts`
    // reads the source literal, and this reads what reached Electron.
    expect(options?.webPreferences).toMatchObject({
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
    });
    expect(options?.webPreferences["preload"]).toEqual(expect.stringContaining("preload"));
  });

  it("shows a window only once its first paint is ready", async () => {
    const { createMainWindow } = await loadWindowModule();

    const mainBrowserWindow = asMockWindow(createMainWindow());
    const readyToShow = mainBrowserWindow.onceHandlers.get("ready-to-show");

    expect(mainBrowserWindow.options.show).toBe(false);
    expect(readyToShow).toBeDefined();
  });

  // The main window deliberately carries NO `render-process-gone` handler:
  // destroying it would fire `window-all-closed` and quit the application
  // out from under the user. Main-window crash handling is the Tier-8 crash
  // reporter's (T-023r-3-2), not this factory's.
  it("does not register a renderer-gone handler on the main window", async () => {
    const { createMainWindow } = await loadWindowModule();

    const mainBrowserWindow = createMainWindow();

    expect(asMockWindow(mainBrowserWindow).webContents.handlers.has("render-process-gone")).toBe(
      false,
    );
  });

  // The load starts INSIDE the factory. A caller registering a load-lifecycle
  // listener on the returned window is on time only because Electron emits on a
  // later tick — true today, and a property of the runtime rather than of this
  // code. `beforeLoad` is what makes the ordering structural, and these cases
  // are what stop it silently regressing to the timing-dependent shape.
  describe("beforeLoad runs before the load starts", () => {
    it("invokes the hook, with the window, ahead of loadURL", async () => {
      const { createMainWindow } = await loadWindowModule();

      let windowSeenByHook: unknown;
      const browserWindow = createMainWindow({
        beforeLoad: (window) => {
          windowSeenByHook = window;
          window.webContents.once("did-finish-load", () => {});
        },
      });

      expect(windowSeenByHook).toBe(browserWindow);
      // The whole assertion is the ORDER. Asserting only that both happened
      // would pass on the regression this exists to catch.
      expect(electronMock.operations).toEqual([
        "construct",
        ...POLICY_OPERATIONS,
        "webContents.once:did-finish-load",
        `loadURL:${INDEX_URL}`,
      ]);
    });

    it("starts the load when no hook is supplied", async () => {
      const { createMainWindow } = await loadWindowModule();

      createMainWindow();

      expect(electronMock.operations).toEqual([
        "construct",
        ...POLICY_OPERATIONS,
        `loadURL:${INDEX_URL}`,
      ]);
    });

    it("destroys the window and rethrows when the hook throws", async () => {
      const { createMainWindow } = await loadWindowModule();

      const hookFailure = new Error("listener registration failed");

      expect(() =>
        createMainWindow({
          beforeLoad: () => {
            throw hookFailure;
          },
        }),
      ).toThrow(hookFailure);

      // No load, and nothing left alive: a hook that throws must not leave a
      // live, blank, unloaded window behind.
      expect(electronMock.operations).toEqual(["construct", ...POLICY_OPERATIONS, "destroy"]);
      expect(electronMock.constructed).toHaveLength(1);
      expect(electronMock.constructed[0]?.isDestroyed()).toBe(true);
    });
  });
});
