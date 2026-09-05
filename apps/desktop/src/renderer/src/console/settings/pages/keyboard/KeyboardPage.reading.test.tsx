// What the keyboard page reads, and what it draws when the set it reads moves.
//
// The rows the shipped chord set produces, the scope each chord is live in, and the
// rows that appear and vanish as the frame registers and unregisters commands while
// the page is open. What a person CHANGES is `KeyboardPage.rebinding.test.tsx`, over
// the one cast in `keyboard-page.test-support.tsx`.
import { act, fireEvent, render } from "@testing-library/react";
import { useEffect, useState } from "react";
import { describe, expect, it } from "vitest";
import { consoleCommands } from "../../../frame/command-surface.js";
import { LiveAnnouncerProvider } from "../../../primitives/index.js";
import { KeyboardPage, registerKeyboardPage } from "./KeyboardPage.js";
import { SettingsPageRegistry } from "../../settings-page-registry.js";
import { TEST_COMMAND_IDS, renderPage, rowOf } from "./keyboard-page.test-support.js";

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
