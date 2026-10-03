// What an open palette acts on is the reading it displayed: a route change under an open palette
// must not retarget the run. The registry records the context each invocation received.

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

/** The command the palette opens over. */
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
    group: "App",
    when: "onSettings",
    run: () => {
      ledger.ran.push(SETTINGS_COMMAND_ID);
    },
  };
}

/** A registry that records the context every invocation was given. */
class RecordingCommandRegistry extends CommandRegistry {
  public readonly invokedContexts: WhenClauseContext[] = [];

  public override invoke(commandId: string, context: WhenClauseContext): CommandInvocationOutcome {
    this.invokedContexts.push(context);
    return super.invoke(commandId, context);
  }
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
 * true across the re-render, so the route moves under a palette that is still open.
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
});
