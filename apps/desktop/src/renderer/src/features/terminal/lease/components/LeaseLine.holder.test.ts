// The holder line's words, and where it draws nothing: another device's hold names the device
// beside `Take the terminal`, a free shell draws nothing because the first keystroke takes it, and a
// device whose name has not been read draws nothing either, so the line never speaks for a holder
// it cannot name. A running command's hold, named by its run's agent, is `LeaseLine.run.test.tsx`.

import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { drawnText } from "#test/helpers/live-region.js";
import { HeldTakes } from "../hooks/useTakeShell.test-support.js";
import {
  THIRD_DEVICE_ID,
  leaseLineWithTake,
  leaseState,
  renderLease,
} from "./LeaseLine.test-support.js";
import { OTHER_DEVICE_ID, THIS_DEVICE_ID } from "../state.test-support.js";

const HELD_BY_THE_MAC_MINI = leaseState({
  holder: "held-by-another-device",
  holderDeviceId: OTHER_DEVICE_ID,
});

describe("the holder line", () => {
  it("names another device's hold beside `Take the terminal`", () => {
    renderLease(HELD_BY_THE_MAC_MINI, "Mac mini");
    expect(screen.getByRole("group", { name: "Terminal lease" }).textContent).toBe(
      "Mac mini holds the terminal.Take the terminal",
    );
    expect(screen.getByRole("button", { name: "Take the terminal" })).toBeTruthy();
  });

  it("draws nothing while nobody holds the shell, since the first keystroke takes it", () => {
    const { container } = renderLease(
      leaseState({ holder: "unheld", holderDeviceId: null }),
      "Mac mini",
    );
    expect(drawnText(container)).toBe("");
  });

  it("draws nothing for a device whose name has not been read", () => {
    const { container } = renderLease(HELD_BY_THE_MAC_MINI, undefined);
    expect(drawnText(container)).toBe("");
  });

  it("says each change of holder after the pane first drew it, and never the question", () => {
    const takes = new HeldTakes();
    const view = renderLease(HELD_BY_THE_MAC_MINI, "Mac mini", takes.bridge);
    // The line the pane opened with stands, a re-read in the same words says nothing, and the
    // confirm's question is the person's own act, read where focus lands.
    view.rerender(leaseLineWithTake(HELD_BY_THE_MAC_MINI, "Mac mini", takes.bridge));
    fireEvent.click(screen.getByRole("button", { name: "Take the terminal" }));
    expect(view.said.spoken()).toStrictEqual([]);

    const heldByTheIpad = leaseState({
      holder: "held-by-another-device",
      holderDeviceId: THIRD_DEVICE_ID,
    });
    view.rerender(leaseLineWithTake(heldByTheIpad, "iPad", takes.bridge));
    // This device holds it a while, and the iPad takes it back: the line comes back and is said.
    view.rerender(
      leaseLineWithTake(
        leaseState({ holder: "held-by-this-device", holderDeviceId: THIS_DEVICE_ID }),
        "Mac",
        takes.bridge,
      ),
    );
    view.rerender(leaseLineWithTake(heldByTheIpad, "iPad", takes.bridge));
    expect(view.said.spokenOn("polite")).toStrictEqual([
      "iPad holds the terminal.",
      "iPad holds the terminal.",
    ]);
  });
});
