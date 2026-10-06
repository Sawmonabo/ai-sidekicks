// The app's appearance against main's record, the one copy: every open window's document root
// shows what main kept, a window opened later shows it before it draws, a scheme act asks main over
// the rest of that record (waiting for main's first delivery when it runs before one), and a change
// main refuses leaves the roots as they were and says so on the asking window's banner. Main's
// `window` members are a stand-in whose first delivery the case sends, as the preload's arrives
// after a round trip.

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FrameWindows } from "#test/helpers/frame-windows.js";
import { OpenWindowFrames } from "#renderer/lib/open-window-frames.js";
import { OpenWindows } from "#renderer/services/window/open-windows.js";

import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import type { AppearanceMembers } from "#renderer/services/window/appearance-client.js";
import { WindowStore } from "#renderer/store/window/store.js";
import {
  RESOLVED_SCHEME_ATTRIBUTE,
  SCHEME_ATTRIBUTE,
  THEME_ATTRIBUTE,
  type AppearanceRecord,
} from "#shared/appearance.js";
import { discloseUnkeptScheme } from "../unkept-scheme.js";
import { useAppearance } from "./useAppearance.js";

const KEPT: AppearanceRecord = {
  theme: "graphite",
  scheme: "dark",
  textSize: 18,
  transcriptWidth: 44,
  grounds: { light: "#f6f5f2", dark: "#17181a" },
};

const frameWindows = new FrameWindows();

/** happy-dom's answer to `prefers-color-scheme`, which a case sets as the platform's scheme. */
const platformDevice = (
  window as unknown as { happyDOM: { settings: { device: { prefersColorScheme: string } } } }
).happyDOM.settings.device;

afterEach(() => {
  frameWindows.removeAll();
  platformDevice.prefersColorScheme = "light";
});

/** The platform's scheme turned to `scheme`; happy-dom reads its media queries again on resize. */
function turnPlatformScheme(scheme: "light" | "dark"): void {
  act(() => {
    platformDevice.prefersColorScheme = scheme;
    window.dispatchEvent(new Event("resize"));
  });
}

/** Main's `window` members, delivering only what the case sends, and the window's appearance. */
function renderAppearance(setAppearance: AppearanceMembers["setAppearance"]) {
  const handlers = new Set<(record: AppearanceRecord) => void>();
  const members: AppearanceMembers = {
    setAppearance,
    subscribeAppearance: (handler) => {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
  };
  const frameStore = new WindowStore();
  const bridge = { window: members } as unknown as PlatformBridge;
  const openWindows = new OpenWindows({
    openWindow: frameWindows.open,
    consoleDocument: document,
    frames: new OpenWindowFrames(),
  });
  const first = openWindows.open("window/first").window.document.documentElement;
  const { result } = renderHook(() => useAppearance(bridge, openWindows));
  const deliver = (record: AppearanceRecord): void => {
    act(() => {
      for (const handler of handlers) {
        handler(record);
      }
    });
  };
  const openLater = (): HTMLElement =>
    openWindows.open("window/later").window.document.documentElement;
  return { result, frameStore, deliver, first, openLater };
}

describe("the app's appearance", () => {
  it("shows main's record on every window's root and asks for the next scheme over the rest of it", async () => {
    const setAppearance = vi.fn(async () => undefined);
    const { result, deliver, first, openLater } = renderAppearance(setAppearance);

    // Pressed before main's first record arrived: the act waits for it rather than guessing.
    act(() => {
      void result.current.chooseNextScheme();
    });
    expect(setAppearance).not.toHaveBeenCalled();

    deliver(KEPT);
    const later = openLater();
    for (const root of [first, later]) {
      expect(root.getAttribute(SCHEME_ATTRIBUTE)).toBe("dark");
      expect(root.getAttribute(THEME_ATTRIBUTE)).toBe("graphite");
      expect(root.style.fontSize).toBe("18px");
    }
    // The console document is never shown, so nothing is applied to it.
    expect(document.documentElement.hasAttribute(THEME_ATTRIBUTE)).toBe(false);
    const root = first;
    await vi.waitFor(() => {
      expect(setAppearance).toHaveBeenCalledWith(
        { theme: "graphite", scheme: "light", textSize: 18, transcriptWidth: 44 },
        KEPT.grounds,
      );
    });
    // Asking changed nothing on screen; main's kept record does.
    expect(root.getAttribute(SCHEME_ATTRIBUTE)).toBe("dark");

    deliver({ ...KEPT, scheme: "system" });
    expect(root.hasAttribute(SCHEME_ATTRIBUTE)).toBe(false);
    expect(later.hasAttribute(SCHEME_ATTRIBUTE)).toBe(false);
  });

  it("keeps the root's resolved scheme on the platform's under system, and on the record's otherwise", () => {
    const { deliver, first, openLater } = renderAppearance(async () => undefined);

    deliver({ ...KEPT, scheme: "system" });
    expect(first.getAttribute(RESOLVED_SCHEME_ATTRIBUTE)).toBe("light");

    // Main sends no record when only the platform's scheme changes.
    turnPlatformScheme("dark");
    const later = openLater();
    for (const root of [first, later]) {
      expect(root.getAttribute(RESOLVED_SCHEME_ATTRIBUTE)).toBe("dark");
      expect(root.hasAttribute(SCHEME_ATTRIBUTE)).toBe(false);
    }

    deliver({ ...KEPT, scheme: "light" });
    expect(first.getAttribute(RESOLVED_SCHEME_ATTRIBUTE)).toBe("light");
  });

  it("leaves the root as main kept it and says so on the banner when main refuses", async () => {
    const { result, frameStore, deliver, first } = renderAppearance(async () => {
      throw new Error("no space left on device");
    });
    deliver(KEPT);

    act(() => {
      discloseUnkeptScheme(result.current.chooseScheme("light"), frameStore);
    });

    await vi.waitFor(() => {
      expect(frameStore.getState().banners).toMatchObject([
        {
          code: "scheme-not-kept",
          detail: "Could not save the color scheme, so it did not change.",
        },
      ]);
    });
    expect(first.getAttribute(SCHEME_ATTRIBUTE)).toBe("dark");
  });
});
