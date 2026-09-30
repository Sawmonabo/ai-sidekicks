// The accessibility tier over the terminal pane, scoped to the pane so a violation names it.
//
// Both schemes: contrast is the rule most likely to pass in one and fail in the other.
//
// The host names the region and lets xterm.js own the live region inside it. The pane is
// audited with the emulator's chunk landed, so axe walks the library's real nodes.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { emulateSystemScheme } from "../helpers/app-harness.js";
import { mountTerminalPane } from "../helpers/feature-mounts/terminal.js";
import { describeViolations, runTierAxe } from "./axe-run.js";

import { installMeridianTokens } from "@renderer/app/token-installation.js";
import { COLOR_SCHEMES } from "@renderer/styles/tokens.js";

beforeEach(() => {
  document.location.hash = "";
  installMeridianTokens(document);
});

afterEach(async () => {
  await emulateSystemScheme("light");
});

describe("accessibility — the terminal pane", () => {
  for (const scheme of COLOR_SCHEMES) {
    it(`has no axe violation on the terminal pane in the ${scheme} scheme`, async () => {
      await emulateSystemScheme(scheme);
      const mounted = await mountTerminalPane();

      expect(describeViolations(await runTierAxe(mounted.element))).toStrictEqual([]);
    });
  }
});
