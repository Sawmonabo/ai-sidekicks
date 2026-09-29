// What the palette offers for the pane layout: the five rows and the chord they do not claim.

import { describe, expect, it } from "vitest";

import type {
  ConsoleCommand,
  ConsoleCommandSurface,
  KeyBinding,
} from "@renderer/console/palette/index.js";
import { MountedDeckSeat } from "../pane-layout/mounted-pane-layouts.js";
import { createSpyingPaneLayoutActs } from "../pane-layout/pane-layout-acts.test-support.js";
import { DECK_COMMAND_OWNER, deckPaletteCommands, registerDeckCommands } from "./commands.js";

/** What a contribution is, read off the door rather than named a second time. */
type RecordedContribution = Parameters<ConsoleCommandSurface["contribute"]>[0];

/** The release a contribution hands back, read off the door for the same reason. */
type ContributionRelease = ReturnType<ConsoleCommandSurface["contribute"]>;

/** A surface that records what a family contributed, rather than a window's registry. */
class RecordingCommandSurface implements ConsoleCommandSurface {
  contribution: RecordedContribution | undefined;

  public contribute(contribution: RecordedContribution): ContributionRelease {
    this.contribution = contribution;
    // The release RETRACTS, which is what the real surface's does. A recorder that
    // handed back a no-op would let a case assert a released contribution was still
    // held and pass, which is the one thing the release exists to prevent.
    return () => {
      if (this.contribution === contribution) {
        this.contribution = undefined;
      }
    };
  }
}

function commandById(commands: readonly ConsoleCommand[], id: string): ConsoleCommand {
  const command = commands.find((candidate) => candidate.id === id);
  expect(command).not.toBeUndefined();
  return command as ConsoleCommand;
}

describe("the deck's palette rows", () => {
  it("offers all five pane acts, each scoped to a window with a session", () => {
    const commands = deckPaletteCommands(createSpyingPaneLayoutActs());
    expect(commands.map((command) => command.id)).toStrictEqual([
      "deck.focusNextPane",
      "deck.focusPreviousPane",
      "deck.closePane",
      "deck.movePaneLeft",
      "deck.movePaneRight",
    ]);
    for (const command of commands) {
      expect(command.when).toBe("sessionActive");
    }
  });

  it("runs the act the row names", () => {
    const deckActs = createSpyingPaneLayoutActs();
    const commands = deckPaletteCommands(deckActs);
    commandById(commands, "deck.focusNextPane").run();
    commandById(commands, "deck.focusPreviousPane").run();
    commandById(commands, "deck.closePane").run();
    commandById(commands, "deck.movePaneLeft").run();
    commandById(commands, "deck.movePaneRight").run();
    expect(deckActs.focusNextPane).toHaveBeenCalledTimes(1);
    expect(deckActs.focusPreviousPane).toHaveBeenCalledTimes(1);
    expect(deckActs.closeFocusedPane).toHaveBeenCalledTimes(1);
    expect(deckActs.moveFocusedPaneLeft).toHaveBeenCalledTimes(1);
    expect(deckActs.moveFocusedPaneRight).toHaveBeenCalledTimes(1);
  });

  it("claims no chord, because the deck binds these five on its own element", () => {
    // The module's own reasoning, pinned: a window-table binding installs in the
    // capture phase and consumes any press whose command ran, so it would preempt the
    // deck's wide editable-target guard and eat a listbox's arrow keys.
    const surface = new RecordingCommandSurface();
    registerDeckCommands(surface, new MountedDeckSeat());
    expect(surface.contribution?.owner).toBe(DECK_COMMAND_OWNER);
    expect(surface.contribution?.keyBindings).toStrictEqual([] as readonly KeyBinding[]);
  });
});
