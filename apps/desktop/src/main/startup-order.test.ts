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

import { createElectronMock } from "../../test/helpers/electron-mock.js";

// The one shared `electron` mock (`test/helpers/electron-mock.ts`), with its
// ordered log on — sequence is the whole subject of this file. Its
// `app.whenReady()` is a DEFERRED the test resolves by hand through
// `releaseReady()`: awaiting the dynamic `import()` below already drains
// several microtask ticks, so a mock that returned an already-resolved promise
// would run the ready continuation before the test could observe the
// module-evaluation-only prefix — and the "registered before ready" claim would
// be untestable.
const electronMock = createElectronMock({ recordOrder: true });

vi.mock("electron", () => electronMock.moduleExports);

// The four operations this file is about, out of the fuller log the shared mock
// records. Filtering to them keeps the assertion a FULL SEQUENCE — any swap of
// any two still fails — without coupling this file to every operation the
// window factory happens to perform between them, which is `window.test.ts`'s
// subject and not this one's.
const STARTUP_OPERATIONS: readonly string[] = [
  "protocol.registerSchemesAsPrivileged",
  "app.whenReady",
  "protocol.handle",
  "construct",
];

/** The startup operations, in the order they actually ran. */
function startupSequence(): string[] {
  return electronMock.operations.filter((operation) => STARTUP_OPERATIONS.includes(operation));
}

/** Lets the `app.whenReady().then(...)` continuation run before assertions. */
async function drainMicrotasks(): Promise<void> {
  for (let tick = 0; tick < 4; tick++) {
    await Promise.resolve();
  }
}

describe("main-process startup order", () => {
  beforeEach(() => {
    electronMock.reset();
    electronMock.armReady();
    vi.resetModules();
  });

  it("registers the scheme before ready and installs the handler before any window", async () => {
    await import("./index.js");

    // Ready has not been released yet, so only the synchronous
    // module-evaluation calls are recorded. A `registerRendererScheme()` moved
    // inside `whenReady()` would leave this list without its first entry — the
    // exact regression Plan-023 I-023-11 exists to prevent, and one that is
    // invisible at runtime until the console finds it has no IndexedDB.
    expect(startupSequence()).toEqual(["protocol.registerSchemesAsPrivileged", "app.whenReady"]);

    electronMock.releaseReady();
    await drainMicrotasks();

    // The full sequence, not a pair of independent index comparisons: any swap
    // of any two of these four operations fails this assertion.
    expect(startupSequence()).toEqual([
      "protocol.registerSchemesAsPrivileged",
      "app.whenReady",
      "protocol.handle",
      "construct",
    ]);
  });
});
