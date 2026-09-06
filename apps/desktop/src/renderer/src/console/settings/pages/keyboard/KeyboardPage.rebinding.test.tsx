// What the keyboard page changes, and what it refuses to change.
//
// Recording a chord onto the frame's own seam, the collision it refuses by naming the
// command already holding the chord, the entry kept for a command this build no longer
// registers, and the count of changed rows. What the page READS is
// `KeyboardPage.reading.test.tsx`, over the one cast in `keyboard-page.test-support.tsx`.
import { act, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { consoleKeybindingOverrides } from "../../../palette/index.js";
import { LiveAnnouncerProvider, formatCount } from "../../../primitives/index.js";
import { KeyboardPage } from "./KeyboardPage.js";
import {
  RECORDED_PRESS,
  politeAnnouncement,
  recordOnto,
  recorderOf,
  renderPage,
  rowOf,
} from "./keyboard-page.test-support.js";

describe("keyboard page — what it changes", () => {
  it("records a chord onto the frame's own seam and prints it back", async () => {
    const { container } = renderPage();
    await recordOnto(container, "app.checkForUpdates", RECORDED_PRESS);

    await waitFor(() => {
      expect(consoleKeybindingOverrides.overrides["app.checkForUpdates"]).toBe("Alt+KeyJ");
    });
    // The seam the FRAME installs from, not a copy the page keeps.
    expect(
      consoleKeybindingOverrides.surface.bindings.find(
        (binding) => binding.commandId === "app.checkForUpdates",
      )?.chord,
    ).toBe("Alt+KeyJ");
    expect(rowOf(container, "app.checkForUpdates").textContent ?? "").toContain("Reset");
  });

  it("announces a rebinding once, politely, and says nothing on a later render", async () => {
    const { container, rerender } = renderPage();
    await recordOnto(container, "app.checkForUpdates", RECORDED_PRESS);

    await waitFor(() => {
      expect(politeAnnouncement(container)).toContain("Check for updates now runs on");
    });
    const spoken = politeAnnouncement(container);

    // The negative control for "once": a re-render is not an act, so the region must
    // hold what it already held rather than repeat or add to it.
    rerender(
      <LiveAnnouncerProvider>
        <KeyboardPage />
      </LiveAnnouncerProvider>,
    );
    expect(politeAnnouncement(container)).toBe(spoken);
    expect(container.querySelector('[data-live-region="assertive"]')?.textContent).toBe("");
  });

  it("refuses a chord another command holds, naming that command on the row", async () => {
    const { container } = renderPage();
    await recordOnto(container, "app.checkForUpdates", RECORDED_PRESS);
    await waitFor(() => {
      expect(consoleKeybindingOverrides.overrides["app.checkForUpdates"]).toBe("Alt+KeyJ");
    });

    await recordOnto(container, "frame.goToSessions", RECORDED_PRESS);

    await waitFor(() => {
      expect(rowOf(container, "frame.goToSessions").textContent ?? "").toContain("chord-taken");
    });
    expect(rowOf(container, "frame.goToSessions").textContent ?? "").toContain(
      "app.checkForUpdates",
    );
    // Refused before anything moved.
    expect(consoleKeybindingOverrides.overrides["frame.goToSessions"]).toBeUndefined();
  });

  it("resets a row back to the chord the console ships, and announces that once", async () => {
    // The override is put on the seam directly rather than through the recorder, so
    // the reset is the only act this case performs and the only thing spoken. The
    // announcer holds a standing message and queues the next, which is its own
    // contract (`live-announcer.ts`) and not this page's to drive.
    await consoleKeybindingOverrides.bind("frame.goToSessions", "Alt+KeyJ");
    const { container } = renderPage();
    expect(consoleKeybindingOverrides.overrides["frame.goToSessions"]).toBe("Alt+KeyJ");

    const reset = rowOf(container, "frame.goToSessions").querySelector(".meridian-keymap__reset");
    expect(reset).not.toBeNull();
    await act(async () => {
      fireEvent.click(reset as Element);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(consoleKeybindingOverrides.overrides["frame.goToSessions"]).toBeUndefined();
    });
    expect(politeAnnouncement(container)).toContain("back to the chord the console ships");
  });

  it("names the command in every control's label, so a list of rows can be navigated", async () => {
    const { container } = renderPage();
    expect(recorderOf(container, "app.checkForUpdates").getAttribute("aria-label")).toBe(
      "Rebind Check for updates",
    );

    await recordOnto(container, "app.checkForUpdates", RECORDED_PRESS);
    await waitFor(() => {
      expect(consoleKeybindingOverrides.overrides["app.checkForUpdates"]).toBe("Alt+KeyJ");
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
    const { container } = renderPage();
    const labels = [...container.querySelectorAll(".meridian-keymap__record")].map(
      (element) => element.getAttribute("aria-label") ?? "",
    );
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels.every((label) => label.startsWith("Rebind "))).toBe(true);
  });

  it("negative control: a modifier held on its own does not complete a recording", async () => {
    // Without this the recorder would settle the moment somebody pressed ⌥ on the
    // way to ⌥J, and would bind a chord nobody asked for.
    const { container } = renderPage();
    await recordOnto(container, "app.checkForUpdates", {
      key: "Alt",
      code: "AltLeft",
      altKey: true,
    });

    expect(consoleKeybindingOverrides.overrides["app.checkForUpdates"]).toBeUndefined();
    // Still armed, so the next press is the chord.
    expect(recorderOf(container, "app.checkForUpdates").getAttribute("aria-pressed")).toBe("true");
    expect(politeAnnouncement(container)).toBe("");
  });
});

describe("keyboard page — a chord kept for a command this build does not have", () => {
  /** The id no command in this window registers. Removed by the shared `resetAll`. */
  const RETIRED_COMMAND_ID = "retired.commandThatLeft";

  it("draws the entry, its chord, and the control that removes it", async () => {
    // The entry is invisible without this region and its chord is live anyway, so a
    // person is refused a rebinding by an id they cannot find anywhere on the page.
    await consoleKeybindingOverrides.bind(RETIRED_COMMAND_ID, "Alt+KeyQ");
    const { container } = renderPage();

    // The reservation is real: the effective table this window installs carries it.
    expect(consoleKeybindingOverrides.surface.bindings).toContainEqual({
      chord: "Alt+KeyQ",
      commandId: RETIRED_COMMAND_ID,
    });
    const region = container.querySelector(
      'section[aria-label="Chords kept for commands this build does not have"]',
    );
    expect(region).not.toBeNull();
    expect(region?.querySelectorAll(".meridian-keymap__stale-row")).toHaveLength(1);
    expect(region?.textContent ?? "").toContain(RETIRED_COMMAND_ID);
    expect(region?.querySelectorAll("kbd").length).toBeGreaterThan(0);
  });

  it("removes the entry, and frees the chord it was holding", async () => {
    await consoleKeybindingOverrides.bind(RETIRED_COMMAND_ID, "Alt+KeyQ");
    const { container } = renderPage();
    const remove = container.querySelector<HTMLButtonElement>(
      `button[aria-label="Remove the chord kept for ${RETIRED_COMMAND_ID}"]`,
    );

    await act(async () => {
      remove?.click();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(
        container.querySelector(
          'section[aria-label="Chords kept for commands this build does not have"]',
        ),
      ).toBeNull();
    });
    expect(consoleKeybindingOverrides.overrides[RETIRED_COMMAND_ID]).toBeUndefined();
    expect(
      consoleKeybindingOverrides.surface.bindings.some(
        (binding) => binding.commandId === RETIRED_COMMAND_ID,
      ),
    ).toBe(false);
    expect(politeAnnouncement(container)).toContain(RETIRED_COMMAND_ID);
  });

  it("negative control: with no such entry the region is absent, not a count of zero", async () => {
    // Without this, a page that always drew the region would satisfy both cases above
    // and then explain, to every person who has none, a failure they do not have.
    await consoleKeybindingOverrides.bind("frame.goToSessions", "Alt+KeyQ");
    const { container } = renderPage();

    expect(
      container.querySelector(
        'section[aria-label="Chords kept for commands this build does not have"]',
      ),
    ).toBeNull();
    // The rebinding really did land, so the silence is about staleness rather than
    // about a page that read no overrides at all.
    expect(consoleKeybindingOverrides.overrides["frame.goToSessions"]).toBe("Alt+KeyQ");
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
    await consoleKeybindingOverrides.bind("frame.goToSessions", "Alt+KeyJ");
    await consoleKeybindingOverrides.bind("frame.goToWorkflows", "Alt+KeyK");
    const { container } = renderPage();

    expect(resetAllLabel(container)).toBe(`Reset all ${formatCount(2)} changed chords`);
  });

  it("negative control: no changed row draws no reset-all control at all", async () => {
    // Without this the case above would pass over a page that drew the control
    // unconditionally, and the count would be asserting a constant.
    const { container } = renderPage();
    expect(resetAllLabel(container)).toBeUndefined();
    expect(container.textContent ?? "").toContain("Every chord is the one the console ships.");
  });
});
