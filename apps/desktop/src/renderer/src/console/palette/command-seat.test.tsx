// What a surface's contribution does to this window's registry, and to the palette.
//
// Two claims, and the second is the one a hand-written effect gets wrong. The first
// is the ordinary lifecycle: rows are in the registry while the surface is mounted
// and gone when it is not. The second is that a contribution SIGNALS — the palette
// memoises its search against a revision, so a registration nothing announces is a
// command a person cannot find — and that a stale mount's teardown never clears a
// live one's rows.

import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { consoleCommands } from "./console-commands.js";
import { subscribeToConsoleKeyBindings } from "./command-surface.js";
import { useConsoleCommandSeat } from "./command-seat.js";
import type { ConsoleCommand } from "./contributions.js";

const OWNER = "command-seat-suite";

/** One inert command. The seat is about registration, not about what a command does. */
function command(id: string): ConsoleCommand {
  return {
    id,
    title: `Do ${id}`,
    group: "Suite",
    run: () => undefined,
  };
}

/** The ids this window currently holds under the suite's own namespace. */
function registeredSuiteIds(): readonly string[] {
  return consoleCommands
    .all()
    .map((entry) => entry.id)
    .filter((id) => id.startsWith("suite."));
}

describe("a surface's command seat", () => {
  it("registers on mount and removes on unmount", () => {
    const commands = [command("suite.one"), command("suite.two")];
    const mounted = renderHook(() => {
      useConsoleCommandSeat(OWNER, commands);
    });

    expect(registeredSuiteIds()).toEqual(["suite.one", "suite.two"]);

    mounted.unmount();

    expect(registeredSuiteIds()).toEqual([]);
  });

  it("tells the palette its list changed, so an open palette re-reads", () => {
    let signals = 0;
    const stopWatching = subscribeToConsoleKeyBindings(() => {
      signals += 1;
    });
    const commands = [command("suite.signalled")];
    const mounted = renderHook(() => {
      useConsoleCommandSeat(OWNER, commands);
    });

    // The contribution itself is the signal: `registerConsoleCommands` would have
    // put the row in the registry and told nobody, which is a command the open
    // palette has already memoised past.
    expect(signals).toBeGreaterThan(0);

    mounted.unmount();
    stopWatching();
  });

  it("replaces its own rows rather than raising on a duplicate id", () => {
    const first = renderHook(
      ({ commands }: { commands: readonly ConsoleCommand[] }) => {
        useConsoleCommandSeat(OWNER, commands);
      },
      { initialProps: { commands: [command("suite.one")] } },
    );

    first.rerender({ commands: [command("suite.one"), command("suite.two")] });

    expect(registeredSuiteIds()).toEqual(["suite.one", "suite.two"]);

    first.unmount();
  });

  it("leaves a live surface's rows alone when a superseded mount tears down", () => {
    // Two mounts of one surface, the second arriving before the first goes: the
    // deck can hold two panes of a kind, and development-mode React remounts one.
    // Owner-scoped replace means the second owns the rows, so the FIRST one's
    // cleanup must not take them — which is what a plain effect does, leaving a
    // living pane whose commands have silently left the palette.
    const older = renderHook(() => {
      useConsoleCommandSeat(OWNER, [command("suite.older")]);
    });
    const newer = renderHook(() => {
      useConsoleCommandSeat(OWNER, [command("suite.newer")]);
    });

    expect(registeredSuiteIds()).toEqual(["suite.newer"]);

    older.unmount();

    expect(registeredSuiteIds()).toEqual(["suite.newer"]);

    newer.unmount();

    expect(registeredSuiteIds()).toEqual([]);
  });
});
