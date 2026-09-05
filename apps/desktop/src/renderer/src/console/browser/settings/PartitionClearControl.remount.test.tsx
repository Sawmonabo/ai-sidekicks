// What a clear survives when the row it is drawn in does not.
//
// Its own file rather than a block in `PartitionClearControl.test.tsx`, at the seam
// the module itself has: that suite asserts what the control RENDERS and what its act
// runs, and this one asserts what is still true after the table's fold has destroyed
// and rebuilt the row underneath a running act. The fixtures both need are next door.

import { render, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PartitionClearRounds } from "./partition-clear-rounds.js";
import { PartitionClearControl, type PartitionClearControlProps } from "./PartitionClearControl.js";
import {
  armButton,
  controlIn,
  pendingAct,
  PROJECTED_FAILURE,
  servingAct,
  SESSION_ID,
} from "./PartitionClearControl.test-support.js";

// The row this control is drawn in is not the act's identity.
//
// The table folds past a threshold, so a listing that refreshes while a clear is
// running can move that partition's row from the shown list to the folded one — a
// different parent element, which React reconciles as an unmount and a mount despite
// the `key`. Every case below drives that remount against the page's own record, which
// is what the row cannot take with it.

describe("PartitionClearControl remounted mid-clear", () => {
  /**
   * Mount, and hand back the remount a row crossing the fold performs.
   *
   * The crossing is driven by changing the element's KEY rather than by unmounting
   * and rendering again, because that is what the table actually does to it: the row
   * keeps its `key={partition.sessionId}` and changes parent, and React's answer to a
   * changed identity in a position is to destroy the instance and build a new one.
   * Every hook state the control held is therefore gone, which is the whole case.
   */
  function mountWithRemount(
    rounds: PartitionClearRounds,
    overrides: Partial<PartitionClearControlProps>,
  ): { readonly control: () => HTMLElement; readonly remount: () => void } {
    const inList = (listName: string): React.JSX.Element => (
      <PartitionClearControl
        key={listName}
        rounds={rounds}
        sessionId={SESSION_ID}
        hasOpenPane={false}
        lastClearRefusal={undefined}
        onClosePane={undefined}
        onClearSiteData={undefined}
        {...overrides}
      />
    );
    const view = render(inList("shown"));
    controlIn(view.container);
    let listName = "shown";
    return {
      control: () => controlIn(view.container),
      remount: () => {
        listName = listName === "shown" ? "folded" : "shown";
        view.rerender(inList(listName));
      },
    };
  }

  it("keeps the confirm disabled and the region busy across the remount", async () => {
    const rounds = new PartitionClearRounds();
    const clear = pendingAct();
    const mounted = mountWithRemount(rounds, { onClearSiteData: () => clear.promise });

    armButton(mounted.control()).click();
    await waitFor(() => {
      expect(armButton(mounted.control())).toHaveProperty("disabled", true);
    });

    mounted.remount();

    const remounted = mounted.control();
    expect(armButton(remounted)).toHaveProperty("disabled", true);
    expect(remounted.getAttribute("aria-busy")).toBe("true");
    expect(remounted.textContent).toContain("Clearing");

    clear.succeed();
    await waitFor(() => {
      expect(mounted.control().textContent).toContain("Cleared");
    });
  });

  it("starts no second clear underneath the first, and shows the first act's verdict", async () => {
    const clearCalls: string[] = [];
    const rounds = new PartitionClearRounds();
    const clear = pendingAct();
    const mounted = mountWithRemount(rounds, {
      onClearSiteData: (sessionId) => {
        clearCalls.push(sessionId);
        return clear.promise;
      },
    });

    armButton(mounted.control()).click();
    await waitFor(() => {
      expect(clearCalls).toStrictEqual([SESSION_ID]);
    });

    mounted.remount();
    // The button is disabled, so this is the press a keyboard or a script can still
    // make. The register refuses it, which is what a remounted control cannot see.
    armButton(mounted.control()).click();
    expect(clearCalls).toStrictEqual([SESSION_ID]);

    clear.succeed();
    await waitFor(() => {
      expect(mounted.control().textContent).toContain("Cleared");
    });
  });

  it("holds the projected refusal back across the remount too", async () => {
    // The stale projection reappearing under an act that may be succeeding is the
    // same defect wearing its other face.
    const rounds = new PartitionClearRounds();
    const clear = pendingAct();
    const mounted = mountWithRemount(rounds, {
      lastClearRefusal: PROJECTED_FAILURE,
      onClearSiteData: () => clear.promise,
    });

    armButton(mounted.control()).click();
    await waitFor(() => {
      expect(mounted.control().textContent).toContain("Clearing");
    });

    mounted.remount();

    expect(mounted.control().textContent).not.toContain("browser.partition_stale");
    clear.succeed();
    await waitFor(() => {
      expect(mounted.control().textContent).toContain("Cleared");
    });
  });

  it("negative control: a remount with no clear running comes up idle and offering", () => {
    // Without this, a control that reported every partition busy forever would satisfy
    // the three cases above and would never let anybody clear anything twice.
    const rounds = new PartitionClearRounds();
    const mounted = mountWithRemount(rounds, { onClearSiteData: servingAct([], "clear") });

    mounted.remount();

    const remounted = mounted.control();
    expect(armButton(remounted)).toHaveProperty("disabled", false);
    expect(remounted.getAttribute("aria-busy")).toBe("false");
    expect(remounted.textContent).not.toContain("Clearing");
  });

  it("negative control: a page whose record is fresh knows nothing of the old round", async () => {
    // The record is per mounted PAGE, so a page that is itself remounted starts idle
    // — which is the honest reading, and the one that keeps the register bounded.
    const clear = pendingAct();
    const firstPage = new PartitionClearRounds();
    const mounted = mountWithRemount(firstPage, { onClearSiteData: () => clear.promise });
    armButton(mounted.control()).click();
    await waitFor(() => {
      expect(armButton(mounted.control())).toHaveProperty("disabled", true);
    });

    const secondPage = new PartitionClearRounds();
    const other = mountWithRemount(secondPage, { onClearSiteData: servingAct([], "clear") });

    expect(armButton(other.control())).toHaveProperty("disabled", false);
    clear.succeed();
  });
});
