// The screenshot tier: the preview pane: the pane chrome around an empty body, per scheme.
//
// `settled-capture.ts` owns the mechanism: every capture is written into the gitignored
// `__screenshots__/` and compared against nothing, so this file gates on whether the
// surface can be captured at all.

import { afterEach, beforeEach, describe, it } from "vitest";

import { emulateSystemScheme } from "../helpers/app-harness.js";
import { mountPreviewPane } from "../helpers/feature-mounts/preview.js";
import { captureSettled } from "./settled-capture.js";

import { installMeridianTokens } from "@renderer/app/token-installation.js";
import { COLOR_SCHEMES } from "@renderer/styles/tokens.js";

beforeEach(() => {
  document.location.hash = "";
  installMeridianTokens(document);
});

afterEach(async () => {
  // Leave the emulation off, so a later file is not captured under this one's scheme.
  await emulateSystemScheme("light");
});

describe("screenshot — the preview pane", () => {
  for (const scheme of COLOR_SCHEMES) {
    it(`renders preview-pane-chrome in the ${scheme} scheme`, async () => {
      // Through the system preference rather than a stamped attribute: the token sheet's
      // dark layer is a `prefers-color-scheme` block, which is what a default install
      // resolves.
      await emulateSystemScheme(scheme);
      const mounted = await mountPreviewPane();

      await captureSettled(mounted.element, `preview-pane-chrome-${scheme}`);
    });
  }
});
