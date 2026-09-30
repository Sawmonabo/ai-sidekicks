// The screenshot tier: the repos feature's two views, per scheme. `settled-capture.ts` owns the
// mechanism: every capture is written into the gitignored `__screenshots__/` and compared against
// nothing, so this file gates on whether each view can be captured at all.
//
// The two are different compositions, not states of one. The repos section with its degraded
// mounts: three mounts, two answering the failing health verdicts `unreachable` and
// `identity_mismatch`; a bad mount must read as bad at a glance and still offer what it can,
// which for the second verdict is the re-attach that recovers it. That is a claim about what is
// drawn, which an image holds. The diff pane over a parsed change set: the compared states in the
// header, the changed-file list and the rows with gutter marks, and the one place the intraline
// highlight is visible as a highlight.

import { afterEach, beforeEach, describe, it } from "vitest";

import { emulateSystemScheme } from "../helpers/app-harness.js";
import { mountDiffPane, mountRepoSection } from "../helpers/feature-mounts/repos.js";
import { type MountedView } from "../helpers/feature-mounts/mount-queries.js";
import { captureSettled } from "./settled-capture.js";

import { installMeridianTokens } from "@renderer/app/token-installation.js";
import { COLOR_SCHEMES } from "@renderer/styles/tokens.js";

/**
 * The views this tier pins, each with its capture name. A table because the cases differ only in
 * the mounted view, and a copy per view is one more place to forget the scheme emulation.
 */
const PINNED_VIEWS: readonly {
  readonly captureName: string;
  readonly mount: () => Promise<MountedView>;
}[] = [
  { captureName: "repos-section-degraded-mount", mount: mountRepoSection },
  { captureName: "repos-diff-pane", mount: mountDiffPane },
];

beforeEach(() => {
  document.location.hash = "";
  installMeridianTokens(document);
});

afterEach(async () => {
  // Leave the emulation off so a later file's capture is not taken under this file's last scheme.
  await emulateSystemScheme("light");
});

describe("screenshot — the repos section and diff pane", () => {
  for (const view of PINNED_VIEWS) {
    for (const scheme of COLOR_SCHEMES) {
      it(`renders ${view.captureName} in the ${scheme} scheme`, async () => {
        // Through the system preference, not a stamped attribute: the token sheet's dark layer is
        // a `prefers-color-scheme` block, which is what a default install resolves.
        await emulateSystemScheme(scheme);
        const mounted = await view.mount();

        await captureSettled(mounted.element, `${view.captureName}-${scheme}`);
      });
    }
  }
});
