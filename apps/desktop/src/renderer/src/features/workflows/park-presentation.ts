// How a park reads on screen: what each reason is called, and which parks earn amber. Shared by
// the park badge and the run list's attention fold, which draws a park that is not one phase.
// `parkAwaitsPerson` in `runs/run-list-rows.ts` decides once per park; this file only maps that
// answer onto amber, the one tone reserved for a person being needed.

import type { ChipTone } from "@renderer/components/Chip/Chip.js";
import type { WorkflowParkReason } from "./runs/run-list-rows.js";

/**
 * What each reason is called on screen. Total over the closed reason set, so a new reason is a
 * compile error. The labels are prose, not mono; the wire value is `waiting-human`.
 */
export const PARK_REASON_LABELS: Readonly<Record<WorkflowParkReason, string>> = {
  "waiting-human": "Waiting on a person",
  "provider-usage-limited": "Waiting on provider capacity",
};

/**
 * The tone a park wears, decided by whether anything will end the wait on its own.
 *
 * Amber means a person is needed: every park that did not arm a boundary this console can
 * read. A scheduled park is a machine waiting for a machine and stays neutral. It takes the
 * answer rather than the schedule because the fold's answer is a disjunction over several
 * parks and has no single schedule to hand over.
 */
export function parkAttentionTone(awaitsPerson: boolean): ChipTone {
  return awaitsPerson ? "attention" : "neutral";
}
