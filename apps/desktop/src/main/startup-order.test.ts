// Two orderings are load-bearing: `protocol.registerSchemesAsPrivileged` before
// `app.whenReady()` (Electron refuses it after ready, and a non-`standard` scheme has no
// origin, so no IndexedDB or `localStorage`), and `protocol.handle` before the first
// `BrowserWindow` (or a window loads against an unhandled scheme). This records the real call
// sequence by importing `index.ts` under a mocked `electron`.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { createElectronMock } from "@test/helpers/electron-mock.js";

// The mock's `app.whenReady()` is a deferred the test releases by hand: awaiting the dynamic
// `import()` already drains several microtask ticks, so an already-resolved promise would run
// the ready continuation before the module-evaluation prefix could be observed.
const electronMock = createElectronMock({ recordOrder: true });

vi.mock("electron", () => electronMock.moduleExports);

// Filtering the mock's log to these four keeps the assertion a full sequence without
// coupling it to the other operations the window factory performs between them.
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

    // Ready is not released yet, so only module-evaluation calls are recorded. A
    // `registerRendererScheme()` moved inside `whenReady()` would drop the first entry.
    expect(startupSequence()).toEqual(["protocol.registerSchemesAsPrivileged", "app.whenReady"]);

    electronMock.releaseReady();
    await drainMicrotasks();

    // The full sequence, so a swap of any two operations fails.
    expect(startupSequence()).toEqual([
      "protocol.registerSchemesAsPrivileged",
      "app.whenReady",
      "protocol.handle",
      "construct",
    ]);
  });
});
