// What the keyboard page changes and refuses to change: recording a chord onto the frame's own
// seam, the collision it refuses by naming the holder, and the reset to the shipped chord. Reads
// are in `KeyboardPage.reading.test.tsx`.
import { crossMacrotaskBoundary } from "@test/helpers/macrotask-boundary.js";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { keybindingOverrides } from "@renderer/registries/keybindings/keybinding-override-store.js";
import { politeText } from "@test/helpers/live-region.js";
import {
  RECORDED_PRESS,
  recordChordOnto,
  recorderOf,
  renderKeyboardPage,
  rowOf,
} from "./keyboard-page.test-support.js";
import { commandContributionRegistry } from "@renderer/registries/commands/command-contributions.js";
import { registerNavigationKeybindings } from "@renderer/layout/NavigationRail/navigation-commands.js";

// The rail's shipped chords, contributed the way the window's composition contributes them,
// so the page reads the same shipped table a window has.
registerNavigationKeybindings(commandContributionRegistry);

describe("keyboard page — what it changes", () => {
  it("records a chord onto the frame's own seam and prints it back", async () => {
    const { container } = renderKeyboardPage();
    await recordChordOnto(container, "app.checkForUpdates", RECORDED_PRESS);

    await waitFor(() => {
      expect(keybindingOverrides.overrides["app.checkForUpdates"]).toBe("Alt+KeyJ");
    });
    // The seam the frame installs from, not a copy the page keeps.
    expect(
      keybindingOverrides.snapshot.bindings.find(
        (binding) => binding.commandId === "app.checkForUpdates",
      )?.chord,
    ).toBe("Alt+KeyJ");
    expect(rowOf(container, "app.checkForUpdates").textContent ?? "").toContain("Reset");
  });

  it("refuses a chord another command holds, naming that command on the row", async () => {
    const { container } = renderKeyboardPage();
    await recordChordOnto(container, "app.checkForUpdates", RECORDED_PRESS);
    await waitFor(() => {
      expect(keybindingOverrides.overrides["app.checkForUpdates"]).toBe("Alt+KeyJ");
    });

    await recordChordOnto(container, "frame.goToSessions", RECORDED_PRESS);

    await waitFor(() => {
      expect(rowOf(container, "frame.goToSessions").textContent ?? "").toContain(
        "already opens Check for updates.",
      );
    });
    // Refused before anything moved.
    expect(keybindingOverrides.overrides["frame.goToSessions"]).toBeUndefined();
  });

  it("resets a row back to the chord the console ships, and announces that once", async () => {
    // The override is put on the seam directly so the reset is the only act performed and the
    // only thing spoken; the announcer's standing-message queue is its own contract.
    await keybindingOverrides.bind("frame.goToSessions", "Alt+KeyJ");
    const { container } = renderKeyboardPage();
    expect(keybindingOverrides.overrides["frame.goToSessions"]).toBe("Alt+KeyJ");

    const reset = rowOf(container, "frame.goToSessions").querySelector(".meridian-keymap__reset");
    expect(reset).not.toBeNull();
    await act(async () => {
      fireEvent.click(reset as Element);
      await crossMacrotaskBoundary();
    });

    await waitFor(() => {
      expect(keybindingOverrides.overrides["frame.goToSessions"]).toBeUndefined();
    });
    expect(politeText(container)).toContain("back to the chord the console ships");
  });

  it("negative control: a modifier held on its own does not complete a recording", async () => {
    // Guards against the recorder settling on ⌥ on the way to ⌥J.
    const { container } = renderKeyboardPage();
    await recordChordOnto(container, "app.checkForUpdates", {
      key: "Alt",
      code: "AltLeft",
      altKey: true,
    });

    expect(keybindingOverrides.overrides["app.checkForUpdates"]).toBeUndefined();
    // Still armed, so the next press is the chord.
    expect(recorderOf(container, "app.checkForUpdates").getAttribute("aria-pressed")).toBe("true");
    expect(politeText(container)).toBe("");
  });
});
