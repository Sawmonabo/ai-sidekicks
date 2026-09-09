// What the palette offers for the deck, and what a press reaches when none is mounted.
//
// The refusal arm is the half that fails silently: a row run from a window with no
// deck has nothing to act on, and a command that quietly did nothing would be
// indistinguishable from one that ran.

import { describe, expect, it, vi, type Mock } from "vitest";

import type { ConsoleCommand, ConsoleCommandSurface, KeyBinding } from "../../../palette/index.js";

import type { DeckActs } from "./deck-acts.js";
import {
  DECK_COMMAND_OWNER,
  DECK_NOT_MOUNTED_REFUSAL,
  MountedDeckSeat,
  deckPaletteCommands,
  registerDeckCommands,
} from "./deck-command-seat.js";

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

/** One deck's acts, each a spy, so a case can say which surface performed. */
interface SpyingDeckActs extends DeckActs {
  readonly focusNextPane: Mock<() => void>;
  readonly focusPreviousPane: Mock<() => void>;
  readonly closeFocusedPane: Mock<() => void>;
  readonly moveFocusedPaneLeft: Mock<() => void>;
  readonly moveFocusedPaneRight: Mock<() => void>;
}

function acts(): SpyingDeckActs {
  return {
    focusNextPane: vi.fn<() => void>(),
    focusPreviousPane: vi.fn<() => void>(),
    closeFocusedPane: vi.fn<() => void>(),
    moveFocusedPaneLeft: vi.fn<() => void>(),
    moveFocusedPaneRight: vi.fn<() => void>(),
  };
}

function commandById(commands: readonly ConsoleCommand[], id: string): ConsoleCommand {
  const command = commands.find((candidate) => candidate.id === id);
  expect(command).not.toBeUndefined();
  return command as ConsoleCommand;
}

describe("the deck's palette rows", () => {
  it("offers all five pane acts, each scoped to a window with a session", () => {
    const commands = deckPaletteCommands(acts());
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
    const deckActs = acts();
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

describe("which deck a command acts on", () => {
  it("performs on the newest mounted deck", () => {
    const seat = new MountedDeckSeat();
    const first = acts();
    const second = acts();
    seat.adopt(first);
    seat.adopt(second);

    expect(seat.perform("focusNextPane")).toStrictEqual({
      status: "performed",
      act: "focusNextPane",
    });
    expect(second.focusNextPane).toHaveBeenCalledTimes(1);
    expect(first.focusNextPane).not.toHaveBeenCalled();
  });

  it("releases by identity, so an earlier unmount does not drop the newest", () => {
    const seat = new MountedDeckSeat();
    const first = acts();
    const second = acts();
    const releaseFirst = seat.adopt(first);
    seat.adopt(second);
    releaseFirst();

    seat.perform("closeFocusedPane");
    expect(second.closeFocusedPane).toHaveBeenCalledTimes(1);
  });

  it("refuses rather than doing nothing when no deck is mounted", () => {
    const outcome = new MountedDeckSeat().perform("focusNextPane");
    expect(outcome).toStrictEqual({ status: "refused", refusal: DECK_NOT_MOUNTED_REFUSAL });
  });

  it("negative control: a seat holding one deck performs rather than refusing", () => {
    // Without this the case above would pass over a seat that refused every press.
    const seat = new MountedDeckSeat();
    seat.adopt(acts());
    expect(seat.perform("focusNextPane").status).toBe("performed");
  });
});
