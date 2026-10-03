// Each moment a confirmation reaches, asserted on its own. Both component suites discard only
// through the open arm (a dialog opens before it can be canceled), so they would stay green
// without the cancel arm.

import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useConfirmationLifecycle } from "./useConfirmationLifecycle.js";

describe("useConfirmationLifecycle", () => {
  it("discards the standing settlement when the user cancels", () => {
    const discardSettlement = vi.fn();
    const { result } = renderHook(() => useConfirmationLifecycle(discardSettlement));

    result.current.canceled();

    expect(discardSettlement).toHaveBeenCalledTimes(1);
  });

  it("discards nothing on a close, which is where the confirm press lands", () => {
    // The confirm control is an `AlertDialog.Close`: a discard on this edge would fire after
    // the send published `sending` and take back the settlement the press just produced.
    const discardSettlement = vi.fn();
    const { result } = renderHook(() => useConfirmationLifecycle(discardSettlement));

    result.current.openChanged(false);

    expect(discardSettlement).not.toHaveBeenCalled();
  });
});
