// Plan-023 Phase 1B (T-023p-1B-1) — the main-process startup order.
//
// Two orderings are load-bearing and neither is visible from reading one file:
//
//   1. `protocol.registerSchemesAsPrivileged` must run BEFORE `app.whenReady()`.
//      Electron refuses the call after ready, and a scheme that never became
//      `standard` has no origin — so the renderer gets no IndexedDB and no
//      `localStorage` (Plan-023 I-023-11).
//   2. `protocol.handle` must run BEFORE the first `BrowserWindow` is
//      constructed, or a window can begin loading against an unhandled scheme.
//
// This test records the real call sequence by importing `main/index.ts` under a
// mocked `electron`, so a diff that moves either call fails here rather than at
// runtime. Plan-023 Phase 3's T-023r-3-4 inherits these legs and re-asserts the
// same two orderings after the crash reporter and single-instance lock join the
// sequence.

import { beforeEach, describe, expect, it, vi } from "vitest";

const startup = vi.hoisted(() => {
  const callOrder: string[] = [];
  // `app.whenReady()` is a DEFERRED the test resolves by hand. Awaiting the
  // dynamic `import()` below already drains several microtask ticks, so a mock
  // that returned an already-resolved promise would run the ready continuation
  // before the test could observe the module-evaluation-only prefix — and the
  // "registered before ready" claim would be untestable.
  let releaseReady: () => void = () => {};
  let readyPromise: Promise<void> = new Promise<void>((resolve) => {
    releaseReady = resolve;
  });
  return {
    callOrder,
    record(operation: string): void {
      callOrder.push(operation);
    },
    armReady(): void {
      callOrder.length = 0;
      readyPromise = new Promise<void>((resolve) => {
        releaseReady = resolve;
      });
    },
    whenReady(): Promise<void> {
      callOrder.push("whenReady");
      return readyPromise;
    },
    releaseReady(): void {
      releaseReady();
    },
  };
});

vi.mock("electron", () => {
  class MockBrowserWindow {
    public readonly webContents = {
      once: vi.fn(),
      on: vi.fn(),
      executeJavaScript: vi.fn(),
    };
    public constructor(public readonly options: unknown) {
      startup.record("BrowserWindow");
    }
    public on(): this {
      return this;
    }
    public once(): this {
      return this;
    }
    public show(): void {}
    public loadURL(): Promise<void> {
      return Promise.resolve();
    }
  }

  return {
    app: {
      requestSingleInstanceLock: () => true,
      whenReady: () => startup.whenReady(),
      on: vi.fn(),
      quit: vi.fn(),
      exit: vi.fn(),
      isPackaged: true,
    },
    BrowserWindow: MockBrowserWindow,
    Menu: {
      buildFromTemplate: vi.fn((template: unknown) => template),
      setApplicationMenu: vi.fn(),
    },
    protocol: {
      registerSchemesAsPrivileged: vi.fn(() => {
        startup.record("registerSchemesAsPrivileged");
      }),
      handle: vi.fn(() => {
        startup.record("protocol.handle");
      }),
    },
    net: { fetch: vi.fn() },
  };
});

/** Lets the `app.whenReady().then(...)` continuation run before assertions. */
async function drainMicrotasks(): Promise<void> {
  for (let tick = 0; tick < 4; tick++) {
    await Promise.resolve();
  }
}

describe("main-process startup order", () => {
  beforeEach(() => {
    startup.armReady();
    vi.resetModules();
  });

  it("registers the scheme before ready and installs the handler before any window", async () => {
    await import("./index.js");

    // Ready has not been released yet, so only the synchronous
    // module-evaluation calls are recorded. A `registerRendererScheme()` moved
    // inside `whenReady()` would leave this list without its first entry — the
    // exact regression Plan-023 I-023-11 exists to prevent, and one that is
    // invisible at runtime until the console finds it has no IndexedDB.
    expect(startup.callOrder).toEqual(["registerSchemesAsPrivileged", "whenReady"]);

    startup.releaseReady();
    await drainMicrotasks();

    // The full sequence, not a pair of independent index comparisons: any swap
    // of any two of these four operations fails this assertion.
    expect(startup.callOrder).toEqual([
      "registerSchemesAsPrivileged",
      "whenReady",
      "protocol.handle",
      "BrowserWindow",
    ]);
  });
});
