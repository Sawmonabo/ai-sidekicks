// What the keyboard page draws when the set it reads moves: rows appear and vanish as the frame
// registers and unregisters commands, and what the keyboard map's read finds stands however late
// it lands. Changes are in `KeyboardPage.rebinding.test.ts`.
import { crossMacrotaskBoundary } from "#test/helpers/macrotask-boundary.js";
import { act, render } from "@testing-library/react";
import { useEffect, useState } from "react";
import { describe, expect, it } from "vitest";
import { commandRegistry } from "#renderer/registries/commands/registry.js";
import { keybindingOverrides } from "#renderer/registries/keybindings/overrides/store.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import { LiveAnnouncerProvider } from "#renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import { drawnText } from "#test/helpers/live-region.js";
import { spiedAnnouncer } from "#test/helpers/spied-announcer.js";
import { KeyboardPage } from "./KeyboardPage.js";
import { rowOf } from "./KeyboardPage.test-support.js";

/** A command no `beforeEach` registers, so a case can register it late and with no chord. */
const LATE_COMMAND = {
  id: "bridge.copyBuildDetails",
  title: "Copy build details",
  group: "Help",
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

    expect(rowOf(container, LATE_COMMAND.title)).toBeDefined();
  });

  it("drops a row for a command that is unregistered while the page is open", async () => {
    // The same read in the other direction: a withdrawn command leaves no row behind.
    const { container, rerender } = render(
      <LiveAnnouncerProvider>
        <KeyboardPage />
      </LiveAnnouncerProvider>,
    );
    expect(rowOf(container, "Check for updates")).toBeDefined();

    commandRegistry.unregister("bridge.checkForUpdates");
    await act(async () => {
      rerender(
        <LiveAnnouncerProvider>
          <KeyboardPage />
        </LiveAnnouncerProvider>,
      );
      await crossMacrotaskBoundary();
    });

    expect(() => rowOf(container, "Check for updates")).toThrow();
  });
});

describe("keyboard page — the keyboard map read after the page opened", () => {
  it("draws the chord the read declined unsaid, and says what a later read declines", async () => {
    const said = spiedAnnouncer();
    const { container } = render(
      <LiveAnnouncerProvider announcer={said.announcer}>
        <KeyboardPage />
      </LiveAnnouncerProvider>,
    );
    expect(drawnText(container)).not.toContain("was not installed this time");

    // The stored map gives two commands one chord, so the read installs the first and declines
    // the second: a line only the read draws, landing after the page's first draw.
    await act(async () => {
      await keybindingOverrides.hydrateFrom(
        keyboardMapStoring({
          "bridge.checkForUpdates": "Alt+KeyJ",
          "frame.goToSessions": "Alt+KeyJ",
        }),
      );
      await crossMacrotaskBoundary();
    });
    expect(drawnText(container)).toContain(
      "A chord kept for Sessions was not installed this time.",
    );
    expect(said.spoken()).toStrictEqual([]);

    // The read answered, so the page has opened: a later read's new decline is a change.
    await act(async () => {
      await keybindingOverrides.hydrateFrom(
        keyboardMapStoring({
          "bridge.checkForUpdates": "Alt+KeyK",
          "frame.goToWorkflows": "Alt+KeyK",
        }),
      );
      await crossMacrotaskBoundary();
    });
    expect(said.spoken()).toStrictEqual([
      expect.stringMatching(/^A chord kept for Workflows was not installed this time\./),
    ]);
  });
});

/** Main's keyboard map holding `stored`, answering every read at once. */
function keyboardMapStoring(
  stored: Readonly<Record<string, string>>,
): PlatformBridge["keyboardMap"] {
  return {
    read: async () => await Promise.resolve({ map: stored }),
    write: async (map) => await Promise.resolve(map),
  };
}
