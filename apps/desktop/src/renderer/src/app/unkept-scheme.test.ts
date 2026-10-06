// A scheme picked from the View menu that main could not save is told on the banner of the window
// used last, in words the person can act on, and only while the app hears main's reports.

import { describe, expect, it } from "vitest";

import { WindowStore } from "#renderer/store/window/store.js";
import { discloseUnkeptMenuSchemes } from "./unkept-scheme.js";

describe("a View-menu scheme main could not keep", () => {
  it("raises the banner on the window used last, and on nothing once the app stops hearing", () => {
    const reports = new Set<() => void>();
    const report = (): void => {
      for (const handler of reports) {
        handler();
      }
    };
    const usedLast = new WindowStore();
    const other = new WindowStore();

    const stopHearing = discloseUnkeptMenuSchemes(
      {
        subscribeToUnkeptScheme: (handler) => {
          reports.add(handler);
          return () => {
            reports.delete(handler);
          };
        },
      },
      () => usedLast,
    );
    report();

    expect(usedLast.getState().banners).toMatchObject([
      { code: "scheme-not-kept", detail: "Could not save the color scheme, so it did not change." },
    ]);
    expect(other.getState().banners).toEqual([]);

    // A repeat replaces the banner, so it is dismissed first to see whether another is raised.
    usedLast.dismissBanner(usedLast.getState().banners[0]?.id ?? "");
    stopHearing();
    report();
    expect(usedLast.getState().banners).toEqual([]);
  });
});
