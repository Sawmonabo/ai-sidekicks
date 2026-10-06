// Whether the page list and the page sit side by side or take the screen one at a time.
//
// The break is the width the two panes' own content needs, measured rather than written down:
// side by side, the list's track is as wide as its longest page name and the page's track no
// narrower than the page's own content, so a window too narrow for both pushes the page past the
// screen's edge, and that overflow is the signal. The width it needed is kept, and one at a time
// the screen tries side by side again when it is at least that wide, or when another page opens
// with a floor of its own; the measurement settles each try before anything paints. Resizes are
// heard, never polled: the screen's width and, side by side, the page pane's width.

import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { observeElementResize } from "#renderer/lib/element-resize.js";

/** How the two panes share the screen. */
export type SettingsPaneArrangement = "side-by-side" | "one-at-a-time";

/** What the arrangement is measured from. */
export interface SettingsPaneArrangementOptions {
  /** The screen's own box, whose width the window sets. */
  readonly screen: HTMLElement | null;
  /** The page pane, the track that overflows when the two do not fit. */
  readonly pagePane: HTMLElement | null;
  /** The open page, or `undefined` on the address that names none. */
  readonly pageKey: string | undefined;
}

/** The arrangement the screen's width and its two panes' content allow. */
export function useSettingsPaneArrangement(
  options: SettingsPaneArrangementOptions,
): SettingsPaneArrangement {
  const { screen, pagePane, pageKey } = options;
  const [arrangement, setArrangement] = useState<SettingsPaneArrangement>("side-by-side");
  const arrangementRef = useRef(arrangement);
  // The width side by side last needed and did not get: a try narrower than it would fail.
  const neededWidthRef = useRef(0);

  // A page has its own floor, so opening one tries side by side again. The address that names
  // no page draws no floor to measure, so it keeps the arrangement the last page settled.
  useLayoutEffect(() => {
    if (pageKey !== undefined) {
      setArrangement("side-by-side");
    }
  }, [pageKey]);

  useLayoutEffect(() => {
    arrangementRef.current = arrangement;
    if (arrangement !== "side-by-side" || screen === null || pagePane === null) {
      return;
    }
    const neededWidth = sideBySideShortfall(screen, pagePane);
    if (neededWidth !== undefined) {
      neededWidthRef.current = neededWidth;
      setArrangement("one-at-a-time");
    }
  }, [arrangement, pageKey, screen, pagePane]);

  useEffect(() => {
    if (screen === null || pagePane === null) {
      return undefined;
    }
    const settleSideBySide = (): void => {
      const neededWidth = sideBySideShortfall(screen, pagePane);
      if (neededWidth !== undefined) {
        neededWidthRef.current = neededWidth;
        setArrangement("one-at-a-time");
      }
    };
    let measuredScreenWidth = screen.clientWidth;
    const stopWatchingScreen = observeElementResize(screen, () => {
      if (screen.clientWidth === measuredScreenWidth) {
        return;
      }
      measuredScreenWidth = screen.clientWidth;
      if (arrangementRef.current === "side-by-side") {
        settleSideBySide();
      } else if (measuredScreenWidth >= neededWidthRef.current) {
        setArrangement("side-by-side");
      }
    });
    const stopWatchingPage = observeElementResize(pagePane, () => {
      if (arrangementRef.current === "side-by-side") {
        settleSideBySide();
      }
    });
    return () => {
      stopWatchingScreen();
      stopWatchingPage();
    };
  }, [screen, pagePane]);

  return arrangement;
}

/**
 * The width side by side needs, when the page pane reaches past the screen's edge to the whole
 * pixel; `undefined` while the two fit.
 */
function sideBySideShortfall(screen: HTMLElement, pagePane: HTMLElement): number | undefined {
  const screenBox = screen.getBoundingClientRect();
  const pageRight = pagePane.getBoundingClientRect().right;
  return Math.round(pageRight) > Math.round(screenBox.right)
    ? Math.ceil(pageRight - screenBox.left)
    : undefined;
}
