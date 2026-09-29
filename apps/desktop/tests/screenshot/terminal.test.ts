// The screenshot tier: the terminal pane over the terminal-lease scenario, which ends with the shell held, per scheme.
//
// `settled-capture.ts` owns the mechanism: every capture is written into the gitignored
// `__screenshots__/` and compared against nothing, so this file gates on whether the
// surface can be captured at all.

import { afterEach, beforeEach, describe, it } from "vitest";

import { emulateSystemScheme } from "../helpers/app-harness.js";
import { mountTerminalPane } from "../helpers/feature-mounts/terminal.js";
import { captureSettled } from "./settled-capture.js";

import { installMeridianTokens } from "@renderer/console/frame/index.js";
import { CONSOLE_SCHEMES } from "@renderer/styles/tokens.js";

beforeEach(() => {
  document.location.hash = "";
  installMeridianTokens(document);
});

afterEach(async () => {
  // Leave the emulation off, so a later file is not captured under this one's scheme.
  await emulateSystemScheme("light");
});

describe("screenshot — the terminal pane", () => {
  for (const scheme of CONSOLE_SCHEMES) {
    it(`renders terminal-pane-held-lease in the ${scheme} scheme`, async () => {
      // Through the system preference rather than a stamped attribute: the token sheet's
      // dark layer is a `prefers-color-scheme` block, which is what a default install
      // resolves.
      await emulateSystemScheme(scheme);
      const mounted = await mountTerminalPane();

      await captureSettled(mounted.element, `terminal-pane-held-lease-${scheme}`);
    });
  }
});
