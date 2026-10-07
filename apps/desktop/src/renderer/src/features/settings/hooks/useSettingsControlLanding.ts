// Landing on the control an address names, each time the person arrives on it; the landing
// itself is `../control-landing.ts`.

import { useLayoutEffect } from "react";

import { useClock } from "#renderer/services/platform/hooks/useClock.js";
import { type SettingsPageId } from "#renderer/routing/settings-page-ids.js";
import { SettingsControlLanding } from "../control-landing.js";

/** What a landing is aimed at. */
export interface SettingsControlLandingOptions {
  /** The element the open page's body is drawn in; `null` before it mounts. */
  readonly pageBody: HTMLElement | null;
  readonly pageId: SettingsPageId | undefined;
  /** The declared control the address names, or `undefined` where it names none. */
  readonly controlId: string | undefined;
  /** Moves on every search hit, so a second hit on the control already open lands again. */
  readonly hitOrdinal: number;
}

/**
 * Land on the named control each time the person arrives on it: before the page paints when the
 * control is already drawn, so no frame shows the page's top first.
 */
export function useSettingsControlLanding(options: SettingsControlLandingOptions): void {
  const { pageBody, pageId, controlId, hitOrdinal } = options;
  const clock = useClock();
  useLayoutEffect(() => {
    if (pageBody === null || pageId === undefined || controlId === undefined) {
      return undefined;
    }
    const landing = new SettingsControlLanding(pageBody, controlId, clock);
    landing.start();
    return () => {
      landing.stop();
    };
  }, [pageBody, pageId, controlId, hitOrdinal, clock]);
}
