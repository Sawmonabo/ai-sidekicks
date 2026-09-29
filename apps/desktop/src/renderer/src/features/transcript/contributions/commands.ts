// What the transcript contributes to the command registry: its commands, built from the
// acts of whichever transcript is mounted when one is pressed.
//
// The commands are contributed when the window composes, so they are in the palette and
// their chords in the binding table from the first frame. What they act on is resolved at
// press time through `mounted-transcript.ts`; with none mounted the act states its refusal
// on the frame's banner rather than doing nothing. Every command closes over an act the
// caller supplies and reaches no store, bridge or DOM, so invoking `run` is the test.

import {
  raiseConsoleActRefusal,
  type ConsoleCommand,
  type ConsoleCommandSurface,
} from "@renderer/console/palette/index.js";
import {
  mountedLedger,
  type LedgerActName,
  type LedgerStructureActs,
  type MountedLedgerSeat,
} from "../mounted-transcript.js";
import { LEDGER_KEY_BINDINGS, WHEN_SESSION_ACTIVE } from "./keybindings.js";

/**
 * The palette group every one of these rows sits under.
 *
 * One binding rather than a literal per command: the group is also a secondary
 * match field, so two spellings of it would split the ledger's own commands across
 * two categories in the palette's category list.
 */
export const LEDGER_COMMAND_GROUP = "Ledger";

/**
 * Build this window's ledger commands.
 *
 * A function of the acts rather than a constant, because every `run` closes over
 * one window's transcript.
 */
export function ledgerStructureCommands(acts: LedgerStructureActs): readonly ConsoleCommand[] {
  return [
    {
      id: "ledger.find",
      title: "Find in ledger",
      group: LEDGER_COMMAND_GROUP,
      when: WHEN_SESSION_ACTIVE,
      keywords: ["search", "grep"],
      run: acts.openFind,
    },
    {
      id: "ledger.findNext",
      title: "Go to next match",
      group: LEDGER_COMMAND_GROUP,
      when: WHEN_SESSION_ACTIVE,
      run: acts.stepFindNext,
    },
    {
      id: "ledger.findPrevious",
      title: "Go to previous match",
      group: LEDGER_COMMAND_GROUP,
      when: WHEN_SESSION_ACTIVE,
      run: acts.stepFindPrevious,
    },
    {
      id: "ledger.scrollToTail",
      title: "Scroll to the latest row",
      group: LEDGER_COMMAND_GROUP,
      when: WHEN_SESSION_ACTIVE,
      keywords: ["follow", "bottom", "live"],
      run: acts.scrollToTail,
    },
    {
      id: "ledger.collapseTerminalChapters",
      title: "Collapse all finished run chapters",
      group: LEDGER_COMMAND_GROUP,
      when: WHEN_SESSION_ACTIVE,
      keywords: ["fold", "chapters", "runs"],
      run: acts.collapseAllTerminalChapters,
    },
  ];
}

/**
 * The owner string this family's command contribution carries.
 *
 * The same string its surface and pane claims carry, and for the same reason: the
 * contribution door is owner-scoped, so composing twice — a hot reload, a second
 * test — replaces this family's rows instead of raising on their ids.
 */
export const LEDGER_COMMAND_OWNER = "ledger";

/**
 * Contribute the ledger's commands and chords to a window.
 *
 * Takes the surface rather than reaching for the module-scope one, so a test contributes
 * into a surface it owns.
 */
export function registerLedgerCommands(
  surface: ConsoleCommandSurface,
  seat: MountedLedgerSeat = mountedLedger,
): void {
  surface.contribute({
    owner: LEDGER_COMMAND_OWNER,
    commands: ledgerStructureCommands(actsOnTheMountedLedger(seat)),
    keyBindings: LEDGER_KEY_BINDINGS,
  });
}

/**
 * The act set every contributed command runs through.
 *
 * Written out rather than derived from a name list, so an act added to
 * `LedgerStructureActs` fails to compile here, at the seat's forwarder and at the feed's
 * builder together, instead of being contributed as a command that reaches nothing.
 */
function actsOnTheMountedLedger(seat: MountedLedgerSeat): LedgerStructureActs {
  const perform = (act: LedgerActName): void => {
    performOnMountedLedger(seat, act);
  };
  return {
    openFind: () => {
      perform("openFind");
    },
    stepFindNext: () => {
      perform("stepFindNext");
    },
    stepFindPrevious: () => {
      perform("stepFindPrevious");
    },
    scrollToTail: () => {
      perform("scrollToTail");
    },
    collapseAllTerminalChapters: () => {
      perform("collapseAllTerminalChapters");
    },
  };
}

/**
 * Perform one act, and state the refusal where a person can see it.
 *
 * The banner is the only rendering available to an act with no surface of its own,
 * which is what a transcript command pressed from a window with no transcript is.
 */
function performOnMountedLedger(seat: MountedLedgerSeat, act: LedgerActName): void {
  const outcome = seat.perform(act);
  if (outcome.status === "refused") {
    raiseConsoleActRefusal(outcome.refusal);
  }
}
