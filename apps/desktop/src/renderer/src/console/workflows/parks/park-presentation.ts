// How a park reads on screen: what each reason is called, and which parks earn amber.
//
// HOISTED ON THE SECOND USE, which is `apps/desktop/AGENTS.md`'s rule and not a
// preference. Both lived inside `ParkBadge.tsx` while the badge was the only surface
// drawing a park; the run list's attention fold is the second, and it draws a park
// that is not one phase — a correlated wait standing for several runs — so it cannot
// reach the badge for either answer. Written twice, the label table would have named
// the same wire value two ways the first time a reason was renamed, and the tone rule
// would have spent amber on a fold the badge under it left neutral.
//
// THE TONE RULE TAKES THE READING AND NEVER REMAKES IT. `parkAwaitsPerson` is
// `runs/run-list-rows.ts`'s, decided once per park as it is projected; a fold's own
// answer is the disjunction over the parks it holds, which the fold computes. What is
// here is only the last step — the mapping from "a person is needed" onto the one
// tone rule 3 reserves for it.

import type { ChipTone } from "../../primitives/index.js";
import type { WorkflowParkReason } from "../runs/run-list-rows.js";

/**
 * What each reason is called on screen.
 *
 * Total over the closed reason set, so a third reason is a compile error here rather
 * than a phase that parks and says nothing. The labels are the console's prose — the
 * wire value is `waiting-human`, and a person reading a list wants the sentence — so
 * they are NOT mono, and every surface drawing one shows the wire string beside it.
 */
export const PARK_REASON_LABELS: Readonly<Record<WorkflowParkReason, string>> = {
  "waiting-human": "Waiting on a person",
  "provider-usage-limited": "Waiting on provider capacity",
};

/**
 * The tone a park wears, decided by whether anything will end the wait on its own.
 *
 * Amber is spent on "a person is needed" and on nothing else (rule 3), which is every
 * park that did not arm a boundary this console can read. A scheduled park is a
 * machine waiting for a machine and earns no colour; an unreadable boundary earns the
 * amber, because nothing legible says the run will resume itself.
 *
 * Takes the ANSWER rather than the schedule, so the fold — whose answer is a
 * disjunction over several parks and has no single schedule to hand over — reaches the
 * same rule as the badge, which reads one park's schedule through `parkAwaitsPerson`
 * first. A tone function that demanded a schedule would have sent the fold off to
 * write its own.
 */
export function parkAttentionTone(awaitsPerson: boolean): ChipTone {
  return awaitsPerson ? "attention" : "neutral";
}
