// Which row a failed copy belongs to.
//
// A suite of its own beside `InterventionHistory.test.tsx`, which asserts what the
// list RENDERS. This one drives the one action its rows offer — the path controls a
// restored rollback discloses — and the claim is about keying: the host's refusal is
// the answer to the last press, so it belongs under the row that raised it, moves with
// the next press, and appears under no row before anything was pressed.

import { act, fireEvent } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";

import type { ConsoleBridge } from "../../../bridge/index.js";
import { createFixture } from "../../../bridge/fixture/call-plane/bridge.test-support.js";
import { crossMacrotaskBoundary } from "../../../core/macrotask-boundary.test-support.js";
import { resolveFileRestoreDisclosure } from "../controls/file-restore-mount.test-support.js";
import { renderHistory, restoredRollbackRecord } from "./intervention-history.test-support.js";

// Every case here presses a control the restored-rollback disclosure offers, and that
// body arrives on its own chunk — warmed once through the mount's own wait home, as
// the package's test standard requires, so `renderHistory` stays synchronous and a
// press lands on the row rather than on the reserved region.
beforeAll(async () => {
  await resolveFileRestoreDisclosure();
});

/** The two records the keying cases press, each offering its own path. */
const FIRST_ROW_PATH = "/Users/dev/code/one/first.env";
const SECOND_ROW_PATH = "/Users/dev/code/one/second.env";

/**
 * The shipped fixture with its clipboard refusing, and nothing else replaced.
 *
 * Composed over the real bridge rather than hand-built for the reason `renderHistory`
 * states: the list reaches this seam through the path action, and a stub object would
 * let a change to that seam's shape pass here and fail in the window.
 */
function bridgeRefusingClipboard(): ConsoleBridge {
  const { bridge } = createFixture();
  return {
    ...bridge,
    sidekicks: {
      ...bridge.sidekicks,
      native: {
        ...bridge.sidekicks.native,
        copyToClipboard: async (): Promise<void> => {
          throw new Error("the clipboard is unavailable");
        },
      },
    },
  } as ConsoleBridge;
}

/** Open every enumeration, then press the control offering exactly this path. */
async function copyPathThrough(container: HTMLElement, path: string): Promise<void> {
  for (const detail of container.querySelectorAll("details")) {
    detail.open = true;
    fireEvent(detail, new Event("toggle"));
  }
  const control = container.querySelector<HTMLButtonElement>(`[aria-label="Copy path ${path}"]`);
  if (control === null) {
    throw new Error(`no path control offered ${path}, so there is nothing to press`);
  }
  await act(async () => {
    fireEvent.click(control);
    // A boundary and not a counted microtask: the rejection travels through the
    // normalizer and a state publish, and a chain one link deeper would leave every
    // case below asserting about a refusal that had not landed yet.
    await crossMacrotaskBoundary();
  });
}

/** Which rows are showing an inline refusal, by their position in the list. */
function rowsShowingRefusal(container: HTMLElement): readonly number[] {
  return [...container.querySelectorAll(".meridian-interventions__row")].flatMap((row, position) =>
    row.querySelector(".meridian-refusal--inline") === null ? [] : [position],
  );
}

describe("a copy refusal belongs to the row that raised it", () => {
  it("shows the host's refusal under that row and under no other", async () => {
    // The defect. One history-level refusal was handed to every row, so a single
    // failed copy drew the same failure beneath every rollback's paths — telling a
    // person that actions they never took had failed.
    const container = renderHistory(
      [
        restoredRollbackRecord("one", FIRST_ROW_PATH),
        restoredRollbackRecord("two", SECOND_ROW_PATH),
      ],
      bridgeRefusingClipboard(),
    );
    expect(container.querySelectorAll(".meridian-interventions__row")).toHaveLength(2);

    await copyPathThrough(container, SECOND_ROW_PATH);

    expect(rowsShowingRefusal(container)).toStrictEqual([1]);
  });

  it("moves with the next press rather than accumulating", async () => {
    // The refusal is the answer to the LAST action, so pressing the other row's
    // control moves it. A key that only ever added would leave the first row
    // reporting a failure the daemon has been asked nothing about since.
    const container = renderHistory(
      [
        restoredRollbackRecord("one", FIRST_ROW_PATH),
        restoredRollbackRecord("two", SECOND_ROW_PATH),
      ],
      bridgeRefusingClipboard(),
    );

    await copyPathThrough(container, SECOND_ROW_PATH);
    await copyPathThrough(container, FIRST_ROW_PATH);

    expect(rowsShowingRefusal(container)).toStrictEqual([0]);
  });

  it("negative control: no row shows one before anything was pressed", async () => {
    // Without this the cases above would be satisfied by a component that never
    // rendered a refusal at all, which is a different bug with the same reading.
    const container = renderHistory(
      [
        restoredRollbackRecord("one", FIRST_ROW_PATH),
        restoredRollbackRecord("two", SECOND_ROW_PATH),
      ],
      bridgeRefusingClipboard(),
    );

    expect(rowsShowingRefusal(container)).toStrictEqual([]);

    await copyPathThrough(container, FIRST_ROW_PATH);

    expect(rowsShowingRefusal(container)).toStrictEqual([0]);
  });
});
