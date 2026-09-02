// What the ledger's structure contributes to the palette.
//
// `Spec-023 §Console Design (Meridian)` §5.15 and §5.19 give find, filters, and
// jumps as renderer-local offers, and this lane's definition of done is explicit
// that they "register palette commands through `palette/contributions.ts`, never a
// second command registry".
//
// SO THIS MODULE BUILDS VALUES AND REGISTERS NOTHING. `ConsoleCommand` and
// `KeyBinding` come from the palette's own contribution types; the ledger's frame
// registers them in the effect that owns this window's lifetime, exactly as
// `frame/frame-commands.ts` does for the frame's own. A module-scope registration
// here would run at import time, before any window exists, and could not be
// removed when one closes.
//
// EVERY COMMAND CLOSES OVER AN ACT THE CALLER SUPPLIES. None of them reaches a
// store, a bridge, or the DOM — which is what makes the whole contribution
// testable by invoking `run` and watching the act fire.

import type { ConsoleCommand, KeyBinding } from "../../palette/index.js";

/**
 * The acts the ledger's structure offers. One function per command, named for the
 * act rather than for the control that triggers it.
 */
export interface LedgerStructureActs {
  readonly openFind: () => void;
  readonly stepFindNext: () => void;
  readonly stepFindPrevious: () => void;
  readonly clearFilters: () => void;
  readonly scrollToTail: () => void;
  readonly collapseAllTerminalChapters: () => void;
  readonly toggleReplay: () => void;
  readonly jumpToNextSeam: () => void;
}

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
  ];
}
