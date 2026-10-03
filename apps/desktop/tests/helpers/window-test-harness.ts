// Reading helpers shared by the three window-factory suites. Each suite owns its
// `createElectronMock` instance and `vi.mock("electron", …)`, because the instance must be a
// file-local `const` for the hoisted factory to close over (see `./electron-mock.ts`). Only the
// reading is shared: the cast back to the mock, the listener accessors and the URL literals.

import { expect } from "vitest";

import type { MockBrowserWindow } from "./electron-mock-window.js";

/** The dev-server origin `ELECTRON_RENDERER_URL` carries under `electron-vite dev`. */
export const DEV_SERVER_URL = "http://localhost:5173";

/**
 * The document URL a window loads in a packaged build. Spelled out, not imported from
 * `src/main/services/renderer-scheme.ts`: an imported constant would agree with a typo in it.
 */
export const INDEX_URL = "sidekicks-renderer://app/index.html";

/**
 * The navigation policy every locked window carries, in the order `constructLockedWindow`
 * installs it. Named once so the ordering cases read as policy, then the caller's hook, then the
 * load, and a new policy seam fails all of them at once.
 */
export const POLICY_OPERATIONS: readonly string[] = [
  "webContents.on:will-navigate",
  "webContents.on:will-redirect",
  "webContents.setWindowOpenHandler",
];

/**
 * The mock window behind an `electron` `BrowserWindow` the factories hand back. Every recording a
 * case reads (`loadedUrls`, the `webContents` listener map) lives on the mock, not on
 * Electron's type.
 */
export function asMockWindow(browserWindow: unknown): MockBrowserWindow {
  return browserWindow as unknown as MockBrowserWindow;
}

/** A navigation listener as a case invokes it. */
export type NavigationListener = (event: { preventDefault: () => void }, url: string) => void;

/** The handler `setWindowOpenHandler` received for a constructed window. */
export function windowOpenHandlerOf(browserWindow: unknown): (details: { url: string }) => unknown {
  const handler = asMockWindow(browserWindow).webContents.windowOpenHandler;
  expect(handler).toBeDefined();
  return handler as (details: { url: string }) => unknown;
}

/**
 * The listener registered for one navigation event on a window's `webContents`. It takes the
 * event because `will-navigate` and `will-redirect` share one classification.
 */
export function navigationListenerOf(
  browserWindow: unknown,
  eventName: "will-navigate" | "will-redirect",
): NavigationListener {
  const handler = asMockWindow(browserWindow).webContents.handlers.get(eventName);
  expect(handler).toBeDefined();
  return handler as unknown as NavigationListener;
}
