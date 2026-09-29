// The screenshot tier for the agents family: the console pane.
//
// `settled-capture.ts` owns the mechanism this file rides: every capture is written
// into the gitignored `__screenshots__/` and compared against nothing, so this file
// gates on whether the surface can be captured at all.
//
// WHAT IS PINNED, AND WHY IT IS A PICTURE RATHER THAN AN ASSERTION. The console pane
// draws a served roster as cards under one tool-grant line, and how those read together is
// a layout claim: a DOM assertion reading nodes cannot see it; an image can.
//
// The pane carries this family's palette — cards, chips, refusals, rules — and is worth
// pinning in both schemes.

import { afterEach, beforeEach, describe, it } from "vitest";

import { emulateSystemScheme } from "../helpers/app-harness.js";
import { mountAgentsPane } from "./agent-mounts.js";
import { captureSettled } from "./settled-capture.js";

import { installMeridianTokens } from "@renderer/app/token-installation.js";
import { type ConsoleScheme } from "@renderer/styles/tokens.js";
import { CONSOLE_SCHEMES } from "@renderer/styles/tokens.js";

/** The captures this file writes: the pane, once per scheme. */
const PINNED_CAPTURES: readonly {
  readonly captureName: string;
  readonly scheme: ConsoleScheme;
  readonly mount: () => Promise<HTMLElement>;
}[] = CONSOLE_SCHEMES.map((scheme) => ({
  captureName: `agents-console-pane-${scheme}`,
  scheme,
  mount: mountAgentsPane,
}));

beforeEach(() => {
  document.location.hash = "";
  installMeridianTokens(document);
});

afterEach(async () => {
  // Leave the emulation off, so a later file's baseline is not captured under whichever
  // scheme this one finished in.
  await emulateSystemScheme("light");
});

describe("screenshot — the agents family's surfaces", () => {
  for (const capture of PINNED_CAPTURES) {
    it(`renders ${capture.captureName}`, async () => {
      // Through the system preference rather than a stamped attribute: the token
      // sheet's dark layer is a `prefers-color-scheme` block, and driving it is what a
      // default install actually resolves.
      await emulateSystemScheme(capture.scheme);
      const element = await capture.mount();

      await captureSettled(element, capture.captureName);
    });
  }
});
