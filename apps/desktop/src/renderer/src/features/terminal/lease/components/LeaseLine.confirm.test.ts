// `Take the shell` asks once, in place on the line: `<device> holds the shell. Take it?` under
// `Cancel` and `Take it`, which takes focus, and Escape cancels. Only `Take it` sends, one forced
// take of this shell bound to the pane's output subscription, and the line never derives the
// holder from it: a served take closes the confirm and the line moves only when the change reaches
// the fold. A refused take keeps the confirm open and says why.

import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { settle } from "#test/helpers/settle.js";
import {
  HeldTakes,
  TAKE_TARGET,
  THIRD_DEVICE_ID,
  leaseLineWithTake,
  leaseState,
  renderLease,
} from "./LeaseLine.test-support.js";
import { OTHER_DEVICE_ID } from "../state.test-support.js";

const HELD_BY_THE_MAC_MINI = leaseState({
  holder: "held-by-another-device",
  holderDeviceId: OTHER_DEVICE_ID,
});

const QUESTION = "Mac mini holds the shell. Take it?";

/** Open the confirm on a line held by the Mac mini, over the given takes. */
function openConfirm(takes: HeldTakes): void {
  renderLease(HELD_BY_THE_MAC_MINI, "Mac mini", takes.bridge);
  fireEvent.click(screen.getByRole("button", { name: "Take the shell" }));
}

describe("taking the shell from another device", () => {
  it("asks once in place with `Take it` focused, and sends nothing until it is pressed", () => {
    const takes = new HeldTakes();
    openConfirm(takes);
    const confirm = screen.getByRole("group", { name: QUESTION });
    expect(
      Array.from(confirm.querySelectorAll("button"), (button) => button.textContent),
    ).toStrictEqual(["Cancel", "Take it"]);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Take it" }));
    expect(screen.queryByRole("button", { name: "Take the shell" })).toBeNull();
    expect(takes.takes).toStrictEqual([]);
  });

  it("cancels on Escape, sending nothing and handing focus back to `Take the shell`", () => {
    const takes = new HeldTakes();
    openConfirm(takes);
    fireEvent.keyDown(screen.getByRole("button", { name: "Take it" }), { key: "Escape" });
    expect(screen.queryByRole("group", { name: QUESTION })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Take the shell" }));
    expect(screen.getByRole("group", { name: "Terminal lease" }).textContent).toBe(
      "Mac mini holds the shell.Take the shell",
    );
    expect(takes.takes).toStrictEqual([]);
  });

  it("sends one forced take through the pane's subscription, and waits for the change", async () => {
    const takes = new HeldTakes();
    openConfirm(takes);
    fireEvent.click(screen.getByRole("button", { name: "Take it" }));
    await settle();
    expect(takes.takes).toStrictEqual([
      { method: "session.takeControl", params: { ...TAKE_TARGET, force: true } },
    ]);
    // While it is out the confirm cannot be pressed again or canceled.
    expect(
      Array.from(
        screen.getByRole("group", { name: QUESTION }).querySelectorAll("button"),
        (button) => button.disabled,
      ),
    ).toStrictEqual([true, true]);
    fireEvent.keyDown(screen.getByRole("button", { name: "Take it" }), { key: "Escape" });
    expect(screen.getByRole("group", { name: QUESTION })).toBeTruthy();

    await settle(() => {
      takes.serve(0);
    });
    // Served is not held: the line still names the Mac mini until the change reaches the fold.
    expect(screen.queryByRole("group", { name: QUESTION })).toBeNull();
    expect(screen.getByRole("group", { name: "Terminal lease" }).textContent).toBe(
      "Mac mini holds the shell.Take the shell",
    );
    expect(takes.takes).toHaveLength(1);
  });

  it("keeps the confirm open with the daemon's reason when the take is refused", async () => {
    const takes = new HeldTakes();
    openConfirm(takes);
    fireEvent.click(screen.getByRole("button", { name: "Take it" }));
    await settle();
    await settle(() => {
      takes.refuse(0, "pty.control_held_by_other", "an agent's running command holds this shell");
    });
    expect(screen.getByRole("group", { name: QUESTION })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe(
      "an agent's running command holds this shell",
    );
    expect(screen.getByRole("button", { name: "Take it" }).hasAttribute("disabled")).toBe(false);
  });

  it("closes an open confirm when the holder changes, so it never asks about a device that let go", () => {
    const takes = new HeldTakes();
    const view = renderLease(HELD_BY_THE_MAC_MINI, "Mac mini", takes.bridge);
    fireEvent.click(screen.getByRole("button", { name: "Take the shell" }));
    // The Mac mini lets go and the shell is free; then the iPad takes it.
    view.rerender(
      leaseLineWithTake(
        leaseState({ holder: "unheld", holderDeviceId: null }),
        "Mac mini",
        takes.bridge,
      ),
    );
    view.rerender(
      leaseLineWithTake(
        leaseState({ holder: "held-by-another-device", holderDeviceId: THIRD_DEVICE_ID }),
        "iPad",
        takes.bridge,
      ),
    );
    expect(screen.getByRole("group", { name: "Terminal lease" }).textContent).toBe(
      "iPad holds the shell.Take the shell",
    );
    expect(document.activeElement).not.toBe(screen.queryByRole("button", { name: "Take it" }));
    expect(takes.takes).toStrictEqual([]);
  });
});
