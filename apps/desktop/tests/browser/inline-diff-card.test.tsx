// The transcript's diff card drawn in Chromium, inside a scrolling flow of a known height. Each
// file's rows sit in the flow itself: nothing in the card scrolls either way, a long token wraps,
// the rows stop at a third of the flow with a fade at the cut, and the footer counts the lines
// drawn beside `Show all` and `Copy patch`. `Show all` draws every row and leaves the footer.

import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { installMeridianTokens } from "#renderer/app/token-installation.js";
import { InlineDiffCard } from "#renderer/features/repos/diff/components/InlineDiffCard.js";
import { parseUnifiedPatch } from "#renderer/features/repos/diff/patch-parse.js";
import type { DiffModel } from "#renderer/features/repos/diff/model.js";
import { DIFF_ROW_HEIGHT_PX } from "#renderer/features/repos/diff/measures.js";
import { liveBridgeWrapper } from "#test/helpers/app/frame-fixtures.js";

/** The flow's visible height, in CSS pixels, standing in for the transcript's scroller. */
const FLOW_HEIGHT_PX = 600;

/** The changed lines of the one file. */
const LINE_COUNT = 40;

/** The line carrying the long token, below the cut. */
const LONG_TOKEN_LINE = 30;

afterEach(() => {
  cleanup();
});

describe("browser — the transcript's diff card", () => {
  it("draws a third of the flow in the flow, faded at the cut, under the footer", () => {
    installMeridianTokens(document);
    const BridgeHost = liveBridgeWrapper();
    const { container } = render(
      <BridgeHost>
        <div style={{ blockSize: FLOW_HEIGHT_PX, inlineSize: 420, overflowY: "auto" }}>
          <InlineDiffCard
            card={{
              kind: "diff",
              runId: "run-1",
              diffArtifactId: "diff-artifact-1",
              artifactManifestId: "artifact-manifest-1",
            }}
            diff={longDiff()}
          />
        </div>
      </BridgeHost>,
    );
    const card = container.querySelector<HTMLElement>(".meridian-diff-card");
    const rowsBox = container.querySelector<HTMLElement>(".meridian-diff-block__rows");
    const footer = container.querySelector<HTMLElement>(".meridian-diff-block__footer");
    if (card === null || rowsBox === null || footer === null) {
      throw new Error("the card drew no block, rows or footer");
    }

    // A file header, a hunk header, then lines: as many rows as a third of the flow holds.
    const fittingRows = Math.floor(FLOW_HEIGHT_PX / 3 / DIFF_ROW_HEIGHT_PX);
    expect(rowsBox.querySelectorAll('[role="row"]')).toHaveLength(fittingRows);
    expect(rowsBox.getBoundingClientRect().height).toBe(fittingRows * DIFF_ROW_HEIGHT_PX);
    expect(footer.textContent).toBe(
      `${String(fittingRows - 2)} of ${String(LINE_COUNT)} lines·Show all·Copy patch`,
    );
    expect(getComputedStyle(rowsBox, "::after").backgroundImage).toContain("linear-gradient");

    // Nothing in the card scrolls up and down or sideways: the flow is the one scroller.
    for (const element of [card, ...card.querySelectorAll<HTMLElement>("*")]) {
      const { overflowX, overflowY } = getComputedStyle(element);
      expect(["auto", "scroll"], element.className).not.toContain(overflowY);
      expect(["auto", "scroll"], element.className).not.toContain(overflowX);
    }
    fireEvent.click(footer.querySelector("button") as HTMLButtonElement);
    expect(rowsBox.querySelectorAll('[role="row"]')).toHaveLength(LINE_COUNT + 2);
    expect(footer.textContent).toBe(
      `${String(LINE_COUNT)} of ${String(LINE_COUNT)} lines·Copy patch`,
    );
    expect(rowsBox.classList).not.toContain("meridian-diff-block__rows--cut");

    // The unbreakable token wraps inside its row rather than running past the row's edge.
    const longCode = [...rowsBox.querySelectorAll<HTMLElement>(".meridian-diff__code")].find(
      (code) => (code.textContent ?? "").includes("x".repeat(200)),
    );
    if (longCode === undefined) {
      throw new Error("the card drew no row for the long token");
    }
    expect(longCode.scrollWidth).toBeLessThanOrEqual(longCode.clientWidth);
    expect(longCode.getBoundingClientRect().height).toBeGreaterThan(DIFF_ROW_HEIGHT_PX);
  });
});

/** One file of changed lines, one past the cut carrying a token no word break can split. */
function longDiff(): DiffModel {
  const body: string[] = [];
  for (let ordinal = 0; ordinal < LINE_COUNT; ordinal += 1) {
    body.push(
      ordinal === LONG_TOKEN_LINE
        ? `+const token = "${"x".repeat(400)}";`
        : `+const value${String(ordinal)} = compute(${String(ordinal)});`,
    );
  }
  const patch = [
    "--- module.ts",
    "+++ module.ts",
    `@@ -0,0 +1,${String(LINE_COUNT)} @@`,
    ...body,
    "",
  ].join("\n");
  const parsed = parseUnifiedPatch(patch, { baseRef: "main", headRef: "feature" });
  return { ...parsed, files: parsed.files.map((file) => ({ ...file, patch })) };
}
