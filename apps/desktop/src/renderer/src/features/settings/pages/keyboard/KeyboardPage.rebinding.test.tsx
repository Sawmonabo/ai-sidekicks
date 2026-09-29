// What the keyboard page changes, and what it refuses to change.
//
// Recording a chord onto the frame's own seam, the collision it refuses by naming the
// command already holding the chord, the entry kept for a command this build no longer
// registers, and the count of changed rows. What the page READS is
// `KeyboardPage.reading.test.tsx`, over the one cast in `keyboard-page.test-support.tsx`.
import { crossMacrotaskBoundary } from "@test/helpers/macrotask-boundary.js";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { keybindingOverrides } from "@renderer/registries/keybindings/keybinding-override-store.js";
import { LiveAnnouncerProvider } from "@renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import { formatCount } from "@renderer/lib/wire-figures.js";
import { liveRegionText, politeText } from "@test/helpers/live-region.js";
import { KeyboardPage } from "./KeyboardPage.js";
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
    // The seam the FRAME installs from, not a copy the page keeps.
    expect(
      keybindingOverrides.snapshot.bindings.find(
        (binding) => binding.commandId === "app.checkForUpdates",
      )?.chord,
    ).toBe("Alt+KeyJ");
    expect(rowOf(container, "app.checkForUpdates").textContent ?? "").toContain("Reset");
  });

  it("announces a rebinding once, politely, and says nothing on a later render", async () => {
    const { container, rerender } = renderKeyboardPage();
    await recordChordOnto(container, "app.checkForUpdates", RECORDED_PRESS);

    await waitFor(() => {
      expect(politeText(container)).toContain("Check for updates now runs on");
    });
    const spoken = politeText(container);

    // The negative control for "once": a re-render is not an act, so the region must
    // hold what it already held rather than repeat or add to it.
    rerender(
      <LiveAnnouncerProvider>
        <KeyboardPage />
      </LiveAnnouncerProvider>,
    );
    expect(politeText(container)).toBe(spoken);
    expect(liveRegionText(container, "assertive")).toBe("");
  });

  it("refuses a chord another command holds, naming that command on the row", async () => {
    const { container } = renderKeyboardPage();
    await recordChordOnto(container, "app.checkForUpdates", RECORDED_PRESS);
    await waitFor(() => {
      expect(keybindingOverrides.overrides["app.checkForUpdates"]).toBe("Alt+KeyJ");
    });

    await recordChordOnto(container, "frame.goToSessions", RECORDED_PRESS);

    await waitFor(() => {
      expect(rowOf(container, "frame.goToSessions").textContent ?? "").toContain("chord-taken");
    });
    expect(rowOf(container, "frame.goToSessions").textContent ?? "").toContain(
      "app.checkForUpdates",
    );
    // Refused before anything moved.
    expect(keybindingOverrides.overrides["frame.goToSessions"]).toBeUndefined();
  });

  it("resets a row back to the chord the console ships, and announces that once", async () => {
    // The override is put on the seam directly rather than through the recorder, so
    // the reset is the only act this case performs and the only thing spoken. The
    // announcer holds a standing message and queues the next, which is its own
    // contract (`live-announcer.ts`) and not this page's to drive.
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

  it("names the command in every control's label, so a list of rows can be navigated", async () => {
    const { container } = renderKeyboardPage();
    expect(recorderOf(container, "app.checkForUpdates").getAttribute("aria-label")).toBe(
      "Rebind Check for updates",
    );

    await recordChordOnto(container, "app.checkForUpdates", RECORDED_PRESS);
    await waitFor(() => {
      expect(keybindingOverrides.overrides["app.checkForUpdates"]).toBe("Alt+KeyJ");
    });
    expect(
      rowOf(container, "app.checkForUpdates")
        .querySelector(".meridian-keymap__reset")
        ?.getAttribute("aria-label"),
    ).toContain("Check for updates");
  });

  it("negative control: two rows' recorders are not told apart by their visible word", async () => {
    // Without a per-row label the case above would pass over a page whose every
    // recorder is called "Rebind", which is a list nobody reading it through a
    // screen reader can navigate.
    const { container } = renderKeyboardPage();
    const labels = [...container.querySelectorAll(".meridian-keymap__record")].map(
      (element) => element.getAttribute("aria-label") ?? "",
    );
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels.every((label) => label.startsWith("Rebind "))).toBe(true);
  });

  it("negative control: a modifier held on its own does not complete a recording", async () => {
    // Without this the recorder would settle the moment somebody pressed ⌥ on the
    // way to ⌥J, and would bind a chord nobody asked for.
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

  it("draws the keys held so far while a chord is still incomplete", async () => {
    // The section asks for "the keys held so far, and whether the chord is complete".
    // Before this, a modifier press was read and discarded, so a person on the way to
    // ⌥J saw nothing at all between arming the recorder and settling it.
    const { container } = renderKeyboardPage();
    const recorder = recorderOf(container, "app.checkForUpdates");
    fireEvent.click(recorder);
    // Opening arm first: an armed recorder that had received nothing must say so
    // rather than draw an empty holding hint.
    expect(rowOf(container, "app.checkForUpdates").textContent ?? "").toContain("Nothing held yet");

    await act(async () => {
      fireEvent.keyDown(recorder, { key: "Alt", code: "AltLeft", altKey: true });
      await crossMacrotaskBoundary();
    });

    const rowText = rowOf(container, "app.checkForUpdates").textContent ?? "";
    expect(rowText).toContain("Holding");
    expect(rowText).toContain("the chord is not complete");
    // And nothing was bound: the hint is a reading of an unfinished press.
    expect(keybindingOverrides.overrides["app.checkForUpdates"]).toBeUndefined();
  });

  it("stops saying a modifier is held once the person has released it", async () => {
    // The hint is a reading of what is held RIGHT NOW, and a keydown alone cannot know
    // that: a person who presses ⇧, changes their mind, and lets go left the row saying
    // "Holding ⇧" for as long as the recorder stayed armed — a sentence about the
    // present tense that was false and had no way of becoming true again.
    const { container } = renderKeyboardPage();
    const recorder = recorderOf(container, "app.checkForUpdates");
    fireEvent.click(recorder);

    await act(async () => {
      fireEvent.keyDown(recorder, { key: "Shift", code: "ShiftLeft", shiftKey: true });
      await crossMacrotaskBoundary();
    });
    expect(rowOf(container, "app.checkForUpdates").textContent ?? "").toContain("Holding");

    // The release, as the host reports one: the modifier's own flag is already false on
    // the keyup that ends it.
    await act(async () => {
      fireEvent.keyUp(recorder, { key: "Shift", code: "ShiftLeft", shiftKey: false });
      await crossMacrotaskBoundary();
    });

    const rowText = rowOf(container, "app.checkForUpdates").textContent ?? "";
    expect(rowText).toContain("Nothing held yet");
    expect(rowText).not.toContain("Holding");
    // Still armed, so the release is a correction to the hint and not an end to the
    // recording: the next press is still the chord.
    expect(recorder.getAttribute("aria-pressed")).toBe("true");
    expect(keybindingOverrides.overrides["app.checkForUpdates"]).toBeUndefined();
  });

  it("keeps the modifiers still down when one of several is released", async () => {
    // The other direction, and the one a bare clear would get wrong: releasing ⇧ on the
    // way to ⌥⇧J leaves ⌥ held, and a hint that emptied itself would be as false as one
    // that never emptied at all.
    const { container } = renderKeyboardPage();
    const recorder = recorderOf(container, "app.checkForUpdates");
    fireEvent.click(recorder);

    await act(async () => {
      fireEvent.keyDown(recorder, {
        key: "Shift",
        code: "ShiftLeft",
        altKey: true,
        shiftKey: true,
      });
      await crossMacrotaskBoundary();
    });
    await act(async () => {
      fireEvent.keyUp(recorder, {
        key: "Shift",
        code: "ShiftLeft",
        altKey: true,
        shiftKey: false,
      });
      await crossMacrotaskBoundary();
    });

    const rowText = rowOf(container, "app.checkForUpdates").textContent ?? "";
    expect(rowText).toContain("Holding");
    expect(rowText).not.toContain("Nothing held yet");
  });

  it("names the chord a per-row reset restores, rather than promising a default", async () => {
    const { container } = renderKeyboardPage();
    await recordChordOnto(container, "frame.goToSessions", RECORDED_PRESS);
    await waitFor(() => {
      expect(keybindingOverrides.overrides["frame.goToSessions"]).toBe("Alt+KeyJ");
    });

    const reset = rowOf(container, "frame.goToSessions").querySelector(".meridian-keymap__reset");
    expect(reset?.textContent ?? "").toContain("Reset to");
    // The SHIPPED chord and never the effective one, which is the shipped table with
    // this very override already composed onto it.
    expect(reset?.getAttribute("aria-label") ?? "").toContain("$mod+1");
    expect(reset?.getAttribute("aria-label") ?? "").not.toContain("Alt+KeyJ");
  });

  it("names each default the reset-all control restores, beside the control", async () => {
    await keybindingOverrides.bind("frame.goToSessions", "Alt+KeyJ");
    await keybindingOverrides.bind("app.checkForUpdates", "Alt+KeyK");
    const { container } = renderKeyboardPage();

    const block = container.querySelector(".meridian-keymap__reset-all-block");
    const blockText = block?.textContent ?? "";
    // One row ships a chord and the other ships none, so both promises are on screen
    // and neither is the other's wording.
    expect(blockText).toContain("back to");
    expect(blockText).toContain("back to no chord");
    expect(blockText).toContain("frame.goToSessions");
    expect(blockText).toContain("app.checkForUpdates");
  });
});

describe("the changed-chord count", () => {
  /**
   * The reset-all control's whole label, or `undefined` where no row is changed.
   *
   * The figure is asserted through the label rather than a fragment of it, because
   * what has to hold is that the number a person reads came from the chokepoint —
   * a substring check would pass on "2" inside "12".
   */
  function resetAllLabel(container: HTMLElement): string | undefined {
    return container.querySelector(".meridian-keymap__reset-all")?.textContent ?? undefined;
  }

  it("reads the changed rows through the console's own figure formatter", async () => {
    // Two rows rather than one: the singular arm renders a different noun, so a
    // count assertion on one row would be asserting the noun as much as the figure.
    await keybindingOverrides.bind("frame.goToSessions", "Alt+KeyJ");
    await keybindingOverrides.bind("frame.goToWorkflows", "Alt+KeyK");
    const { container } = renderKeyboardPage();

    expect(resetAllLabel(container)).toBe(`Reset all ${formatCount(2)} changed chords`);
  });

  it("negative control: no changed row draws no reset-all control at all", async () => {
    // Without this the case above would pass over a page that drew the control
    // unconditionally, and the count would be asserting a constant.
    const { container } = renderKeyboardPage();
    expect(resetAllLabel(container)).toBeUndefined();
    expect(container.textContent ?? "").toContain("Every chord is the one the console ships.");
  });
});
