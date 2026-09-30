// What the keyboard page reads, and what it draws when the set it reads moves: the rows the
// shipped chord set produces, each chord's scope, and rows that appear and vanish as the frame
// registers and unregisters commands. Changes are in `KeyboardPage.rebinding.test.tsx`.
import { crossMacrotaskBoundary } from "@test/helpers/macrotask-boundary.js";
import { act, fireEvent, render } from "@testing-library/react";
import { useEffect, useState } from "react";
import { describe, expect, it } from "vitest";
import { commandRegistry } from "@renderer/registries/commands/window-command-registry.js";
import { LiveAnnouncerProvider } from "@renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import { KeyboardPage } from "./KeyboardPage.js";
import { composeSettingsPages } from "../../settings-pages.js";
import { TEST_COMMAND_IDS, renderKeyboardPage, rowOf } from "./keyboard-page.test-support.js";
import { commandContributionRegistry } from "@renderer/registries/commands/command-contributions.js";
import { registerNavigationKeybindings } from "@renderer/layout/NavigationRail/navigation-commands.js";

// The rail's shipped chords, contributed the way the window's composition contributes them,
// so the page reads the same shipped table a window has.
registerNavigationKeybindings(commandContributionRegistry);

describe("keyboard page — what it reads", () => {
  it("prints each command's id and the chord that runs it", () => {
    const { container } = renderKeyboardPage();
    const text = container.textContent ?? "";
    expect(text).toContain("frame.goToSessions");
    expect(text).toContain("Go to sessions");
    // The chord renders as keycaps, which is the console's one chord rendering.
    expect(container.querySelectorAll("kbd").length).toBeGreaterThan(0);
  });

  it("says where a chord is live rather than leaving its scope unstated", () => {
    // Every shipped chord is unscoped, so this asserts the arm the shipped set reaches; scoped
    // bindings are asserted in `keybinding-map.test.ts`.
    const { container } = renderKeyboardPage();
    expect(container.textContent ?? "").toContain("Live everywhere in this window");
  });

  it("says a command with no chord has none rather than leaving the row blank", () => {
    const { container } = renderKeyboardPage();
    const badges = [...container.querySelectorAll(".meridian-nothing--badge")].map(
      (element) => element.textContent ?? "",
    );
    expect(badges.some((label) => label.includes("No chord"))).toBe(true);
  });

  it("reports the shipped chord set as free of collisions", () => {
    const { container } = renderKeyboardPage();
    expect(container.textContent ?? "").toContain("No two chords collide.");
  });

  it("narrows to a typed query and names the query when nothing matches", () => {
    const { container } = renderKeyboardPage();
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
    const registry = composeSettingsPages();
    const descriptor = registry.descriptorFor("keyboard");
    expect(descriptor?.label).toBe("Keyboard");
    expect(descriptor?.keywords).toContain("shortcut");
  });
});

/** A command no `beforeEach` registers, so a case can register it late and with no chord. */
const LATE_COMMAND = {
  id: "frame.openContextPicker",
  title: "Open the context picker",
  group: "Navigation",
  run: () => undefined,
} as const;

/**
 * The frame's own shape: a parent that registers commands from an effect and bumps a revision,
 * which re-renders the subtree the page is in.
 *
 * A child's effects run before its parent's, so the page first renders against an unfilled
 * registry, as a window opened directly on `#/settings/keyboard` does.
 */
function LateRegisteringFrame(): React.JSX.Element {
  const [commandRevision, setCommandRevision] = useState(0);
  useEffect(() => {
    commandRegistry.register(LATE_COMMAND);
    setCommandRevision((revision) => revision + 1);
    return () => {
      commandRegistry.unregister(LATE_COMMAND.id);
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
    // Guards the fix for a page that snapshotted the registry in a memo and showed no rows
    // when a window opened straight onto this route.
    const { container } = render(<LateRegisteringFrame />);
    await act(async () => {
      await crossMacrotaskBoundary();
    });

    expect(rowOf(container, LATE_COMMAND.id)).toBeDefined();
  });

  it("drops a row for a command that is unregistered while the page is open", async () => {
    // The same read in the other direction: a withdrawn command leaves no row behind.
    const { container, rerender } = render(
      <LiveAnnouncerProvider>
        <KeyboardPage />
      </LiveAnnouncerProvider>,
    );
    expect(rowOf(container, "app.checkForUpdates")).toBeDefined();

    commandRegistry.unregister("app.checkForUpdates");
    await act(async () => {
      rerender(
        <LiveAnnouncerProvider>
          <KeyboardPage />
        </LiveAnnouncerProvider>,
      );
      await crossMacrotaskBoundary();
    });

    expect(() => rowOf(container, "app.checkForUpdates")).toThrow();
  });

  it("negative control: with nothing registered the page draws no rows", () => {
    // Guards against a page that draws a row for every id it was ever asked about.
    for (const commandId of TEST_COMMAND_IDS) {
      commandRegistry.unregister(commandId);
    }
    const { container } = renderKeyboardPage();

    expect(container.querySelectorAll(".meridian-keymap__row")).toHaveLength(0);
  });
});
