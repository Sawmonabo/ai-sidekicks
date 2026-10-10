// What the console document tells main about window sizes, through the bridge main answers: each
// pane kind's opening width before the first window opens, and the window's floor once it is
// drawn, both sent again at a new text size, since every figure is root-relative.

import { act, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { createFixtureComposition } from "#renderer/app/fixture/composition.js";
import { paneWindowWidthsPx } from "#renderer/features/sessions/index.js";
import type { BridgeComposition } from "#renderer/services/platform/bridge-context.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import { DEFAULT_APPEARANCE_RECORD, TEXT_SIZES } from "#shared/appearance.js";
import type { WindowDefaultSizes, WindowSize } from "#shared/window/size.js";
import { FIRST_RUN_SCENARIO_ID } from "#fixtures/scenarios/first-run.js";
import { renderAppSettled } from "../helpers/app/harness.js";
import { FrameWindows } from "../helpers/frame-windows.js";
import { crossMacrotaskBoundary } from "../helpers/macrotask-boundary.js";

const LARGEST_TEXT_SIZE = TEXT_SIZES.reduce((largest, size) => (size > largest ? size : largest));

/** One size request main was sent, and how many windows were open when it was. */
type SizeRequest =
  | { readonly kind: "default-sizes"; readonly sizes: WindowDefaultSizes; readonly open: number }
  | { readonly kind: "minimum-size"; readonly floor: WindowSize; readonly open: number };

/** The scenario's composition, with main's two size calls recorded rather than dropped. */
function recordingSizes(frames: FrameWindows): {
  readonly composition: BridgeComposition;
  readonly requests: SizeRequest[];
  readonly bridge: () => PlatformBridge;
} {
  const fixture = createFixtureComposition(FIRST_RUN_SCENARIO_ID);
  const requests: SizeRequest[] = [];
  let built: PlatformBridge | undefined;
  return {
    requests,
    composition: {
      ...fixture,
      createBridge: () => {
        const composed = fixture.createBridge();
        const windowBridge: PlatformBridge["window"] = {
          ...composed.bridge.window,
          setDefaultSizes: async (sizes) => {
            requests.push({ kind: "default-sizes", sizes, open: frames.openedIds().length });
          },
          setMinimumSize: async (_windowId, floor) => {
            requests.push({ kind: "minimum-size", floor, open: frames.openedIds().length });
          },
        };
        built = { ...composed.bridge, window: windowBridge };
        return { ...composed, bridge: built };
      },
    },
    bridge: () => {
      if (built === undefined) {
        throw new Error("the app built no bridge");
      }
      return built;
    },
  };
}

describe("browser — the sizes main is told", () => {
  it("sends pane widths before any window opens, and both sizes at a new text size", async () => {
    const frames = new FrameWindows();
    const recorded = recordingSizes(frames);
    await renderAppSettled(FIRST_RUN_SCENARIO_ID, frames, recorded.composition);
    await waitFor(() => {
      expect(recorded.requests.some((request) => request.kind === "minimum-size")).toBe(true);
    });
    const [firstRequest] = recorded.requests;
    expect(firstRequest).toStrictEqual({
      kind: "default-sizes",
      sizes: { paneWidths: paneWindowWidthsPx(DEFAULT_APPEARANCE_RECORD.textSize) },
      open: 0,
    });
    const floorAtDefault = recorded.requests.findLast(
      (request) => request.kind === "minimum-size",
    )?.floor;
    const sentBefore = recorded.requests.length;

    await act(async () => {
      const { grounds, ...choice } = DEFAULT_APPEARANCE_RECORD;
      const larger = { ...choice, textSize: LARGEST_TEXT_SIZE };
      await recorded.bridge().window.setAppearance(larger, grounds);
      await crossMacrotaskBoundary();
    });

    await waitFor(() => {
      const sentAfter = recorded.requests.slice(sentBefore);
      expect(sentAfter.find((request) => request.kind === "default-sizes")).toStrictEqual({
        kind: "default-sizes",
        sizes: { paneWidths: paneWindowWidthsPx(LARGEST_TEXT_SIZE) },
        open: 1,
      });
      const floorAfter = sentAfter.findLast((request) => request.kind === "minimum-size")?.floor;
      expect(floorAfter?.width).toBeGreaterThan(floorAtDefault?.width ?? Number.POSITIVE_INFINITY);
    });
  });
});
