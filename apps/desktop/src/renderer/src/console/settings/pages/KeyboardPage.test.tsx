// The keyboard page reads the window's real command registry, prints the chord
// each command is bound to, and offers no way to change one.

import { fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { consoleCommands } from "../../frame/command-surface.js";
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

afterEach(() => {
  for (const commandId of TEST_COMMAND_IDS) {
    consoleCommands.unregister(commandId);
  }
});

describe("keyboard page", () => {
  it("prints each command's id and the chord that runs it", () => {
    const { container } = render(<KeyboardPage />);
    const text = container.textContent ?? "";
    expect(text).toContain("frame.goToSessions");
    expect(text).toContain("Go to sessions");
    // The chord renders as keycaps, which is the console's one chord rendering.
    expect(container.querySelectorAll("kbd").length).toBeGreaterThan(0);
  });

  it("says where a chord is live rather than leaving its scope unstated", () => {
    // Every chord the frame binds today is unscoped, so this asserts the arm the
    // shipped set actually reaches. That a scoped binding carries its expression
    // through to its row is asserted in `keybinding-map.test.ts`, against a set
    // that has one — a page test cannot plant a binding, because the page reads
    // the console's own.
    const { container } = render(<KeyboardPage />);
    expect(container.textContent ?? "").toContain("Live everywhere in this window");
  });

  it("says a command with no chord has none rather than leaving the row blank", () => {
    const { container } = render(<KeyboardPage />);
    const badges = [...container.querySelectorAll(".meridian-nothing--badge")].map(
      (element) => element.textContent ?? "",
    );
    expect(badges.some((label) => label.includes("No chord"))).toBe(true);
  });

  it("reports the shipped chord set as free of collisions", () => {
    const { container } = render(<KeyboardPage />);
    expect(container.textContent ?? "").toContain("No two chords collide.");
  });

  it("narrows to a typed query and names the query when nothing matches", () => {
    const { container } = render(<KeyboardPage />);
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

  it("offers no way to change a chord, and says so rather than disabling one", () => {
    const { container } = render(<KeyboardPage />);
    // The filter is the page's only control. Anything else would be a rebinding
    // affordance that nothing would install.
    expect(container.querySelectorAll("input")).toHaveLength(1);
    expect(container.querySelectorAll("button, select, textarea")).toHaveLength(0);
    expect(container.textContent ?? "").toContain("Chords cannot be changed here yet.");
  });

  it("negative control: the control sweep bites on one disabled record button", () => {
    // Without this the sweep above would pass over any tree with no controls,
    // including one that failed to render the page at all — and a DISABLED control
    // is the specific thing the console forbids in place of an absence.
    const { container } = render(
      <div>
        <button type="button" disabled>
          Record chord
        </button>
      </div>,
    );
    expect(container.querySelectorAll("button, select, textarea")).toHaveLength(1);
  });

  it("claims the keyboard section with a search vocabulary", () => {
    const registry = new SettingsPageRegistry();
    registerKeyboardPage(registry);
    const descriptor = registry.descriptorFor("keyboard");
    expect(descriptor?.label).toBe("Keyboard");
    expect(descriptor?.keywords).toContain("shortcut");
  });
});
