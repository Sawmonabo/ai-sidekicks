// What the palette LATCHED when it opened, and what running against it costs.
//
// THE ROW AND THE ACT ARE ONE READING. The scoped-context row names what these
// commands act on, and the `when`-clause context decides which commands are offered
// and what `invoke` is evaluated against. Latching only the row is worse than
// latching nothing: a person reads "acting on X", the route moves to Y underneath
// them, and the list silently becomes Y's while the row still says X — so the palette
// captures ONE reading, the label beside the context, and the search, the count, the
// printed chords, and the dispatch all consume that one.
//
// AND A LATCHED READING CAN GO STALE, WHICH IS WHY THE OUTCOME IS READ. A frozen
// context cannot notice that its subject is gone: the window's own commands are
// registered from an effect and removed when what they close over goes away, so the
// row a person is looking at may name a command the registry no longer holds. The
// dispatch used to discard `invoke`'s answer entirely, which made that case
// indistinguishable from a command that ran — the palette closed, and nothing
// happened. It is read here and turned into the console's one refusal shape, so the
// palette can render it beside the rows that are still on screen.
//
// WHY THE REFUSAL IS NOT A SECOND ELIGIBILITY RULE. Nothing here re-derives whether a
// command may run. `CommandRegistry.invoke` decides, against the latched context and
// nothing else, and this module only names what it decided — the registry stays the
// one source of truth for eligibility, which is the rule that file states about
// itself.

import { refuse, type ConsoleRefusal } from "../core/index.js";
import type { CommandInvocationOutcome, CommandRegistry } from "./command-registry.js";
import type { WhenClauseContext } from "./when-clause.js";

/**
 * The reading captured at the open transition.
 *
 * `wasOpen` is which side of the transition the reading belongs to, so the capture can
 * be adjusted during render rather than in an effect — an effect runs after the commit,
 * so the first frame of an open palette would show the last reading it was open with.
 * The other two fields are the reading itself, and they travel together because a label
 * and a context that disagreed would be exactly the mis-targeting the capture prevents.
 */
export interface LatchedPaletteScope {
  readonly wasOpen: boolean;
  readonly scopeLabel: string | undefined;
  readonly context: WhenClauseContext;
}

/** The subsystem name every refusal this module raises carries. */
export const PALETTE_INVOCATION_REFUSAL_ORIGIN = "palette";

/**
 * Why the palette did not run the row a person pressed.
 *
 * Exactly the registry's non-running outcomes, DERIVED rather than restated. A
 * hand-written copy would let a third refusal status land on `CommandInvocationOutcome`
 * and be silently relabelled here as one of these two — a refusal naming the wrong
 * reason, which is worse than none. The same derivation `KeyBindingDispatch` takes for
 * the same registry, for the same reason.
 */
export type PaletteInvocationRefusalCode = Exclude<CommandInvocationOutcome["status"], "ran">;

/**
 * A typed refusal — the console's one refusal shape, narrowed on `code`.
 *
 * `core/refusal.ts` states the arrangement: each producer keeps its own closed code
 * union and widens at its boundary, so this renders through the same three refusal
 * renderings as a shell block or a persistence refusal, with no translation where two
 * of them are shown at once.
 */
export interface PaletteInvocationRefusal extends ConsoleRefusal {
  readonly code: PaletteInvocationRefusalCode;
}

/**
 * What pressing a row came to.
 *
 * A closed pair rather than a boolean, because the row's own module has to act on it:
 * selecting an item is what closes the combobox, so a row whose command did not run
 * must not be selected — and `false` at that call site would read as "do not select"
 * rather than as "it did not run", which is the fact the palette actually has.
 */
export type PaletteRowPressOutcome = "ran" | "refused";

/**
 * What each refusal says, and both sentences name the same next move.
 *
 * Reopening is the remedy because it is the only act that takes a fresh reading: the
 * capture is deliberately immutable for as long as the palette is open, so a person
 * whose subject went away underneath them cannot be given a working list without one.
 * Neither sentence claims to know WHY the subject went away — the palette cannot, and
 * a guess printed here would be the renderer inventing a cause.
 */
const REFUSAL_DETAIL: Readonly<Record<PaletteInvocationRefusalCode, string>> = {
  "unknown-command":
    "That command is no longer registered, so the palette did not run it; close and reopen the palette to act on what is here now.",
  "hidden-in-context":
    "That command is not offered in the scope this palette opened over, so it did not run; close and reopen the palette to act on the current scope.",
};

/**
 * Run one command against the reading the palette latched, never against the live one.
 *
 * Returns the refusal, or `undefined` where the command ran — the shape
 * `cleanupFailure` takes for the same reason: every caller is deciding whether to SHOW
 * something, and an absent refusal is the ordinary path rather than a value to unwrap.
 *
 * The command's own promise is deliberately not returned. The registry hands it back so
 * a synchronous throw inside `run` cannot abort a key dispatch, and the palette must not
 * hold the dialog open waiting on a command that opens another surface — a rejection is
 * the command's to report on its own surface, so it is not swallowed here silently, it
 * simply is not the palette's to render.
 */
export function runLatchedCommand(
  registry: CommandRegistry,
  commandId: string,
  latchedContext: WhenClauseContext,
): PaletteInvocationRefusal | undefined {
  const outcome = registry.invoke(commandId, latchedContext);
  if (outcome.status === "ran") {
    return undefined;
  }
  return refuse(PALETTE_INVOCATION_REFUSAL_ORIGIN, outcome.status, REFUSAL_DETAIL[outcome.status]);
}
