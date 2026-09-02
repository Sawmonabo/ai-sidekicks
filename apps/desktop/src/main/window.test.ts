// Plan-023 Phase 1B (T-023p-1B-2) — the window factories.
//
// Six properties are asserted here that nothing else in the suite reaches:
//
//   1. The main window loads the bundle over `sidekicks-renderer://`, and the
//      dev-server URL is loaded ONLY under the two-condition dev branch
//      (`!app.isPackaged` AND `ELECTRON_RENDERER_URL` set). A packaged build
//      that inherited a stray `ELECTRON_RENDERER_URL` from its parent shell
//      would otherwise load whatever that variable pointed at — remote content
//      inside a window whose `webPreferences` were locked down precisely so
//      that could not happen (Plan-023 I-023-2).
//   2. Every window — main and auxiliary — is constructed with the SAME locked
//      `webPreferences` block. `assert-webprefs.ts` proves the literal is
//      correct and appears exactly once in the source; this proves the second
//      factory actually routes through it at runtime (Plan-023 I-023-12).
//   3. Two auxiliary windows share no object identity: distinct `webContents`,
//      distinct ids, and neither holding the main window's. That is the
//      runtime half of "its own bridge instance and no shared store" — the
//      preload path is per-window by construction, and this proves the
//      factory does not hand back a cached window (Plan-023 I-023-12).
//   4. A malformed launch descriptor is refused BEFORE any `BrowserWindow` is
//      constructed. The pane context reaches the fragment of a URL the window
//      then loads, so an unvalidated id is caller-controlled input inside a
//      hardened window's document URL. "Refused" is asserted as zero
//      constructions, not merely as a throw: a factory that validated after
//      constructing would still throw and would still leave a live window.
//   5. Every window carries the navigation policy: in-window navigation is
//      confined to the renderer scheme (plus the dev origin under the dev
//      branch), every popup is denied, and an allowlisted external target
//      reaches the OS browser instead. The locked `webPreferences` block governs
//      what the renderer can DO; without this it says nothing about where the
//      renderer may GO, and a top-level navigation to a remote origin would put
//      attacker-served content behind the same preload and the same partition.
//   6. A rejected `loadURL` leaves no live blank window: the generated failure
//      document is served in its place, and when even that cannot be served the
//      window is destroyed — with the main window's process exiting non-zero
//      rather than sitting there as an invisible placeholder.
//
// The `electron` module is mocked because a real `BrowserWindow` needs a
// running Electron process; these are `main-unit` tests (node environment, the
// project T-023p-1B-3 registers), not the smoke suite.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createElectronMock, type MockBrowserWindow } from "../../test/helpers/electron-mock.js";

// `IMPLEMENTED_AUXILIARY_ROUTES` is empty in the shipped build at Phase 1B (see
// `../shared/auxiliary-routes.ts`), so the auxiliary factory is exercised
// against a stubbed list carrying both spec-named routes. The refusal arm below
// asserts the other direction: a route the list does NOT carry is refused before
// a window is constructed, which is the behaviour the shipped empty list
// produces for every route today.
const implementedRoutesMock = vi.hoisted(() => {
  const routes: string[] = [];
  return {
    routes,
    reset(): void {
      routes.length = 0;
    },
  };
});

// Only the implemented-route list is stubbed. `formatAuxiliaryFragment` and
// `isAuxiliaryRouteName` come from the real module through `importOriginal`, so
// the fragment shape every URL assertion below reads is production's and not a
// copy of it.
vi.mock("../shared/auxiliary-routes.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared/auxiliary-routes.js")>();
  return { ...actual, IMPLEMENTED_AUXILIARY_ROUTES: implementedRoutesMock.routes };
});

// The one shared `electron` mock (`test/helpers/electron-mock.ts`). `recordOrder`
// is on because several cases below assert a SEQUENCE — a listener registered
// before the load began — which two independent per-window arrays cannot express.
const electronMock = createElectronMock({ recordOrder: true });

vi.mock("electron", () => electronMock.moduleExports);

// The geometry each route opens at, restated from `window.ts`'s
// `AUXILIARY_WINDOW_GEOMETRY`. Restated rather than imported because the record
// is module-private: exporting it so a test could read it would let the test
// agree with a typo in it, which is the failure this pair of numbers exists to
// catch.
const TIMELINE_GEOMETRY = { width: 1100, height: 760 } as const;
const AGENT_CONSOLE_GEOMETRY = { width: 980, height: 720 } as const;

/**
 * The mock window behind an `electron` `BrowserWindow` the factories hand back.
 *
 * One cast in one place. The factories are typed against Electron's own
 * `BrowserWindow`, and every recording a case reads — `loadedUrls`,
 * `onceHandlers`, the listener map — lives on the mock instead.
 */
function asMockWindow(browserWindow: unknown): MockBrowserWindow {
  return browserWindow as unknown as MockBrowserWindow;
}

type WindowModule = typeof import("./window.js");

/** Re-imports `window.ts` so each case observes a clean construction log. */
async function loadWindowModule(): Promise<WindowModule> {
  vi.resetModules();
  return import("./window.js");
}

const DEV_SERVER_URL = "http://localhost:5173";
// Spelled out rather than imported, matching the literal every other case in
// this file asserts against: a test that imported the constant would agree with
// a typo in it.
const INDEX_URL = "sidekicks-renderer://app/index.html";

/**
 * The navigation policy every locked window carries, in the order
 * `constructLockedWindow` installs it.
 *
 * Named once so the ordering cases below read as "policy, then the caller's
 * hook, then the load" rather than as a wall of strings — and so a policy seam
 * added without a test updating this constant fails every ordering case at once
 * instead of silently sliding in.
 */
const POLICY_OPERATIONS: readonly string[] = [
  "webContents.on:will-navigate",
  "webContents.setWindowOpenHandler",
];

/** The handler `setWindowOpenHandler` received for a constructed window. */
function windowOpenHandlerOf(browserWindow: unknown): (details: { url: string }) => unknown {
  const handler = asMockWindow(browserWindow).webContents.windowOpenHandler;
  expect(handler).toBeDefined();
  return handler as (details: { url: string }) => unknown;
}

/** The `will-navigate` listener registered on a window's `webContents`. */
function willNavigateHandlerOf(
  browserWindow: unknown,
): (event: { preventDefault: () => void }, url: string) => void {
  const handler = asMockWindow(browserWindow).webContents.handlers.get("will-navigate");
  expect(handler).toBeDefined();
  return handler as (event: { preventDefault: () => void }, url: string) => void;
}

describe("window factories", () => {
  beforeEach(() => {
    electronMock.reset();
    implementedRoutesMock.reset();
    implementedRoutesMock.routes.push("timeline", "agent-console");
    delete process.env["ELECTRON_RENDERER_URL"];
  });

  afterEach(() => {
    delete process.env["ELECTRON_RENDERER_URL"];
    vi.restoreAllMocks();
  });

  describe("the main window's document URL", () => {
    it("loads the bundle over the renderer scheme in a packaged build", async () => {
      const { createMainWindow } = await loadWindowModule();

      const browserWindow = createMainWindow();

      expect(asMockWindow(browserWindow).loadedUrls).toEqual([
        "sidekicks-renderer://app/index.html",
      ]);
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
      expect(asMockWindow(browserWindow).loadedUrls).toEqual([
        "sidekicks-renderer://app/index.html",
      ]);
    });

    it("refuses the dev-server URL when unpackaged and the variable is unset", async () => {
      electronMock.setPackaged(false);
      const { createMainWindow } = await loadWindowModule();

      const browserWindow = createMainWindow();

      expect(asMockWindow(browserWindow).loadedUrls).toEqual([
        "sidekicks-renderer://app/index.html",
      ]);
    });

    // An empty string is a set-but-meaningless variable; treating it as set
    // would produce `loadURL("#/window/timeline")`, which is not a URL at all.
    it("refuses the dev-server URL when the variable is set to an empty string", async () => {
      electronMock.setPackaged(false);
      process.env["ELECTRON_RENDERER_URL"] = "";
      const { createMainWindow } = await loadWindowModule();

      const browserWindow = createMainWindow();

      expect(asMockWindow(browserWindow).loadedUrls).toEqual([
        "sidekicks-renderer://app/index.html",
      ]);
    });
  });

  describe("auxiliary windows", () => {
    it("routes both auxiliary routes to distinct window fragments", async () => {
      const { createAuxiliaryWindow } = await loadWindowModule();

      const timelineWindow = createAuxiliaryWindow({ route: "timeline" });
      const agentConsoleWindow = createAuxiliaryWindow({ route: "agent-console" });

      expect(asMockWindow(timelineWindow).loadedUrls).toEqual([
        "sidekicks-renderer://app/index.html#/window/timeline",
      ]);
      expect(asMockWindow(agentConsoleWindow).loadedUrls).toEqual([
        "sidekicks-renderer://app/index.html#/window/agent-console",
      ]);
    });

    it("constructs every window through the one locked webPreferences block", async () => {
      const { createMainWindow, createAuxiliaryWindow } = await loadWindowModule();

      createMainWindow();
      createAuxiliaryWindow({ route: "timeline" });
      createAuxiliaryWindow({ route: "agent-console" });

      const [mainOptions, ...auxiliaryOptions] = electronMock.constructed.map(
        (browserWindow) => browserWindow.options,
      );
      expect(mainOptions).toBeDefined();
      expect(auxiliaryOptions).toHaveLength(2);

      // Deep equality, not a subset check: an auxiliary window that ADDED a
      // key (say `webviewTag: true`) would pass a subset check and still be a
      // hole in the hardening baseline.
      for (const options of auxiliaryOptions) {
        expect(options.webPreferences).toEqual(mainOptions?.webPreferences);
      }

      // ...and the block is the Spec-023 §Security Hardening Baseline one,
      // asserted here at runtime as well as at build time.
      expect(mainOptions?.webPreferences).toMatchObject({
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        webSecurity: true,
      });
      expect(mainOptions?.webPreferences["preload"]).toEqual(expect.stringContaining("preload"));
    });

    it("opens each route at its own geometry", async () => {
      const { createAuxiliaryWindow } = await loadWindowModule();

      createAuxiliaryWindow({ route: "timeline" });
      createAuxiliaryWindow({ route: "agent-console" });

      expect(electronMock.constructed.map((browserWindow) => browserWindow.options)).toEqual([
        expect.objectContaining(TIMELINE_GEOMETRY),
        expect.objectContaining(AGENT_CONSOLE_GEOMETRY),
      ]);
      // Not merely "each has A geometry": two routes sharing one size would
      // satisfy the rows above if both rows named the same numbers.
      expect(TIMELINE_GEOMETRY).not.toEqual(AGENT_CONSOLE_GEOMETRY);
    });

    // The implemented-route list is the gate, and this is the arm the SHIPPED
    // empty list takes for every route today: absent from that list means no
    // renderer body, which means a window would open onto an empty hash route.
    it("refuses a route this build does not implement", async () => {
      implementedRoutesMock.reset();
      implementedRoutesMock.routes.push("timeline");
      const { createAuxiliaryWindow, InvalidAuxiliaryWindowLaunchError } = await loadWindowModule();

      expect(() => createAuxiliaryWindow({ route: "agent-console" })).toThrow(
        InvalidAuxiliaryWindowLaunchError,
      );
      expect(() => createAuxiliaryWindow({ route: "agent-console" })).toThrow("unknown route");
      expect(electronMock.constructed).toHaveLength(0);
    });

    it("hands back windows that share no identity with each other or the main window", async () => {
      const { createMainWindow, createAuxiliaryWindow } = await loadWindowModule();

      const mainBrowserWindow = createMainWindow();
      const firstAuxiliary = createAuxiliaryWindow({ route: "timeline" });
      const secondAuxiliary = createAuxiliaryWindow({ route: "agent-console" });

      const identifiers = [mainBrowserWindow.id, firstAuxiliary.id, secondAuxiliary.id];
      expect(new Set(identifiers).size).toBe(3);

      const webContentsIdentifiers = [
        mainBrowserWindow.webContents.id,
        firstAuxiliary.webContents.id,
        secondAuxiliary.webContents.id,
      ];
      expect(new Set(webContentsIdentifiers).size).toBe(3);
      expect(firstAuxiliary.webContents).not.toBe(secondAuxiliary.webContents);
      expect(firstAuxiliary.webContents).not.toBe(mainBrowserWindow.webContents);
    });

    it("destroys an auxiliary window whose renderer process is gone", async () => {
      const { createAuxiliaryWindow } = await loadWindowModule();
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

      const auxiliaryWindow = createAuxiliaryWindow({ route: "timeline" });
      const rendererGoneHandler = asMockWindow(auxiliaryWindow).webContents.handlers.get(
        "render-process-gone",
      ) as ((event: unknown, details: { reason: string; exitCode: number }) => void) | undefined;
      expect(rendererGoneHandler).toBeDefined();

      rendererGoneHandler?.({}, { reason: "crashed", exitCode: 133 });

      expect(auxiliaryWindow.isDestroyed()).toBe(true);
      expect(consoleError).toHaveBeenCalledTimes(1);
      expect(consoleError.mock.calls[0]?.[0]).toContain("route=timeline");
      expect(consoleError.mock.calls[0]?.[0]).toContain("reason=crashed");
    });

    describe("the launch descriptor", () => {
      // Canonical v4 UUIDs. `SessionIdSchema` is the contracts package's own
      // branded schema, so these are the real wire shape and not a local
      // approximation of it.
      const SESSION_ID = "0f1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d";
      const AGENT_ID = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";

      it("carries session context into the timeline fragment", async () => {
        const { createAuxiliaryWindow } = await loadWindowModule();

        const timelineWindow = createAuxiliaryWindow({
          route: "timeline",
          sessionId: SESSION_ID,
        });

        expect(asMockWindow(timelineWindow).loadedUrls).toEqual([
          `sidekicks-renderer://app/index.html#/window/timeline/${SESSION_ID}`,
        ]);
      });

      it("carries session and agent context into the agent-console fragment", async () => {
        const { createAuxiliaryWindow } = await loadWindowModule();

        const agentConsoleWindow = createAuxiliaryWindow({
          route: "agent-console",
          sessionId: SESSION_ID,
          agentId: AGENT_ID,
        });

        expect(asMockWindow(agentConsoleWindow).loadedUrls).toEqual([
          `sidekicks-renderer://app/index.html#/window/agent-console/${SESSION_ID}/${AGENT_ID}`,
        ]);
      });

      // Every refusal arm asserts BOTH halves: the typed throw, and that the
      // construction log is still empty. The second half is the one that
      // matters — a throw after `new BrowserWindow(...)` would leave a live
      // window loading an unvalidated URL and would still satisfy `toThrow`.
      const REFUSED_DESCRIPTORS: ReadonlyArray<{
        readonly label: string;
        readonly launch: Parameters<WindowModule["createAuxiliaryWindow"]>[0];
        readonly reason: string;
      }> = [
        {
          label: "a session id that is not a UUID",
          launch: { route: "timeline", sessionId: "not-a-uuid" },
          reason: "sessionId is not a canonical UUID",
        },
        {
          label: "a session id that is a UUID with a trailing path segment",
          launch: {
            route: "timeline",
            sessionId: `${SESSION_ID}/../../etc/passwd`,
          },
          reason: "sessionId is not a canonical UUID",
        },
        {
          label: "an empty session id",
          launch: { route: "timeline", sessionId: "" },
          reason: "sessionId is not a canonical UUID",
        },
        {
          label: "agent-console context with no agent id",
          launch: { route: "agent-console", sessionId: SESSION_ID },
          reason: "agent-console context requires an agentId",
        },
        {
          label: "an agent id that is not a UUID",
          launch: {
            route: "agent-console",
            sessionId: SESSION_ID,
            agentId: "console#injected",
          },
          reason: "agentId is not a canonical UUID",
        },
        {
          label: "an agent id with no session to read it in",
          launch: { route: "agent-console", agentId: AGENT_ID },
          reason: "agentId supplied without sessionId",
        },
        {
          label: "a route outside the closed set",
          // Cast: the compile-time union already refuses this, and the runtime
          // check exists for the renderer-initiated detach on the growth slate,
          // which arrives over IPC where a type is a claim and not a guarantee.
          launch: { route: "settings" } as unknown as Parameters<
            WindowModule["createAuxiliaryWindow"]
          >[0],
          reason: "unknown route",
        },
      ];

      for (const { label, launch, reason } of REFUSED_DESCRIPTORS) {
        it(`refuses ${label} without constructing a window`, async () => {
          const { createAuxiliaryWindow, InvalidAuxiliaryWindowLaunchError } =
            await loadWindowModule();

          expect(() => createAuxiliaryWindow(launch)).toThrow(InvalidAuxiliaryWindowLaunchError);
          expect(() => createAuxiliaryWindow(launch)).toThrow(reason);
          expect(electronMock.constructed).toHaveLength(0);
        });
      }

      // The refusal message must not echo the value that failed the check: a
      // rejected id is untrusted input, and a log line is a reader.
      it("keeps the refused value out of the refusal message", async () => {
        const { createAuxiliaryWindow } = await loadWindowModule();
        const poisonedSessionId = "<script>alert(1)</script>";

        expect(() =>
          createAuxiliaryWindow({ route: "timeline", sessionId: poisonedSessionId }),
        ).toThrow(/^invalid auxiliary window launch: sessionId is not a canonical UUID$/);
      });
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
  });

  it("shows a window only once its first paint is ready", async () => {
    const { createMainWindow } = await loadWindowModule();

    const mainBrowserWindow = asMockWindow(createMainWindow());
    const readyToShow = mainBrowserWindow.onceHandlers.get("ready-to-show");

    expect(mainBrowserWindow.options.show).toBe(false);
    expect(readyToShow).toBeDefined();
  });

  // The load starts INSIDE the factory. A caller registering a load-lifecycle
  // listener on the returned window is on time only because Electron emits on a
  // later tick — true today, and a property of the runtime rather than of this
  // code. `beforeLoad` is what makes the ordering structural, and these cases
  // are what stop it silently regressing to the timing-dependent shape.
  describe("beforeLoad runs before the load starts", () => {
    it("invokes the hook, with the window, ahead of loadURL on the main window", async () => {
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

    it("invokes the hook ahead of loadURL on an auxiliary window too", async () => {
      const { createAuxiliaryWindow } = await loadWindowModule();

      createAuxiliaryWindow(
        { route: "timeline" },
        {
          beforeLoad: (window) => {
            window.webContents.once("did-finish-load", () => {});
          },
        },
      );

      // The factory's own `render-process-gone` registration is in the log too,
      // and is likewise before the load — the sibling factory must not drift
      // into the ordering this hook exists to guarantee.
      expect(electronMock.operations).toEqual([
        "construct",
        ...POLICY_OPERATIONS,
        "webContents.on:render-process-gone",
        "webContents.once:did-finish-load",
        `loadURL:${INDEX_URL}#/window/timeline`,
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

  // `assert-webprefs.ts` proves the locked `webPreferences` literal is correct
  // and singular. It says nothing about NAVIGATION, and a locked window that can
  // be navigated to a remote origin is a locked window protecting somebody
  // else's content. These are the arms of that policy.
  describe("the navigation policy", () => {
    it("allows in-window navigation within the renderer scheme", async () => {
      const { createMainWindow } = await loadWindowModule();
      const browserWindow = createMainWindow();
      const preventDefault = vi.fn();

      willNavigateHandlerOf(browserWindow)({ preventDefault }, `${INDEX_URL}#/window/timeline`);

      expect(preventDefault).not.toHaveBeenCalled();
      expect(electronMock.externalOpens).toEqual([]);
    });

    it("stops an in-window navigation to a remote origin and opens it externally", async () => {
      const { createMainWindow } = await loadWindowModule();
      const browserWindow = createMainWindow();
      const preventDefault = vi.fn();

      willNavigateHandlerOf(browserWindow)({ preventDefault }, "https://example.test/docs");
      await vi.waitFor(() => {
        expect(electronMock.externalOpens).toEqual(["https://example.test/docs"]);
      });

      expect(preventDefault).toHaveBeenCalledTimes(1);
    });

    it("stops a navigation to a scheme outside the allowlist and opens nothing", async () => {
      const { createMainWindow } = await loadWindowModule();
      const browserWindow = createMainWindow();
      const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const preventDefault = vi.fn();

      willNavigateHandlerOf(browserWindow)({ preventDefault }, "file:///etc/passwd");

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

      willNavigateHandlerOf(browserWindow)({ preventDefault }, `${DEV_SERVER_URL}/index.html`);

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

      willNavigateHandlerOf(browserWindow)({ preventDefault }, `${DEV_SERVER_URL}/index.html`);

      expect(preventDefault).not.toHaveBeenCalled();
      expect(electronMock.externalOpens).toEqual([]);
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

    it("installs the policy on auxiliary windows too", async () => {
      const { createAuxiliaryWindow } = await loadWindowModule();
      const auxiliaryWindow = createAuxiliaryWindow({ route: "timeline" });
      const preventDefault = vi.fn();

      willNavigateHandlerOf(auxiliaryWindow)({ preventDefault }, "https://example.test/docs");

      expect(preventDefault).toHaveBeenCalledTimes(1);
      expect(windowOpenHandlerOf(auxiliaryWindow)({ url: "https://example.test/x" })).toEqual({
        action: "deny",
      });
    });
  });

  // A rejected `loadURL` used to log and return, leaving a live blank window
  // with no content and no reason. Both arms of the replacement are asserted:
  // the failure document, and the give-up path when even that cannot be served.
  describe("a rejected document load", () => {
    it("serves the generated failure document carrying the reason", async () => {
      electronMock.failLoadsContaining(INDEX_URL, new Error("ERR_FILE_NOT_FOUND (-6)"));
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      const { createMainWindow } = await loadWindowModule();

      const browserWindow = createMainWindow();

      await vi.waitFor(() => {
        expect(asMockWindow(browserWindow).loadedUrls).toHaveLength(2);
      });
      const [, failureUrl] = asMockWindow(browserWindow).loadedUrls;
      expect(failureUrl).toContain("/-/load-failure");
      expect(failureUrl).toContain(encodeURIComponent("ERR_FILE_NOT_FOUND (-6)"));
      expect(browserWindow.isDestroyed()).toBe(false);
      expect(electronMock.exitCodes).toEqual([]);
      expect(consoleError).toHaveBeenCalled();
    });

    it("destroys the main window and exits non-zero when no document can be served", async () => {
      electronMock.failLoadsContaining("sidekicks-renderer://app", new Error("handler missing"));
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      const { createMainWindow, RENDERER_UNSERVABLE_EXIT_CODE } = await loadWindowModule();

      const browserWindow = createMainWindow();

      await vi.waitFor(() => {
        expect(electronMock.exitCodes).toEqual([RENDERER_UNSERVABLE_EXIT_CODE]);
      });
      expect(browserWindow.isDestroyed()).toBe(true);
      expect(consoleError.mock.calls.flat().join(" ")).toContain("no renderer document");
    });

    it("destroys an auxiliary window without exiting the application", async () => {
      electronMock.failLoadsContaining("sidekicks-renderer://app", new Error("handler missing"));
      vi.spyOn(console, "error").mockImplementation(() => {});
      const { createAuxiliaryWindow } = await loadWindowModule();

      const auxiliaryWindow = createAuxiliaryWindow({ route: "timeline" });

      await vi.waitFor(() => {
        expect(auxiliaryWindow.isDestroyed()).toBe(true);
      });
      expect(electronMock.exitCodes).toEqual([]);
    });
  });
});
