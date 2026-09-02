// Plan-023 Phase 1B (T-023p-1B-2) — the auxiliary window factory.
//
// Three properties are asserted here that nothing else in the suite reaches:
//
//   1. Every auxiliary window is constructed with the SAME locked
//      `webPreferences` block as the main one. `assert-webprefs.ts` proves the
//      literal is correct and appears exactly once in the source; this proves
//      the second factory actually routes through it at runtime
//      (Plan-023 I-023-12).
//   2. Two auxiliary windows share no object identity: distinct `webContents`,
//      distinct ids, and neither holding the main window's. That is the runtime
//      half of "its own bridge instance and no shared store" — the preload path
//      is per-window by construction, and this proves the factory does not hand
//      back a cached window (Plan-023 I-023-12).
//   3. A malformed launch descriptor is refused BEFORE any `BrowserWindow` is
//      constructed. The pane context reaches the fragment of a URL the window
//      then loads, so an unvalidated id is caller-controlled input inside a
//      hardened window's document URL. "Refused" is asserted as zero
//      constructions, not merely as a throw: a factory that validated after
//      constructing would still throw and would still leave a live window.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createElectronMock } from "../../test/helpers/electron-mock.js";
import {
  asMockWindow,
  INDEX_URL,
  POLICY_OPERATIONS,
} from "../../test/helpers/window-test-harness.js";

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

// `recordOrder` is on because the ordering case below asserts a SEQUENCE — the
// factory's own crash listener and the caller's hook, both before the load.
const electronMock = createElectronMock({ recordOrder: true });

vi.mock("electron", () => electronMock.moduleExports);

// The geometry each route opens at, restated from `auxiliary-window.ts`'s
// `AUXILIARY_WINDOW_GEOMETRY`. Restated rather than imported because the record
// is module-private: exporting it so a test could read it would let the test
// agree with a typo in it, which is the failure this pair of numbers exists to
// catch.
const TIMELINE_GEOMETRY = { width: 1100, height: 760 } as const;
const AGENT_CONSOLE_GEOMETRY = { width: 980, height: 720 } as const;

type AuxiliaryWindowModule = typeof import("./auxiliary-window.js");

/** Re-imports both factories so each case observes a clean construction log. */
async function loadFactories(): Promise<{
  createMainWindow: (typeof import("./window.js"))["createMainWindow"];
  auxiliary: AuxiliaryWindowModule;
}> {
  vi.resetModules();
  const { createMainWindow } = await import("./window.js");
  return { createMainWindow, auxiliary: await import("./auxiliary-window.js") };
}

describe("the auxiliary window factory", () => {
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

  it("routes both auxiliary routes to distinct window fragments", async () => {
    const { auxiliary } = await loadFactories();

    const timelineWindow = auxiliary.createAuxiliaryWindow({ route: "timeline" });
    const agentConsoleWindow = auxiliary.createAuxiliaryWindow({ route: "agent-console" });

    expect(asMockWindow(timelineWindow).loadedUrls).toEqual([`${INDEX_URL}#/window/timeline`]);
    expect(asMockWindow(agentConsoleWindow).loadedUrls).toEqual([
      `${INDEX_URL}#/window/agent-console`,
    ]);
  });

  it("constructs every window through the one locked webPreferences block", async () => {
    const { createMainWindow, auxiliary } = await loadFactories();

    createMainWindow();
    auxiliary.createAuxiliaryWindow({ route: "timeline" });
    auxiliary.createAuxiliaryWindow({ route: "agent-console" });

    const [mainOptions, ...auxiliaryOptions] = electronMock.constructed.map(
      (browserWindow) => browserWindow.options,
    );
    expect(mainOptions).toBeDefined();
    expect(auxiliaryOptions).toHaveLength(2);

    // Deep equality, not a subset check: an auxiliary window that ADDED a key
    // (say `webviewTag: true`) would pass a subset check and still be a hole in
    // the hardening baseline.
    for (const options of auxiliaryOptions) {
      expect(options.webPreferences).toEqual(mainOptions?.webPreferences);
    }
  });

  it("opens each route at its own geometry", async () => {
    const { auxiliary } = await loadFactories();

    auxiliary.createAuxiliaryWindow({ route: "timeline" });
    auxiliary.createAuxiliaryWindow({ route: "agent-console" });

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
    const { auxiliary } = await loadFactories();

    expect(() => auxiliary.createAuxiliaryWindow({ route: "agent-console" })).toThrow(
      auxiliary.InvalidAuxiliaryWindowLaunchError,
    );
    expect(() => auxiliary.createAuxiliaryWindow({ route: "agent-console" })).toThrow(
      "unknown route",
    );
    expect(electronMock.constructed).toHaveLength(0);
  });

  it("hands back windows that share no identity with each other or the main window", async () => {
    const { createMainWindow, auxiliary } = await loadFactories();

    const mainBrowserWindow = createMainWindow();
    const firstAuxiliary = auxiliary.createAuxiliaryWindow({ route: "timeline" });
    const secondAuxiliary = auxiliary.createAuxiliaryWindow({ route: "agent-console" });

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

  it("carries the navigation policy and invokes the hook ahead of the load", async () => {
    const { auxiliary } = await loadFactories();

    auxiliary.createAuxiliaryWindow(
      { route: "timeline" },
      {
        beforeLoad: (window) => {
          window.webContents.once("did-finish-load", () => {});
        },
      },
    );

    // The factory's own `render-process-gone` registration is in the log too,
    // and is likewise before the load — the sibling factory must not drift into
    // the ordering the hook exists to guarantee.
    expect(electronMock.operations).toEqual([
      "construct",
      ...POLICY_OPERATIONS,
      "webContents.on:render-process-gone",
      "webContents.once:did-finish-load",
      `loadURL:${INDEX_URL}#/window/timeline`,
    ]);
  });

  it("destroys an auxiliary window whose renderer process is gone", async () => {
    const { auxiliary } = await loadFactories();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const auxiliaryWindow = auxiliary.createAuxiliaryWindow({ route: "timeline" });
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

  // The auxiliary half of the give-up rung: no document can be served, so the
  // window goes — and the APPLICATION does not, because quitting because a
  // detached console failed would be the worse outcome.
  it("destroys an unservable auxiliary window without exiting the application", async () => {
    electronMock.failLoadsContaining("sidekicks-renderer://app", new Error("handler missing"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { auxiliary } = await loadFactories();

    const auxiliaryWindow = auxiliary.createAuxiliaryWindow({ route: "timeline" });

    await vi.waitFor(() => {
      expect(auxiliaryWindow.isDestroyed()).toBe(true);
    });
    expect(electronMock.exitCodes).toEqual([]);
  });

  describe("the launch descriptor", () => {
    // Canonical v4 UUIDs. `SessionIdSchema` is the contracts package's own
    // branded schema, so these are the real wire shape and not a local
    // approximation of it.
    const SESSION_ID = "0f1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d";
    const AGENT_ID = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";

    it("carries session context into the timeline fragment", async () => {
      const { auxiliary } = await loadFactories();

      const timelineWindow = auxiliary.createAuxiliaryWindow({
        route: "timeline",
        sessionId: SESSION_ID,
      });

      expect(asMockWindow(timelineWindow).loadedUrls).toEqual([
        `${INDEX_URL}#/window/timeline/${SESSION_ID}`,
      ]);
    });

    it("carries session and agent context into the agent-console fragment", async () => {
      const { auxiliary } = await loadFactories();

      const agentConsoleWindow = auxiliary.createAuxiliaryWindow({
        route: "agent-console",
        sessionId: SESSION_ID,
        agentId: AGENT_ID,
      });

      expect(asMockWindow(agentConsoleWindow).loadedUrls).toEqual([
        `${INDEX_URL}#/window/agent-console/${SESSION_ID}/${AGENT_ID}`,
      ]);
    });

    // Every refusal arm asserts BOTH halves: the typed throw, and that the
    // construction log is still empty. The second half is the one that matters —
    // a throw after `new BrowserWindow(...)` would leave a live window loading
    // an unvalidated URL and would still satisfy `toThrow`.
    const REFUSED_DESCRIPTORS: ReadonlyArray<{
      readonly label: string;
      readonly launch: Parameters<AuxiliaryWindowModule["createAuxiliaryWindow"]>[0];
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
          AuxiliaryWindowModule["createAuxiliaryWindow"]
        >[0],
        reason: "unknown route",
      },
    ];

    for (const { label, launch, reason } of REFUSED_DESCRIPTORS) {
      it(`refuses ${label} without constructing a window`, async () => {
        const { auxiliary } = await loadFactories();

        expect(() => auxiliary.createAuxiliaryWindow(launch)).toThrow(
          auxiliary.InvalidAuxiliaryWindowLaunchError,
        );
        expect(() => auxiliary.createAuxiliaryWindow(launch)).toThrow(reason);
        expect(electronMock.constructed).toHaveLength(0);
      });
    }

    // The refusal message must not echo the value that failed the check: a
    // rejected id is untrusted input, and a log line is a reader.
    it("keeps the refused value out of the refusal message", async () => {
      const { auxiliary } = await loadFactories();
      const poisonedSessionId = "<script>alert(1)</script>";

      expect(() =>
        auxiliary.createAuxiliaryWindow({ route: "timeline", sessionId: poisonedSessionId }),
      ).toThrow(/^invalid auxiliary window launch: sessionId is not a canonical UUID$/);
    });
  });
});
