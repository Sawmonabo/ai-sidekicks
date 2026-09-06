// The screenshot tier's per-test capture conditions, wired as a Vitest setup file.
//
// A setup file rather than a call in each suite's own `beforeEach`: the tier grows
// one file per family, and a condition a new file has to remember to opt into is a
// condition the next family renders without. `capture-faces.ts` says what is
// pinned and why; this says when.
//
// Registered by `vitest/console-projects.ts` on the screenshot project alone. The
// accessibility and browser tiers mount the same surfaces and compare no pixels,
// so a face pin there would constrain them for no reading they take.

import { beforeEach } from "vitest";

import { pinCaptureFaces } from "./capture-faces.js";

beforeEach(() => {
  // Before the suite's own hooks install the token sheet, and independent of them:
  // the pin is an inline property on the root element and the sheet is a `:root`
  // rule, so the pin wins whichever lands first.
  pinCaptureFaces(document);
});
