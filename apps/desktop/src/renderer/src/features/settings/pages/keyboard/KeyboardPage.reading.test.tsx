// What the keyboard page draws when the set it reads moves: rows appear and vanish as the frame
// registers and unregisters commands. Changes are in `KeyboardPage.rebinding.test.ts`.
import { crossMacrotaskBoundary } from "@test/helpers/macrotask-boundary.js";
import { act, render } from "@testing-library/react";
import { useEffect, useState } from "react";
import { describe, expect, it } from "vitest";
import { commandRegistry } from "@renderer/registries/commands/window-command-registry.js";
import { LiveAnnouncerProvider } from "@renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import { KeyboardPage } from "./KeyboardPage.js";
import { rowOf } from "./keyboard-page.test-support.js";

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
});
