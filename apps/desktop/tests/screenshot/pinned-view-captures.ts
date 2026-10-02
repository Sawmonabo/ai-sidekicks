// The suite every per-feature capture file registers: each view in each color scheme, written
// through `captureSettled`. Not a test file.

import { afterEach, beforeEach, describe, it } from "vitest";

import { emulateSystemScheme } from "../helpers/app-harness.js";
import { captureSettled } from "./settled-capture.js";

import { installMeridianTokens } from "@renderer/app/token-installation.js";
import { COLOR_SCHEMES } from "@renderer/styles/tokens.js";

/** One view a capture file pins: the name its images are written under, and how it is mounted. */
interface PinnedView {
  readonly captureName: string;
  readonly mount: () => Promise<{ readonly element: Element }>;
}

/**
 * Registers one capture per view per scheme, named `<captureName>-<scheme>`, under `title`.
 * Each case resets the address and the token sheet first and leaves the scheme emulation at
 * light, so a later file is not captured under this one's last scheme.
 */
export function definePinnedViewCaptures(title: string, views: readonly PinnedView[]): void {
  describe(`screenshot — ${title}`, () => {
    beforeEach(() => {
      document.location.hash = "";
      installMeridianTokens(document);
    });

    afterEach(async () => {
      await emulateSystemScheme("light");
    });

    for (const view of views) {
      for (const scheme of COLOR_SCHEMES) {
        it(`renders ${view.captureName} in the ${scheme} scheme`, async () => {
          // Through the system preference, not a stamped attribute: the token sheet's dark layer
          // is a `prefers-color-scheme` block, which is what a default install resolves.
          await emulateSystemScheme(scheme);
          const mounted = await view.mount();

          await captureSettled(mounted.element, `${view.captureName}-${scheme}`);
        });
      }
    }
  });
}
