// What an open palette shows and what it acts on are one reading: a route change under an open
// palette must neither change the rows nor retarget the run. The registry records the context each
// search and invocation received, which proves the reading used for every command, not just those
// that differ between contexts. The last two cases cover a latched command leaving the registry.
// The dormancy and scope-row claims are in `CommandPalette.dormancy.test.tsx`.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { settle } from "@test/helpers/settle.js";
import {
  type CommandInvocationOutcome,
  CommandRegistry,
} from "@renderer/registries/commands/command-registry.js";
import { type CommandDefinition } from "@renderer/registries/commands/command-types.js";
import { CommandPalette } from "./CommandPalette.js";
import type { WhenClauseContext } from "@renderer/registries/commands/when-clause/when-clause.js";

/** The reading the palette opens on: a session screen. */
const ON_SESSION: WhenClauseContext = {
  sessionActive: true,
  onSessions: false,
  onSession: true,
  onWorkflows: false,
  onSettings: false,
};

/** Where the route moves to underneath the open palette; every command above is hidden here. */
const ON_SETTINGS: WhenClauseContext = {
  ...ON_SESSION,
  onSession: false,
  onSettings: true,
};

const SESSION_COMMAND_ID = "test.interruptTheRun";
const SETTINGS_COMMAND_ID = "test.openKeyboardPage";
const SESSION_COMMAND_TITLE = "Interrupt the run";
const SETTINGS_COMMAND_TITLE = "Open the keyboard page";

/** Which commands ran, in order. */
interface RunLedger {
  readonly ran: string[];
}

/** The command the palette opens over; a factory so a case can re-register it. */
function sessionCommand(ledger: RunLedger): CommandDefinition {
  return {
    id: SESSION_COMMAND_ID,
    title: SESSION_COMMAND_TITLE,
    group: "Run",
    when: "onSession",
    run: () => {
      ledger.ran.push(SESSION_COMMAND_ID);
    },
  };
}

/**
 * The command the route moves onto, offered nowhere the other one is. Non-overlapping so a
 * command offered in both contexts cannot render identically under either reading.
 */
function settingsCommand(ledger: RunLedger): CommandDefinition {
  return {
    id: SETTINGS_COMMAND_ID,
    title: SETTINGS_COMMAND_TITLE,
    group: "Navigate",
    when: "onSettings",
    run: () => {
      ledger.ran.push(SETTINGS_COMMAND_ID);
    },
  };
}

/** A registry that records the context every search and every invocation was given. */
class RecordingCommandRegistry extends CommandRegistry {
  public readonly searchedContexts: WhenClauseContext[] = [];
  public readonly invokedContexts: WhenClauseContext[] = [];

  public override search(
    query: string,
    context: WhenClauseContext,
  ): ReturnType<CommandRegistry["search"]> {
    this.searchedContexts.push(context);
    return super.search(query, context);
  }

  public override invoke(commandId: string, context: WhenClauseContext): CommandInvocationOutcome {
    this.invokedContexts.push(context);
    return super.invoke(commandId, context);
  }
}

/** Every row the palette is offering, by its accessible name. */
function optionTitles(): readonly string[] {
  return screen.getAllByRole("option").map((option) => option.textContent ?? "");
}

/** The refusal the palette rendered inline, or `undefined` where it rendered none. */
function refusalText(): string | undefined {
  return document.querySelector(".command-palette__refusal")?.textContent ?? undefined;
}

/**
 * Asserts the palette asked to close and asked for nothing else. The count is not pinned: the
 * combobox and the palette each request a close, and how many is a library detail.
 */
function expectAskedToClose(openChanges: readonly boolean[]): void {
  expect(openChanges).not.toStrictEqual([]);
  expect(openChanges.every((requested) => requested === false)).toBe(true);
}

/** Presses a row through the click the list binds, as a person does. */
function pressRow(title: string): void {
  fireEvent.click(screen.getByRole("option", { name: new RegExp(title, "u") }));
}

/**
 * The palette open over the session screen, with a way to move the route under it. `open` stays
 * true across the re-render so a case can assert the palette did not ask to close.
 */
function openPaletteOverSession(ledger: RunLedger): {
  readonly registry: RecordingCommandRegistry;
  readonly openChanges: boolean[];
  readonly moveRouteToSettings: () => void;
} {
  const registry = new RecordingCommandRegistry();
  registry.registerAll([sessionCommand(ledger), settingsCommand(ledger)]);
  const openChanges: boolean[] = [];
  const shared = {
    registry,
    open: true,
    onOpenChange: (nextOpen: boolean) => {
      openChanges.push(nextOpen);
    },
    platform: "darwin" as const,
  };
  const { rerender } = render(
    <CommandPalette {...shared} context={ON_SESSION} scopeLabel="Session mercury" />,
  );
  return {
    registry,
    openChanges,
    moveRouteToSettings: () => {
      rerender(<CommandPalette {...shared} context={ON_SETTINGS} scopeLabel="Settings" />);
    },
  };
}

describe("the palette — the captured command context", () => {
  it("keeps the rows it opened with while the route moves underneath it", async () => {
    const ledger: RunLedger = { ran: [] };
    const palette = openPaletteOverSession(ledger);
    await settle();
    expect(optionTitles()).toStrictEqual([SESSION_COMMAND_TITLE]);

    palette.moveRouteToSettings();
    await settle();

    // The list does not change under a person's hands; every search used the opening reading.
    expect(optionTitles()).toStrictEqual([SESSION_COMMAND_TITLE]);
    expect(palette.registry.searchedContexts.length).toBeGreaterThan(0);
    expect(palette.registry.searchedContexts.every((searched) => searched === ON_SESSION)).toBe(
      true,
    );
  });

  it("acts on the reading it displayed, not on the route it ended up over", async () => {
    // A dispatch handed the live context would find this command hidden and run nothing.
    const ledger: RunLedger = { ran: [] };
    const palette = openPaletteOverSession(ledger);
    await settle();
    palette.moveRouteToSettings();
    await settle();

    pressRow(SESSION_COMMAND_TITLE);
    await settle();

    expect(ledger.ran).toStrictEqual([SESSION_COMMAND_ID]);
    expect(palette.registry.invokedContexts).toStrictEqual([ON_SESSION]);
    expect(refusalText()).toBeUndefined();
    // And it closes: the ordinary path.
    expectAskedToClose(palette.openChanges);
  });

  it("refuses by name when the latched command is gone, and stays open over its rows", async () => {
    // The command left the registry while the palette was open; the live route must not stand in.
    const ledger: RunLedger = { ran: [] };
    const palette = openPaletteOverSession(ledger);
    await settle();
    palette.moveRouteToSettings();
    await settle();
    palette.registry.unregister(SESSION_COMMAND_ID);

    pressRow(SESSION_COMMAND_TITLE);
    await settle();

    expect(ledger.ran).toStrictEqual([]);
    // Asserted present first: with no refusal row, `toContain` fails with an argument-type error.
    expect(refusalText()).toBeDefined();
    expect(refusalText()).toContain("unknown-command");
    expect(refusalText()).toContain("no longer registered");
    // Still open with the rows in place: the inline shape.
    expect(palette.openChanges).toStrictEqual([]);
    expect(optionTitles()).toStrictEqual([SESSION_COMMAND_TITLE]);
  });

  it("negative control: an ordinary press renders no refusal and leaves none behind", async () => {
    // Without this, a palette that refused every press would pass the case above. A refusal is
    // about one press, so one left over a later successful run would be false.
    const ledger: RunLedger = { ran: [] };
    const palette = openPaletteOverSession(ledger);
    await settle();
    palette.registry.unregister(SESSION_COMMAND_ID);
    pressRow(SESSION_COMMAND_TITLE);
    await settle();
    expect(refusalText()).toBeDefined();

    palette.registry.register(sessionCommand(ledger));
    pressRow(SESSION_COMMAND_TITLE);
    await settle();

    expect(ledger.ran).toStrictEqual([SESSION_COMMAND_ID]);
    expect(refusalText()).toBeUndefined();
    expectAskedToClose(palette.openChanges);
  });
});
