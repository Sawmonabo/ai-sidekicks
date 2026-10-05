// Reading and building helpers shared by the window suites. Each suite owns its
// `createElectronMock` instance and `vi.mock("electron", …)`, because the instance must be a
// file-local `const` for the hoisted factory to close over (see
// `./electron/mock/electron-mock.ts`). Only the reading is shared: the casts back to the mock, the
// listener accessors, a window's frame and the URL literals.

import { expect, vi, type Mock } from "vitest";

import type { MainDiagnosticLog } from "@main/services/diagnostic-log.js";
import type { WindowFrame } from "@main/windows/window.js";
import { MERIDIAN_GROUNDS } from "@shared/appearance.js";

import {
  createMockWebContents,
  type MockBaseWindow,
  type MockWebContents,
} from "./electron/mock/window.js";

/** The dev-server origin `ELECTRON_RENDERER_URL` carries under `electron-vite dev`. */
export const DEV_SERVER_URL = "http://localhost:5173";

/**
 * The document URL a window loads in a packaged build. Spelled out, not imported from
 * `src/main/services/renderer/scheme.ts`: an imported constant would agree with a typo in it.
 */
export const INDEX_URL = "sidekicks-renderer://app/index.html";

/**
 * What every locked window's document carries, in the order `constructLockedWindow` installs it:
 * the navigation policy, then the close pairing and the title mirror. Named once
 * so the ordering cases read as these, then the caller's hook, then the load, and a new seam fails
 * all of them at once.
 */
export const LOCKED_WINDOW_OPERATIONS: readonly string[] = [
  "webContents.on:will-navigate",
  "webContents.on:will-redirect",
  "webContents.setWindowOpenHandler",
  "webContents.once:destroyed",
  "webContents.on:page-title-updated",
];

/** Main's log as a window case reads it: every entry written, and a drain that settles at once. */
export interface RecordingWindowLog {
  readonly write: Mock<MainDiagnosticLog["write"]>;
  readonly drain: Mock<MainDiagnosticLog["drain"]>;
}

/** A window frame at a fixed rectangle, answering no `window.open`, over a log of its own. */
export function testWindowFrame(): WindowFrame & { readonly log: RecordingWindowLog } {
  return {
    bounds: { x: 0, y: 25, width: 1200, height: 800 },
    reveal: { isMaximized: false, isFullScreen: false },
    background: MERIDIAN_GROUNDS.light,
    openChildWindow: () => undefined,
    log: {
      write: vi.fn<MainDiagnosticLog["write"]>(),
      drain: vi.fn<MainDiagnosticLog["drain"]>(() => Promise.resolve()),
    },
  };
}

/** Every message `log` was handed, in order. */
export function loggedMessages(log: RecordingWindowLog): string[] {
  return log.write.mock.calls.map(([entry]) => entry.message);
}

/** One window the factories hand back, as the mock built it. */
export interface MockRendererWindow {
  readonly baseWindow: MockBaseWindow;
  readonly document: MockWebContents;
}

/**
 * The mock behind a `RendererWindow` the factories hand back. Every recording a case reads lives
 * on the mock, not on Electron's types.
 */
export function asMockWindow(rendererWindow: unknown): MockRendererWindow {
  const { baseWindow, view } = rendererWindow as {
    baseWindow: MockBaseWindow;
    view: { webContents: MockWebContents };
  };
  return { baseWindow, document: view.webContents };
}

/**
 * A document Chromium hands `createWindow` for a `window.open` child, reporting to no mock: no case
 * reads what it records.
 */
export function handedDocument(): MockWebContents {
  return createMockWebContents({
    record: () => undefined,
    recordConstruction: () => undefined,
    recordView: () => undefined,
    forgetWindow: () => undefined,
    mintId: () => 500,
    loadFailureFor: () => undefined,
  });
}

/** A navigation listener as a case invokes it. */
export type NavigationListener = (event: { preventDefault: () => void }, url: string) => void;

/** The handler `setWindowOpenHandler` received for a window's document. */
export function windowOpenHandlerOf(
  rendererWindow: unknown,
): (details: { url: string; frameName: string }) => unknown {
  const handler = asMockWindow(rendererWindow).document.windowOpenHandler;
  expect(handler).toBeDefined();
  return handler as (details: { url: string; frameName: string }) => unknown;
}

/**
 * The listener registered for one navigation event on a window's document. It takes the event
 * because `will-navigate` and `will-redirect` share one classification.
 */
export function navigationListenerOf(
  rendererWindow: unknown,
  eventName: "will-navigate" | "will-redirect",
): NavigationListener {
  const handler = asMockWindow(rendererWindow).document.handlers.get(eventName);
  expect(handler).toBeDefined();
  return handler as unknown as NavigationListener;
}
