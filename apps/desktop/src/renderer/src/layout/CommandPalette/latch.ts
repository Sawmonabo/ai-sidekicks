// What the palette latched when it opened, and what running a command against it costs.
//
// The scope label and the `when` context are one reading: search, count, printed chords and
// dispatch all use it, so the row never names X while the list is Y's. A latched reading can go
// stale (a command may be unregistered while its row is on screen), so the dispatch outcome is
// read and turned into the app's refusal shape. The registry alone decides eligibility.

import { refuse, type Refusal } from "#renderer/lib/refusal/contract.js";
import type {
  CommandInvocationOutcome,
  CommandRegistry,
} from "#renderer/registries/commands/registry.js";
import type { WhenClauseContext } from "#renderer/registries/commands/when-clause/semantics.js";

/**
 * The reading captured at the open transition. `wasOpen` records which side of the transition it
 * belongs to, so the capture can be adjusted during render; the label and context travel together.
 */
export interface LatchedPaletteScope {
  readonly wasOpen: boolean;
  readonly scopeLabel: string | undefined;
  readonly context: WhenClauseContext;
}

/** The subsystem name every palette refusal carries as its origin. */
export const PALETTE_INVOCATION_REFUSAL_ORIGIN = "palette";

/**
 * Why the palette did not run the row a person pressed: the registry's non-running outcomes,
 * derived so a new outcome status cannot be silently relabeled as one of these.
 */
export type PaletteInvocationRefusalCode = Exclude<CommandInvocationOutcome["status"], "ran">;

/** A typed refusal in the app's one refusal shape, narrowed on `code`. */
export interface PaletteInvocationRefusal extends Refusal {
  readonly code: PaletteInvocationRefusalCode;
}

/**
 * What pressing a row came to. A closed pair rather than a boolean: a row whose command did not
 * run must not be selected, and `false` would read as "do not select".
 */
export type PaletteRowPressOutcome = "ran" | "refused";

/**
 * What each refusal says, both naming the same next move: reopen the palette, the only act that
 * takes a fresh reading. The `unavailable` arm is absent because its owner supplies the sentence.
 * Neither sentence guesses why the subject went away.
 */
const REFUSAL_DETAIL: Readonly<
  Record<Exclude<PaletteInvocationRefusalCode, "unavailable">, string>
> = {
  "unknown-command":
    "That command is gone, so the palette did not run it; close and reopen the palette to act " +
    "on what is here now.",
  "hidden-in-context":
    "That command does not apply here any more, so it did not run; close and reopen the " +
    "palette to act on what is here now.",
};

/**
 * Runs one command against the latched reading, never the live one. Returns the refusal, or
 * `undefined` when it ran. The command's own promise is not returned: the palette must not hold
 * the dialog open on a command that opens another view, and a rejection is the command's to report.
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
  const detail = outcome.status === "unavailable" ? outcome.reason : REFUSAL_DETAIL[outcome.status];
  return refuse(PALETTE_INVOCATION_REFUSAL_ORIGIN, outcome.status, detail);
}
