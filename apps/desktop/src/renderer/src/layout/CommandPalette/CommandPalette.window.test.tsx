// The palette lists every match and draws only the rows in view: a long list is never cut short,
// and a highlighted row outside the window is scrolled into it.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { settle } from "@test/helpers/settle.js";
import { liveBridgeWrapper } from "@test/helpers/app/frame-fixtures.js";
import { CommandRegistry } from "@renderer/registries/commands/command-registry.js";
import { type CommandDefinition } from "@renderer/registries/commands/command-types.js";
import { CommandPalette } from "./CommandPalette.js";
import { installPaletteLayout, layOutScrollExtent } from "./CommandPalette.test-support.js";

/** Three categories, so a row's place in the list counts the headings above it. */
const GROUPS = ["Alpha", "Beta", "Gamma"] as const;

const COMMANDS_PER_GROUP = 60;

const COMMAND_COUNT = GROUPS.length * COMMANDS_PER_GROUP;

/** The last command in display order: the last category's last title. */
const LAST_COMMAND_TITLE = commandTitle("Gamma", COMMANDS_PER_GROUP - 1);

/** Zero-padded so title order is numeric order. */
function commandTitle(group: string, ordinal: number): string {
  return `${group} command ${String(ordinal).padStart(2, "0")}`;
}

function manyCommands(): CommandDefinition[] {
  return GROUPS.flatMap((group) =>
    Array.from({ length: COMMANDS_PER_GROUP }, (_unused, ordinal) => ({
      id: `test.${group}.${String(ordinal)}`,
      title: commandTitle(group, ordinal),
      group,
      run: () => undefined,
    })),
  );
}

function renderOpenPalette(): void {
  const registry = new CommandRegistry();
  registry.registerAll(manyCommands());
  render(
    <CommandPalette
      registry={registry}
      context={{
        sessionActive: false,
        onSessions: true,
        onSession: false,
        onWorkflows: false,
        onSettings: false,
      }}
      open
      onOpenChange={() => undefined}
      platform="darwin"
    />,
    { wrapper: liveBridgeWrapper() },
  );
}

function drawnOption(title: string): HTMLElement | null {
  return screen.queryByRole("option", { name: new RegExp(title, "u") });
}

describe("the palette — a list longer than the window", () => {
  installPaletteLayout();

  it("counts every match, draws a window, and scrolls an off-screen highlight in", async () => {
    renderOpenPalette();
    await settle();

    // Every match is listed: the count the footer and the live region print covers all of them.
    expect(screen.getAllByText(`${String(COMMAND_COUNT)} commands`)).not.toHaveLength(0);
    // Only the rows in view are drawn: a screenful and its overscan, far short of every match.
    const drawnCount = screen.getAllByRole("option").length;
    expect(drawnCount).toBeGreaterThan(0);
    expect(drawnCount).toBeLessThan(COMMAND_COUNT / 4);
    expect(drawnOption(LAST_COMMAND_TITLE)).toBeNull();

    // Up from the top wraps to the last match, which is far below the window.
    const scroller = screen.getByRole("listbox");
    layOutScrollExtent(scroller);
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Search commands" }), {
      key: "ArrowUp",
    });
    await settle();
    expect(scroller.scrollTop).toBeGreaterThan(0);
    // happy-dom moves `scrollTop` without firing the event a browser would.
    fireEvent.scroll(scroller);
    await settle();

    const lastOption = drawnOption(LAST_COMMAND_TITLE);
    expect(lastOption).not.toBeNull();
    expect(lastOption?.hasAttribute("data-highlighted")).toBe(true);
    expect(screen.getAllByRole("option").length).toBeLessThan(COMMAND_COUNT / 4);
  });
});
