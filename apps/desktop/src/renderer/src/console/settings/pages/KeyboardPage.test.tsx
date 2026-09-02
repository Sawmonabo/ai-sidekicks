// The keyboard page reads the window's real command registry and the frame's real
// override seam: what it prints is what the frame installs, and what it records
// reaches that seam rather than a table of its own.

import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { consoleCommands } from "../../frame/command-surface.js";
import { consoleKeybindingOverrides } from "../../frame/keybinding-override-store.js";
import { LiveAnnouncerProvider } from "../../primitives/index.js";
import { KeyboardPage, registerKeyboardPage } from "./KeyboardPage.js";
import { SettingsPageRegistry } from "../settings-page-registry.js";

/**
 * The commands the shipped frame bindings name, plus one that no chord reaches.
 *
 * Registered on the REAL registry rather than a stand-in: the page reads that
 * registry by name, and a test that handed it a private one would prove the join
 * works on an object nothing in the console uses.
 */
const TEST_COMMAND_IDS = [
  "frame.goToSessions",
  "frame.goToWorkflows",
  "app.checkForUpdates",
] as const;

/**
 * A chord no platform reads differently.
 *
 * `$mod` resolves against the host, so a synthesised press naming it would be a
 * second platform reading in a test file. `Alt` is the same key everywhere, which is
 * all these cases need — what is under test is the seam, not the modifier.
 */
const RECORDED_PRESS = { key: "j", code: "KeyJ", altKey: true } as const;

function renderPage(): ReturnType<typeof render> {
  return render(
    <LiveAnnouncerProvider>
      <KeyboardPage />
    </LiveAnnouncerProvider>,
  );
}

function politeAnnouncement(container: HTMLElement): string {
  return container.querySelector('[data-live-region="polite"]')?.textContent ?? "";
}

/** The recorder on one row, found by the command id printed beside it. */
function rowOf(container: HTMLElement, commandId: string): HTMLElement {
  const row = [...container.querySelectorAll<HTMLElement>(".meridian-keymap__row")].find(
    (candidate) => (candidate.textContent ?? "").includes(commandId),
  );
  if (row === undefined) {
    throw new Error(`no row for ${commandId}`);
  }
  return row;
}

function recorderOf(container: HTMLElement, commandId: string): HTMLElement {
  const button = rowOf(container, commandId).querySelector<HTMLElement>(".meridian-keymap__record");
  if (button === null) {
    throw new Error(`no recorder for ${commandId}`);
  }
  return button;
}

/** Arm the recorder on a row and press one chord into it. */
async function recordOnto(
  container: HTMLElement,
  commandId: string,
  press: Record<string, unknown>,
): Promise<void> {
  const recorder = recorderOf(container, commandId);
  fireEvent.click(recorder);
  await act(async () => {
    fireEvent.keyDown(recorder, press);
    await Promise.resolve();
  });
}

beforeEach(() => {
  consoleCommands.registerAll([
    {
      id: "frame.goToSessions",
      title: "Go to sessions",
      group: "Navigation",
      run: () => undefined,
    },
    {
      id: "frame.goToWorkflows",
      title: "Go to workflows",
      group: "Navigation",
      run: () => undefined,
    },
    {
      id: "app.checkForUpdates",
      title: "Check for updates",
      group: "Application",
      run: () => undefined,
    },
  ]);
});

afterEach(async () => {
  cleanup();
  for (const commandId of TEST_COMMAND_IDS) {
    consoleCommands.unregister(commandId);
  }
  // The seam is this window's, so one case's rebinding would otherwise be the next
  // case's starting keyboard.
  await consoleKeybindingOverrides.resetAll();
});

describe("keyboard page — what it reads", () => {
  it("prints each command's id and the chord that runs it", () => {
    const { container } = renderPage();
    const text = container.textContent ?? "";
    expect(text).toContain("frame.goToSessions");
    expect(text).toContain("Go to sessions");
    // The chord renders as keycaps, which is the console's one chord rendering.
    expect(container.querySelectorAll("kbd").length).toBeGreaterThan(0);
  });

  it("says where a chord is live rather than leaving its scope unstated", () => {
    // Every chord the frame ships is unscoped, so this asserts the arm the shipped
    // set actually reaches. That a scoped binding carries its expression through to
    // its row is asserted in `keybinding-map.test.ts`, against a set that has one.
    const { container } = renderPage();
    expect(container.textContent ?? "").toContain("Live everywhere in this window");
  });

  it("says a command with no chord has none rather than leaving the row blank", () => {
    const { container } = renderPage();
    const badges = [...container.querySelectorAll(".meridian-nothing--badge")].map(
      (element) => element.textContent ?? "",
    );
    expect(badges.some((label) => label.includes("No chord"))).toBe(true);
  });

  it("reports the shipped chord set as free of collisions", () => {
    const { container } = renderPage();
    expect(container.textContent ?? "").toContain("No two chords collide.");
  });

  it("narrows to a typed query and names the query when nothing matches", () => {
    const { container } = renderPage();
    const filterInput = container.querySelector("input");
    expect(filterInput).not.toBeNull();
    if (filterInput === null) {
      return;
    }
    fireEvent.change(filterInput, { target: { value: "workflows" } });
    expect(container.querySelectorAll(".meridian-keymap__row")).toHaveLength(1);
    expect(container.textContent ?? "").toContain("Go to workflows");

    fireEvent.change(filterInput, { target: { value: "zzzqqq" } });
    expect(container.querySelectorAll(".meridian-keymap__row")).toHaveLength(0);
    expect(container.textContent ?? "").toContain('No command matches "zzzqqq".');
  });

  it("claims the keyboard section with a search vocabulary", () => {
    const registry = new SettingsPageRegistry();
    registerKeyboardPage(registry);
    const descriptor = registry.descriptorFor("keyboard");
    expect(descriptor?.label).toBe("Keyboard");
    expect(descriptor?.keywords).toContain("shortcut");
  });
});

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
