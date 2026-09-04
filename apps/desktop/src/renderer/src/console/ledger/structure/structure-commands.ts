// What the ledger's structure contributes to the palette.
//
// `Spec-023 §Signature Feature Composition Sketches`' Timeline View lists the ledger's
// interactions — "scroll-to-tail, jump-to-event-by-ID, filter-by-participant /
// event-type" — and find sits beside them under `find-model.ts`. All of them are
// renderer-local offers, and this console registers every one of them as a palette
// command through `palette/contributions.ts` and never through a second command
// registry.
//
// THE VALUES ARE BUILT HERE AND CONTRIBUTED THROUGH THE FRAME'S OWN DOOR.
// `ConsoleCommand` and `KeyBinding` come from the palette's contribution types, and
// `registerLedgerCommands` hands both to `frame/command-surface.ts` — the same door
// the frame's own commands go through, and the same shape as this family's surface
// and pane claims: the family registers itself, and the frame names no family.
// Building the list and contributing it stay separate functions, because a caller
// that holds one window's acts (a test, a story) wants the values without the
// registration.
//
// WHY THE CONTRIBUTION IS COMPOSITION-TIME AND THE TARGET IS NOT. The commands are
// contributed when the console composes, so they are in the palette and their
// chords are in the binding table from the first frame. What they ACT on is
// whichever ledger is mounted when the key is pressed, resolved through
// `mounted-ledger.ts`; with none mounted the act states its refusal on the frame's
// banner rather than doing nothing.
//
// EVERY COMMAND CLOSES OVER AN ACT THE CALLER SUPPLIES. None of them reaches a
// store, a bridge, or the DOM — which is what makes the whole contribution
// testable by invoking `run` and watching the act fire.

import { raiseConsoleActRefusal, type ConsoleCommandSurface } from "../../frame/command-surface.js";
import type { ConsoleCommand, KeyBinding } from "../../palette/index.js";
import {
  mountedLedger,
  type LedgerActName,
  type LedgerStructureActs,
  type MountedLedgerSeat,
} from "./mounted-ledger.js";

/**
 * The palette group every one of these rows sits under.
 *
 * One binding rather than a literal per command: the group is also a secondary
 * match field, so two spellings of it would split the ledger's own commands across
 * two categories in the palette's category list.
 */
export const LEDGER_COMMAND_GROUP = "Ledger";

/**
 * The `when` clause every ledger command carries.
 *
 * Fail-closed by construction: the palette's clause evaluator answers `false` for
 * a key the context does not carry, so a window with no session offers none of
 * these rather than offering acts with nothing to act on.
 */
const WHEN_SESSION_ACTIVE = "sessionActive";

/**
 * The chords the ledger claims.
 *
 * `$mod` is Cmd on macOS and Ctrl elsewhere, which the palette's chord vocabulary
 * fixes. `allowInTextInput` is left off everywhere: none of these is a chord a
 * person wants firing while they are composing a message, and the asymmetry the
 * binding type names — a wrongly-firing chord destroys text, a wrongly-declining
 * one costs a menu — decides it.
 */
export const LEDGER_KEY_BINDINGS: readonly KeyBinding[] = [
  { chord: "$mod+f", commandId: "ledger.find", when: WHEN_SESSION_ACTIVE },
  { chord: "$mod+g", commandId: "ledger.findNext", when: WHEN_SESSION_ACTIVE },
  { chord: "$mod+Shift+g", commandId: "ledger.findPrevious", when: WHEN_SESSION_ACTIVE },
  { chord: "$mod+Shift+t", commandId: "ledger.scrollToTail", when: WHEN_SESSION_ACTIVE },
];

/**
 * Build this window's ledger commands.
 *
 * A function of the acts rather than a constant, because every `run` closes over
 * one window's ledger — the same reason `frame/frame-commands.ts` builds its list
 * in a hook instead of declaring it at module scope.
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
      id: "ledger.clearFilters",
      title: "Clear ledger filters",
      group: LEDGER_COMMAND_GROUP,
      when: WHEN_SESSION_ACTIVE,
      keywords: ["participant", "family", "unfilter"],
      run: acts.clearFilters,
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
    {
      id: "ledger.toggleReplay",
      title: "Play or pause session replay",
      group: LEDGER_COMMAND_GROUP,
      when: WHEN_SESSION_ACTIVE,
      keywords: ["replay", "scrub", "rewatch"],
      run: acts.toggleReplay,
    },
    {
      id: "ledger.jumpToNextSeam",
      title: "Jump to the next seam",
      group: LEDGER_COMMAND_GROUP,
      when: WHEN_SESSION_ACTIVE,
      keywords: ["compaction", "rollback", "switch"],
      run: acts.jumpToNextSeam,
    },
    {
      id: "ledger.replayFromRowInView",
      title: "Replay from the row in view",
      group: LEDGER_COMMAND_GROUP,
      when: WHEN_SESSION_ACTIVE,
      keywords: ["replay", "here", "rewatch"],
      run: acts.replayFromRowInView,
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
 * Takes the surface rather than reaching for the module-scope door, for
 * `registerLedger`'s reason: a test contributes into a surface it owns, and an
 * auxiliary window could contribute a subset without a second code path.
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
 * Written out rather than derived from a name list, so a TENTH act added to
 * `LedgerStructureActs` fails to compile here instead of being contributed as a
 * command that reaches the mounted ledger through nothing. That fence is what the
 * ninth act just walked through: adding "replay from the row in view" failed to
 * compile at this site, at the seat's forwarder and at the feed's builder together,
 * which is the registered path rather than a prohibition.
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
    clearFilters: () => {
      perform("clearFilters");
    },
    scrollToTail: () => {
      perform("scrollToTail");
    },
    collapseAllTerminalChapters: () => {
      perform("collapseAllTerminalChapters");
    },
    toggleReplay: () => {
      perform("toggleReplay");
    },
    jumpToNextSeam: () => {
      perform("jumpToNextSeam");
    },
    replayFromRowInView: () => {
      perform("replayFromRowInView");
    },
  };
}

/**
 * Perform one act, and state the refusal where a person can see it.
 *
 * The banner is rule 9's third rendering and the only one available to an act with
 * no surface of its own — which is exactly what a ledger command pressed from a
 * window with no ledger is.
 */
function performOnMountedLedger(seat: MountedLedgerSeat, act: LedgerActName): void {
  const outcome = seat.perform(act);
  if (outcome.status === "refused") {
    raiseConsoleActRefusal(outcome.refusal);
  }
}
