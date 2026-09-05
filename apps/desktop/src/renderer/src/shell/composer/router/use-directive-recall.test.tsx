// Directive history, and the boundary it does not cross.
//
// Split along the seam the module was. History is keyed by the address it was typed
// at, so recalling at one target can never surface what was written for another —
// which is a property of the key rather than of the recall, and is what these cases
// hold.

import { act, fireEvent } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  FIRST_AGENT_ID,
  SECOND_AGENT_ID,
  answerSteer,
  mountAddressable,
  stubBridge,
} from "./composer-send-bar.test-support.js";

describe("ComposerSendBar — directive history does not cross an addressing boundary", () => {
  /** Put the caret at the start edge, which is the one place ArrowUp recalls. */
  function pressArrowUpAtStart(line: HTMLTextAreaElement): void {
    line.setSelectionRange(0, 0);
    fireEvent.keyDown(line, { key: "ArrowUp" });
  }

  it("recalls nothing under an address the message was not sent from", async () => {
    // The defect: one history for the life of the mounted bar meant ArrowUp under the
    // second agent copied participant-authored text sent to the first into its line.
    const bar = mountAddressable(stubBridge(answerSteer));
    fireEvent.change(bar.line(), { target: { value: "written for Ada" } });
    await act(async () => {
      fireEvent.keyDown(bar.line(), { key: "Enter" });
    });

    bar.address(SECOND_AGENT_ID);
    fireEvent.change(bar.line(), { target: { value: "  half a thought for Grace" } });
    act(() => {
      pressArrowUpAtStart(bar.line());
    });

    expect(bar.line().value).toBe("  half a thought for Grace");
  });

  it("recalls that address's own message on returning to it", async () => {
    // The negative control for the case above: history is KEYED rather than reset, so
    // coming back finds what was sent from here — a reset would pass the first case
    // and lose the history a person expects to still be there.
    const bar = mountAddressable(stubBridge(answerSteer));
    fireEvent.change(bar.line(), { target: { value: "written for Ada" } });
    await act(async () => {
      fireEvent.keyDown(bar.line(), { key: "Enter" });
    });

    bar.address(SECOND_AGENT_ID);
    bar.address(FIRST_AGENT_ID);
    act(() => {
      pressArrowUpAtStart(bar.line());
    });

    expect(bar.line().value).toBe("written for Ada");
  });
});
