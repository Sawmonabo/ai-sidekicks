// Shared reading helpers for the four window-factory suites — Plan-023 Phase 1B.
//
// `window.ts` was split by role (construction, navigation policy, failure
// ladder, auxiliary launch) and its suite split with it. Each suite still owns
// its own `createElectronMock` instance and its own `vi.mock("electron", …)`,
// because a mock instance must be a file-local `const` for the hoisted factory
// to close over — see `./electron-mock.ts`'s header. What is shared is only the
// READING: the one cast that turns a returned `BrowserWindow` back into the mock
// behind it, the accessors that pull a registered listener out of it, and the
// two URL literals every suite asserts against.
//
// The policy-operation list is here for the reason that matters most: it is the
// exact ordered prefix `constructLockedWindow` installs, and a seam added to the
// navigation policy without this constant moving would let the ordering cases in
// `window.test.ts` pass while `window-navigation.test.ts` was the only file that
// noticed. One constant, one failure.

import { expect } from "vitest";

import type { MockBrowserWindow } from "./electron-mock.js";

/** The dev-server origin `ELECTRON_RENDERER_URL` carries under `electron-vite dev`. */
export const DEV_SERVER_URL = "http://localhost:5173";

/**
 * The document URL a window loads in a packaged build.
 *
 * Spelled out rather than imported from `../../src/main/renderer-scheme.js`: a
 * test that imported the constant would agree with a typo in it.
 */
export const INDEX_URL = "sidekicks-renderer://app/index.html";

/**
 * The navigation policy every locked window carries, in the order
 * `constructLockedWindow` installs it.
 *
 * Named once so the ordering cases read as "policy, then the caller's hook, then
 * the load" rather than as a wall of strings — and so a policy seam added
 * without a test updating this constant fails every ordering case at once
 * instead of silently sliding in.
 */
export const POLICY_OPERATIONS: readonly string[] = [
  "webContents.on:will-navigate",
  "webContents.on:will-redirect",
  "webContents.setWindowOpenHandler",
];

/**
 * The mock window behind an `electron` `BrowserWindow` the factories hand back.
 *
 * One cast in one place. The factories are typed against Electron's own
 * `BrowserWindow`, and every recording a case reads — `loadedUrls`,
 * `onceHandlers`, the listener map — lives on the mock instead.
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
 * The listener registered for one navigation event on a window's `webContents`.
 *
 * Parameterised on the event rather than one accessor per seam, because the two
 * seams take the SAME classification: a case that exercises `will-navigate` and
 * a case that exercises `will-redirect` differ in one string and nothing else,
 * which is the property the redirect seam exists to have.
 */
export function navigationListenerOf(
  browserWindow: unknown,
  eventName: "will-navigate" | "will-redirect",
): NavigationListener {
  const handler = asMockWindow(browserWindow).webContents.handlers.get(eventName);
  expect(handler).toBeDefined();
  return handler as unknown as NavigationListener;
}
