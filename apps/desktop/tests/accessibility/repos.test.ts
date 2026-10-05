// The accessibility tier over the repos feature's views, each scoped to itself so a
// violation names the view that owns it, in both schemes for `app-frame.test.tsx`'s reason.
// The palette tests cannot reach a mount card tinted by its health verdict or a diff row whose
// intraline highlight is a tint inside text.
//
// The diff pane's rows are a virtualized grid (the scroller carries the row count, each drawn
// row its index), so what a screen reader announces for a large change set is checked here. It
// is mounted over a parsed model so axe walks real rows, not an empty state.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { emulateSystemScheme } from "../helpers/app-harness.js";
import { mountDiffPane, mountMountList, mountWorkflowRunReview } from "./feature-mounts/repos.js";
import { type MountedView } from "./feature-mounts/mount-queries.js";
import { describeViolations, runTierAxe } from "./axe-run.js";

import { installMeridianTokens } from "@renderer/app/token-installation.js";
import { COLOR_SCHEMES } from "@renderer/styles/tokens.js";

/** The views this feature ships, each named as a reader would name it. */
const AUDITED_VIEWS: readonly {
  readonly label: string;
  readonly mount: () => Promise<MountedView>;
}[] = [
  { label: "the mount list with a degraded mount", mount: mountMountList },
  { label: "the diff pane over a parsed change set", mount: mountDiffPane },
  { label: "Review over a workflow run's changes", mount: mountWorkflowRunReview },
];

beforeEach(() => {
  document.location.hash = "";
  installMeridianTokens(document);
});

afterEach(async () => {
  await emulateSystemScheme("light");
});

describe("accessibility — the mount list and diff pane", () => {
  for (const view of AUDITED_VIEWS) {
    for (const scheme of COLOR_SCHEMES) {
      it(`has no axe violation on ${view.label} in the ${scheme} scheme`, async () => {
        await emulateSystemScheme(scheme);
        const mounted = await view.mount();

        expect(describeViolations(await runTierAxe(mounted.element))).toStrictEqual([]);
      });
    }
  }
});
