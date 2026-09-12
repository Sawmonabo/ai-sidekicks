// Each of the three moments a confirmation reaches, asked one at a time.
//
// THE TWO CONSUMERS ASSERT THE OBSERVABLE — a settlement standing or gone on the card —
// and both of their discards run through the OPEN arm, because a dialog has to be open
// before it can be cancelled. So the arms are separated here, where each one can be
// called on its own: without this file the cancel arm could be deleted and both
// component suites would stay green.

import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useConfirmationLifecycle } from "./confirmation-lifecycle.js";

describe("useConfirmationLifecycle", () => {
  it("discards the standing settlement when the confirmation opens", () => {
    const discardSettlement = vi.fn();
    const { result } = renderHook(() => useConfirmationLifecycle(discardSettlement));

    result.current.openChanged(true);

    expect(discardSettlement).toHaveBeenCalledTimes(1);
  });

  it("discards the standing settlement when the user cancels", () => {
    const discardSettlement = vi.fn();
    const { result } = renderHook(() => useConfirmationLifecycle(discardSettlement));

    result.current.cancelled();

    expect(discardSettlement).toHaveBeenCalledTimes(1);
  });

  it("negative control: discards nothing on a close, which is where the confirm press lands", () => {
    // The whole point of the module. The confirm control is an `AlertDialog.Close`, so
    // a discard on this edge fires after the send published `sending` and takes back
    // the settlement the press had just produced.
    const discardSettlement = vi.fn();
    const { result } = renderHook(() => useConfirmationLifecycle(discardSettlement));

    result.current.openChanged(false);

    expect(discardSettlement).not.toHaveBeenCalled();
  });

  it("keeps one identity for both handlers while the discard is unchanged", () => {
    // Both handlers reach a dialog as props. A fresh identity per render would remount
    // nothing here, but it is what a memoised popup below them would re-render on.
    const discardSettlement = vi.fn();
    const { result, rerender } = renderHook(() => useConfirmationLifecycle(discardSettlement));
    const first = result.current;

    rerender();

    expect(result.current).toBe(first);
  });
});
