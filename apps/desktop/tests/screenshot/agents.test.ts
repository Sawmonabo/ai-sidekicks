// The screenshot tier for the agents console pane. `settled-capture.ts` owns the mechanism: every
// capture is written into the gitignored `__screenshots__/` and compared against nothing, so this
// file gates only on whether the pane can be captured at all. It is a picture rather than an
// assertion because how the cards read together under the tool-allowlist line is a layout claim a
// DOM assertion cannot see. The pane carries the feature's palette, so both schemes are captured.

import { afterEach, beforeEach, describe, it } from "vitest";

import { emulateSystemScheme } from "../helpers/app-harness.js";
import { mountAgentsPane } from "./agent-mounts.js";
import { captureSettled } from "./settled-capture.js";

import { installMeridianTokens } from "@renderer/app/token-installation.js";
import { type ColorScheme } from "@renderer/styles/tokens.js";
import { COLOR_SCHEMES } from "@renderer/styles/tokens.js";

/** The captures this file writes: the pane, once per scheme. */
const PINNED_CAPTURES: readonly {
  readonly captureName: string;
  readonly scheme: ColorScheme;
  readonly mount: () => Promise<HTMLElement>;
}[] = COLOR_SCHEMES.map((scheme) => ({
  captureName: `agents-pane-${scheme}`,
  scheme,
  mount: mountAgentsPane,
}));

beforeEach(() => {
  document.location.hash = "";
  installMeridianTokens(document);
});

afterEach(async () => {
  // Leave the emulation off so a later file's capture is not taken under this file's last scheme.
  await emulateSystemScheme("light");
});

describe("screenshot — the agents pane", () => {
  for (const capture of PINNED_CAPTURES) {
    it(`renders ${capture.captureName}`, async () => {
      // Through the system preference, not a stamped attribute: the token sheet's dark layer is a
      // `prefers-color-scheme` block, which is what a default install resolves.
      await emulateSystemScheme(capture.scheme);
      const element = await capture.mount();

      await captureSettled(element, capture.captureName);
    });
  }
});
