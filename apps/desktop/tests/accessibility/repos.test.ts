// The accessibility tier over the repos feature's views, each scoped to itself so a
// violation names the view that owns it, in every theme by both schemes: contrast is the rule
// most likely to pass in one rendering and fail in another. The palette tests cannot reach a
// mount card tinted by its health verdict, a diff row whose intraline highlight is a tint inside
// text, or a flow diff's sign on its row's translucent wash.
//
// The diff pane's rows are a virtualized grid (the scroller carries the row count, each drawn
// row its index), so what a screen reader announces for a large change set is checked here. It
// is mounted over a parsed model so axe walks real rows, not an empty state.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { emulateSystemScheme } from "../helpers/media-emulation.js";
import {
  mountDiffPane,
  mountInlineDiffCard,
  mountMountList,
  mountWorkflowRunReview,
} from "./feature-mounts/repos/views.js";
import { type MountedView } from "./feature-mounts/queries.js";
import { describeViolations, runTierAxe } from "./axe-run.js";

import { applyAppearance, installMeridianTokens } from "#renderer/app/token-installation.js";
import { COLOR_SCHEMES, TEXT_CONTRAST_FLOOR } from "#renderer/styles/tokens.js";
import { contrastRatio, type SrgbColor } from "#shared/color.js";
import { DEFAULT_APPEARANCE_RECORD } from "#shared/appearance.js";
import { APPEARANCE_THEMES } from "#shared/theme/registry.js";

/** The views this feature ships, each named as a reader would name it. */
const AUDITED_VIEWS: readonly {
  readonly label: string;
  readonly mount: () => Promise<MountedView>;
}[] = [
  { label: "the mount list with a degraded mount", mount: mountMountList },
  { label: "the diff pane over a parsed change set", mount: mountDiffPane },
  { label: "the transcript's inline diff over a parsed change set", mount: mountInlineDiffCard },
  { label: "Review over a workflow run's changes", mount: mountWorkflowRunReview },
];

beforeEach(() => {
  document.location.hash = "";
  installMeridianTokens(document);
});

afterEach(async () => {
  applyAppearance(document, DEFAULT_APPEARANCE_RECORD);
  await emulateSystemScheme("light");
});

describe("accessibility — the mount list and diff pane", () => {
  for (const view of AUDITED_VIEWS) {
    for (const theme of APPEARANCE_THEMES) {
      for (const scheme of COLOR_SCHEMES) {
        it(`has no axe violation on ${view.label} in ${theme} ${scheme}`, async () => {
          await emulateSystemScheme(scheme);
          // Stamped as main stamps the root for a person who chose this theme and scheme.
          applyAppearance(document, { ...DEFAULT_APPEARANCE_RECORD, theme, scheme });
          const mounted = await view.mount();

          expect(describeViolations(await runTierAxe(mounted.element))).toStrictEqual([]);
        });
      }
    }
  }
});

// Axe passes the flow's `+` and `−` by: each is hidden from assistive technology and sits on a
// translucent wash. Each sign is measured against its row's wash as Chromium composites it over the
// block's ground.
describe("accessibility — the flow diff's signs on their washes", () => {
  for (const theme of APPEARANCE_THEMES) {
    for (const scheme of COLOR_SCHEMES) {
      it(`holds every sign to 4.5:1 on its row's wash in ${theme} ${scheme}`, async () => {
        await emulateSystemScheme(scheme);
        applyAppearance(document, { ...DEFAULT_APPEARANCE_RECORD, theme, scheme });
        const mounted = await mountInlineDiffCard();
        const signs = [...mounted.element.querySelectorAll<HTMLElement>(".meridian-diff__sign")];
        const ratios = new Set(
          signs
            .filter((sign) => (sign.textContent ?? "") !== "")
            .map((sign) => {
              const wash = sign.parentElement as HTMLElement;
              const block = wash.closest<HTMLElement>(".meridian-diff-block") as HTMLElement;
              const ratio = contrastRatio(
                paintedColor([getComputedStyle(sign).color]),
                paintedColor([
                  getComputedStyle(block).backgroundColor,
                  getComputedStyle(wash).backgroundColor,
                ]),
              );
              return `${sign.textContent ?? ""} ${ratio >= TEXT_CONTRAST_FLOOR ? "reaches" : ratio.toFixed(2)}`;
            }),
        );
        expect([...ratios].sort()).toStrictEqual(["+ reaches", "− reaches"]);
      });
    }
  }
});

/** The color Chromium paints for `layers` laid one over another, read back from a pixel. */
function paintedColor(layers: readonly string[]): SrgbColor {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (context === null) {
    throw new Error("Chromium gave no 2D canvas context to read a painted color from.");
  }
  for (const layer of layers) {
    context.fillStyle = layer;
    context.fillRect(0, 0, 1, 1);
  }
  const [red = 0, green = 0, blue = 0] = context.getImageData(0, 0, 1, 1).data;
  return { red: red / 255, green: green / 255, blue: blue / 255 };
}
