// The keyboard page reads the window's real command registry and the frame's real
// override seam: what it prints is what the frame installs, and what it records
// reaches that seam rather than a table of its own.

import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { useEffect, useState } from "react";
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

/**
 * A command no `beforeEach` registers, so a case can register it LATE.
 *
 * The chord table names none of these ids, which is what makes it a command with no
 * chord rather than one competing for a shipped one.
 */
const LATE_COMMAND = {
  id: "frame.openContextPicker",
  title: "Open the context picker",
  group: "Navigation",
  run: () => undefined,
} as const;

/**
 * The frame's own shape: a parent that registers commands from an effect and bumps
 * a revision, which is what re-renders the subtree the page is in.
 *
 * React runs a child's effects BEFORE its parent's, so the page renders once against
 * a registry the frame has not filled yet — exactly what a window opened directly on
 * `#/settings/keyboard` does. The revision is rendered onto the wrapper rather than
 * passed down, because the page takes no such prop and does not need one: what the
 * frame owes it is a render, not a value.
 */
function LateRegisteringFrame(): React.JSX.Element {
  const [commandRevision, setCommandRevision] = useState(0);
  useEffect(() => {
    consoleCommands.register(LATE_COMMAND);
    setCommandRevision((revision) => revision + 1);
    return () => {
      consoleCommands.unregister(LATE_COMMAND.id);
    };
  }, []);
  return (
    <div data-command-revision={commandRevision}>
      <LiveAnnouncerProvider>
        <KeyboardPage />
      </LiveAnnouncerProvider>
    </div>
  );
}

describe("keyboard page — a command registered after the page first rendered", () => {
  it("draws the row once the frame has registered it", async () => {
    // The defect: the page snapshotted the registry in a memo keyed on nothing, so a
    // window opened straight onto this route kept the empty registry it had before
    // the frame's registration effect ran — no rows at all until the person left the
    // section and came back.
    const { container } = render(<LateRegisteringFrame />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(rowOf(container, LATE_COMMAND.id)).toBeDefined();
  });

  it("drops a row for a command that is unregistered while the page is open", async () => {
    // The same read, in the other direction: a surface that withdraws its commands
    // leaves no row behind claiming a chord runs something this window cannot run.
    const { container, rerender } = render(
      <LiveAnnouncerProvider>
        <KeyboardPage />
      </LiveAnnouncerProvider>,
    );
    expect(rowOf(container, "app.checkForUpdates")).toBeDefined();

    consoleCommands.unregister("app.checkForUpdates");
    await act(async () => {
      rerender(
        <LiveAnnouncerProvider>
          <KeyboardPage />
        </LiveAnnouncerProvider>,
      );
      await Promise.resolve();
    });

    expect(() => rowOf(container, "app.checkForUpdates")).toThrow();
  });

  it("negative control: with nothing registered the page says so rather than drawing rows", () => {
    // Without this the cases above would pass over a page that drew a row for every
    // id it was ever asked about, which would prove nothing about the read.
    for (const commandId of TEST_COMMAND_IDS) {
      consoleCommands.unregister(commandId);
    }
    const { container } = renderPage();

    expect(container.querySelectorAll(".meridian-keymap__row")).toHaveLength(0);
    expect(container.textContent ?? "").toContain("This window has registered no commands.");
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
