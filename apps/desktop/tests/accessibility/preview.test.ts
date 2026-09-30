// The accessibility tier over the preview pane's chrome, scoped to the pane so a violation
// names it.
//
// Both schemes: contrast is the rule most likely to pass in one and fail in the other.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { emulateSystemScheme } from "../helpers/app-harness.js";
import { mountPreviewPane } from "../helpers/feature-mounts/preview.js";
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

describe("accessibility — the preview pane", () => {
  for (const scheme of COLOR_SCHEMES) {
    it(`has no axe violation on the preview pane's chrome in the ${scheme} scheme`, async () => {
      await emulateSystemScheme(scheme);
      const mounted = await mountPreviewPane();

      expect(describeViolations(await runTierAxe(mounted.element))).toStrictEqual([]);
    });
  }
});
