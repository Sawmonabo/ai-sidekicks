// What an open palette shows and what it acts on are one reading.
//
// THE FINDING. Only the scope LABEL was latched. The search still recomputed against
// the live `context` and the dispatch still handed that one to `registry.invoke`, so a
// route change under an open palette left the row saying "acting on X" over Y's rows —
// and the act that followed was evaluated against Y. Latching the label alone is worse
// than latching nothing: without it the row at least agreed with the list it sat over.
//
// THE INSTRUMENT IS THE REGISTRY, not the DOM. Which context a search or an invocation
// was performed against is a fact about the call, and reading it off the rendered list
// would prove it only for the commands that happen to differ between two contexts. The
// registry below records both, so "the rows are still X's" and "the act targeted X" are
// two assertions over the same recorded calls.
//
// AND A LATCHED SUBJECT CAN GO AWAY. The window's own commands are registered from an
// effect and removed when what they close over goes away, so a captured row can name a
// command the registry no longer holds. The dispatch used to discard `invoke`'s answer,
// which made that case look exactly like a command that ran — the palette closed and
// nothing happened. The last two cases are the typed refusal that replaced it.
//
// WHAT IS NOT HERE. The dormancy claim and the scope row's own text are
// `PaletteOverlay.dormancy.test.tsx`'s, and the highlight's warm is the preload suite's.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { settle } from "../core/settle.test-support.js";
import { CommandRegistry, type CommandInvocationOutcome } from "./command-registry.js";
import { PaletteOverlay } from "./PaletteOverlay.js";
import { type ConsoleCommand } from "./contributions.js";
import { type WhenClauseContext } from "./when-clause.js";

/** The reading a person opens the palette on: they are looking at a session workspace. */
const ON_WORKSPACE: WhenClauseContext = {
  sessionActive: true,
  onSessions: false,
  onWorkspace: true,
  onWorkflows: false,
  onSettings: false,
  inAuxiliaryWindow: false,
};

/** Where the route moves to underneath them. Every command above is hidden here. */
const ON_SETTINGS: WhenClauseContext = {
  ...ON_WORKSPACE,
  onWorkspace: false,
  onSettings: true,
};

const WORKSPACE_COMMAND_ID = "test.interruptTheRun";
const SETTINGS_COMMAND_ID = "test.openKeyboardPage";
const WORKSPACE_COMMAND_TITLE = "Interrupt the run";
const SETTINGS_COMMAND_TITLE = "Open the keyboard page";

/** Which command ran, in the order it was asked. The only thing a `run` records. */
interface RunLedger {
  readonly ran: string[];
}

/** The command the palette opens over. Its own factory, so a case can re-register it. */
function workspaceCommand(ledger: RunLedger): ConsoleCommand {
  return {
    id: WORKSPACE_COMMAND_ID,
    title: WORKSPACE_COMMAND_TITLE,
    group: "Run",
    when: "onWorkspace",
    run: () => {
      ledger.ran.push(WORKSPACE_COMMAND_ID);
    },
  };
}

/**
 * The command the route moves ONTO, offered nowhere the other one is.
 *
 * Non-overlapping on purpose: every assertion here is about WHICH reading was used, and
 * a command offered under both contexts would render identically either way.
 */
function settingsCommand(ledger: RunLedger): ConsoleCommand {
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
  return document.querySelector(".console-palette__refusal")?.textContent ?? undefined;
}

/**
 * Assert the palette asked to close, and asked for nothing else.
 *
 * The COUNT is deliberately not pinned. Selecting a row asks the combobox to close and
 * the palette asks as well, so a run produces more than one request — a number here
 * would pin a library detail, and what the case is about is that it asked at all.
 */
function expectAskedToClose(openChanges: readonly boolean[]): void {
  expect(openChanges).not.toStrictEqual([]);
  expect(openChanges.every((requested) => requested === false)).toBe(true);
}

/** Press a row the way a person does — the click the list binds, not a synthetic run. */
function pressRow(title: string): void {
  fireEvent.click(screen.getByRole("option", { name: new RegExp(title, "u") }));
}

/**
 * The palette open over the workspace, with a way to move the route under it.
 *
 * `open` stays `true` across the re-render on purpose: the frame is what closes this,
 * and holding it open is what lets a case assert that the palette did NOT ask to close.
 */
function openPaletteOverWorkspace(ledger: RunLedger): {
  readonly registry: RecordingCommandRegistry;
  readonly openChanges: boolean[];
  readonly moveRouteToSettings: () => void;
} {
  const registry = new RecordingCommandRegistry();
  registry.registerAll([workspaceCommand(ledger), settingsCommand(ledger)]);
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
    <PaletteOverlay {...shared} context={ON_WORKSPACE} scopeLabel="Session mercury" />,
  );
  return {
    registry,
    openChanges,
    moveRouteToSettings: () => {
      rerender(<PaletteOverlay {...shared} context={ON_SETTINGS} scopeLabel="Settings" />);
    },
  };
}

describe("the palette — the captured command context", () => {
  it("keeps the rows it opened with while the route moves underneath it", async () => {
    const ledger: RunLedger = { ran: [] };
    const palette = openPaletteOverWorkspace(ledger);
    await settle();
    expect(optionTitles()).toStrictEqual([WORKSPACE_COMMAND_TITLE]);

    palette.moveRouteToSettings();
    await settle();

    // The list a person is reading does not change under their hands, and every search
    // the palette performed while open was performed against the reading it opened on.
    expect(optionTitles()).toStrictEqual([WORKSPACE_COMMAND_TITLE]);
    expect(palette.registry.searchedContexts.length).toBeGreaterThan(0);
    expect(palette.registry.searchedContexts.every((searched) => searched === ON_WORKSPACE)).toBe(
      true,
    );
  });

  it("acts on the reading it displayed, not on the route it ended up over", async () => {
    // The half a rows-only assertion cannot make: a dispatch handed the live context
    // would find this command hidden and run nothing at all, silently.
    const ledger: RunLedger = { ran: [] };
    const palette = openPaletteOverWorkspace(ledger);
    await settle();
    palette.moveRouteToSettings();
    await settle();

    pressRow(WORKSPACE_COMMAND_TITLE);
    await settle();

    expect(ledger.ran).toStrictEqual([WORKSPACE_COMMAND_ID]);
    expect(palette.registry.invokedContexts).toStrictEqual([ON_WORKSPACE]);
    expect(refusalText()).toBeUndefined();
    // And it closes, which is the ordinary path this suite must not lose.
    expectAskedToClose(palette.openChanges);
  });

  it("refuses by name when the latched command is gone, and stays open over its rows", async () => {
    // The subject went away while the palette was open. Acting on the live route
    // instead would be the mis-targeting the capture exists to prevent, arriving by the
    // one path the capture does not cover.
    const ledger: RunLedger = { ran: [] };
    const palette = openPaletteOverWorkspace(ledger);
    await settle();
    palette.moveRouteToSettings();
    await settle();
    palette.registry.unregister(WORKSPACE_COMMAND_ID);

    pressRow(WORKSPACE_COMMAND_TITLE);
    await settle();

    expect(ledger.ran).toStrictEqual([]);
    // Asserted present before it is read: a palette that discarded the outcome renders
    // no row at all, and a `toContain` over nothing reports an argument-type complaint
    // rather than the absence that is the finding.
    expect(refusalText()).toBeDefined();
    expect(refusalText()).toContain("unknown-command");
    expect(refusalText()).toContain("no longer registered");
    // Still open, and the rows a person was reading are still there — the inline shape.
    expect(palette.openChanges).toStrictEqual([]);
    expect(optionTitles()).toStrictEqual([WORKSPACE_COMMAND_TITLE]);
  });

  it("negative control: an ordinary press renders no refusal and leaves none behind", async () => {
    // Without this, a palette that refused every press would satisfy the case above.
    // The second half is the clearing rule: a refusal is a fact about one press, and
    // one left standing over a later successful run would be a false report.
    const ledger: RunLedger = { ran: [] };
    const palette = openPaletteOverWorkspace(ledger);
    await settle();
    palette.registry.unregister(WORKSPACE_COMMAND_ID);
    pressRow(WORKSPACE_COMMAND_TITLE);
    await settle();
    expect(refusalText()).toBeDefined();

    palette.registry.register(workspaceCommand(ledger));
    pressRow(WORKSPACE_COMMAND_TITLE);
    await settle();

    expect(ledger.ran).toStrictEqual([WORKSPACE_COMMAND_ID]);
    expect(refusalText()).toBeUndefined();
    expectAskedToClose(palette.openChanges);
  });
});
