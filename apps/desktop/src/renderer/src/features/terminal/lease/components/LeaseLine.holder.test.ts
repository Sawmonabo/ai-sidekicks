// The holder line in the design's words, and where it draws nothing: another device's hold names
// the device beside `Take the shell`, a running command's names the agent with no take, a free
// shell draws nothing because the first keystroke takes it, and a holder whose name has not been
// read draws nothing either, so the line never speaks for a holder it cannot name.

import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { leaseState, renderLease } from "./LeaseLine.test-support.js";
import { COMMAND_ID, OTHER_DEVICE_ID, RUN_ID, THIS_DEVICE_ID } from "../state.test-support.js";

const HELD_BY_THE_MAC_MINI = leaseState({
  holder: "held-by-another-device",
  holderDeviceId: OTHER_DEVICE_ID,
});

const HELD_BY_A_RUN = leaseState({
  holder: "held-by-run",
  holderDeviceId: THIS_DEVICE_ID,
  holderRunId: RUN_ID,
  holderCommandId: COMMAND_ID,
});

describe("the holder line", () => {
  it("names another device's hold beside `Take the shell`", () => {
    renderLease(HELD_BY_THE_MAC_MINI, "Mac mini");
    expect(screen.getByRole("group", { name: "Terminal lease" }).textContent).toBe(
      "Mac mini holds the shell.Take the shell",
    );
    expect(screen.getByRole("button", { name: "Take the shell" })).toBeTruthy();
  });

  it("names the agent whose running command holds it and offers no take, even on its device", () => {
    // The run's machine is the holding device, and that may be this one; the line still draws
    // the run's hold rather than nothing.
    renderLease(HELD_BY_A_RUN, "Codex");
    expect(screen.getByRole("group", { name: "Terminal lease" }).textContent).toBe(
      "Codex's running command holds the shell.",
    );
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("draws nothing while nobody holds the shell, since the first keystroke takes it", () => {
    const { container } = renderLease(
      leaseState({ holder: "unheld", holderDeviceId: null }),
      "Mac mini",
    );
    expect(container.textContent).toBe("");
  });

  it("draws nothing for a holder whose name has not been read", () => {
    for (const state of [HELD_BY_THE_MAC_MINI, HELD_BY_A_RUN]) {
      const { container, unmount } = renderLease(state, undefined);
      expect(container.textContent).toBe("");
      unmount();
    }
  });
});
