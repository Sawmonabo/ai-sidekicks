// The window's appearance against main's record, the one copy: the document root shows what main
// kept, a scheme act asks main over the rest of that record (waiting for main's first delivery when
// it runs before one), and a change main refuses leaves the root as it was and says so on the
// window's banner. Main's `window` members are a stand-in whose first delivery the case sends, as
// the preload's arrives after a round trip.

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import type { AppearanceMembers } from "@renderer/services/window/appearance-client.js";
import { WindowStore } from "@renderer/store/window/window-store.js";
import { SCHEME_ATTRIBUTE, THEME_ATTRIBUTE, type AppearanceRecord } from "@shared/appearance.js";
import { useAppearance } from "./useAppearance.js";

const KEPT: AppearanceRecord = {
  theme: "graphite",
  scheme: "dark",
  textSize: 18,
  transcriptWidth: 44,
  grounds: { light: "#f6f5f2", dark: "#17181a" },
};

afterEach(() => {
  const root = document.documentElement;
  root.removeAttribute(SCHEME_ATTRIBUTE);
  root.removeAttribute(THEME_ATTRIBUTE);
  root.removeAttribute("style");
});

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
  const { result } = renderHook(() => useAppearance(bridge, frameStore));
  const deliver = (record: AppearanceRecord): void => {
    act(() => {
      for (const handler of handlers) {
        handler(record);
      }
    });
  };
  return { result, frameStore, deliver };
}

describe("the window's appearance", () => {
  it("shows main's record on the root and asks for the next scheme over the rest of it", async () => {
    const setAppearance = vi.fn(async () => undefined);
    const { result, deliver } = renderAppearance(setAppearance);

    // Pressed before main's first record arrived: the act waits for it rather than guessing.
    act(() => {
      result.current.chooseNextScheme();
    });
    expect(setAppearance).not.toHaveBeenCalled();

    deliver(KEPT);
    const root = document.documentElement;
    expect(root.getAttribute(SCHEME_ATTRIBUTE)).toBe("dark");
    expect(root.getAttribute(THEME_ATTRIBUTE)).toBe("graphite");
    expect(root.style.fontSize).toBe("18px");
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
  });

  it("leaves the root as main kept it and says so on the banner when main refuses", async () => {
    const { result, frameStore, deliver } = renderAppearance(async () => {
      throw new Error("no space left on device");
    });
    deliver(KEPT);

    act(() => {
      result.current.chooseScheme("light");
    });

    await vi.waitFor(() => {
      expect(frameStore.getState().banners).toMatchObject([{ code: "scheme-not-kept" }]);
    });
    expect(document.documentElement.getAttribute(SCHEME_ATTRIBUTE)).toBe("dark");
  });
});
