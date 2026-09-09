// The reasoning surface's model: what the four arms say, and how the tail is cut.
//
// WHY A MODEL MODULE BESIDE THE COMPONENT. The reasoning read answers a CLOSED
// four-state discriminant, and three of the four states carry no payload at all —
// the client renders the placeholder from the state itself. So the sentences ARE
// the surface for those three, and a component that spelled them inline would put
// the one thing this feature is about (that `unavailable`, `compacted`, and
// `policy_redacted` are three different facts and never one empty body) inside a
// render body where nothing can hold it total over the union. Here the table is
// total over the contract's own `availability` union by annotation, so a fifth
// state added to `@ai-sidekicks/contracts` fails to compile in this file rather
// than reaching a reader as blank space.
//
// THE THREE DISTINCTIONS THE SENTENCES MUST KEEP, which is the whole of the rule:
//
//   • `unavailable` — the surface was not captured. Nothing was withheld.
//   • `compacted`   — it WAS captured and then discarded at a compaction boundary;
//                     the durable summary beside it is what survives.
//   • `policy_redacted` — it exists and is being withheld, and the reason travels
//                     on the wire. A redaction rendered as absence is the failure
//                     this arm exists to prevent, so the copy names the withholding
//                     and the component renders `policyReason` verbatim beside it.
//
// NO PER-SESSION TOGGLE IS MODELLED, deliberately: visibility follows product
// policy and there are no session overrides, so the surface offers a read and never
// a preference. A `showReasoning` flag anywhere in this family would be a second
// answer to a question the daemon already answers.

import type { ConsoleRefusal } from "../../../core/index.js";
import type { OwnerSlotContract } from "../../../seats/index.js";
import type { ReasoningSurfaceReadResponse, RunId, TimelineRow } from "@ai-sidekicks/contracts";

/**
 * Who owns the reasoning body, what this card owes it, and where the shell dies.
 *
 * Developer-facing and never rendered, which is what `OwnerSlotContract` is for. The
 * owning task is named by its subject rather than by its governance number, on the
 * rule the sibling slots in this console state: a runtime string carries no
 * governance id, and the record that plans the work is read somewhere else.
 */
export const REASONING_SURFACE_SLOT: OwnerSlotContract = {
  owningTask: "the timeline plan's reasoning surface (the four-arm availability read)",
  mountObligation:
    "the reasoning row's body, given the row's run identity, the live text the reveal engine is publishing for it, and the reading this card holds — the card performs the read and never decides an arm of its own",
  deleteShellIn:
    "the change that authors the reasoning body deletes this shell rather than leaving it beside the body",
};

/** One arm of the contract's closed availability discriminant. */
export type ReasoningAvailability = ReasoningSurfaceReadResponse["availability"];

/**
 * How many lines of a streaming turn the tail shows.
 *
 * Three, from the density budget the console's design language sets for this row:
 * a tail while streaming and collapsed otherwise. It is a cap on what is DISPLAYED
 * and never a cap on what is published — the reveal engine's text is untouched, and
 * expanding asks the daemon rather than un-cropping this.
 */
export const REASONING_TAIL_LINE_COUNT = 3;

/**
 * The newest lines of a streaming reasoning body.
 *
 * SLIDING, which is what makes it a tail rather than a head: the window is taken
 * from the END, so a turn that has streamed four hundred lines shows the three a
 * reader is watching arrive. Blank lines are dropped before the window is taken —
 * a provider that emits paragraph breaks would otherwise spend two of the three
 * slots on nothing — and every surviving line is trimmed of trailing whitespace so
 * a partially-arrived line does not render as a ragged one.
 *
 * A pure function over the text, so the same text always cuts the same way and the
 * caller can memoize on the text's identity alone.
 */
export function reasoningTailOf(text: string): readonly string[] {
  const lines: string[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trimEnd();
    if (trimmed.length > 0) {
      lines.push(trimmed);
    }
  }
  return lines.slice(-REASONING_TAIL_LINE_COUNT);
}

/**
 * What this card holds about the reasoning read, at any moment.
 *
 * FOUR STATUSES AND NOT THREE. `not-asked` is a different fact from a read that
 * answered `unavailable`: the first says nobody put the question, the second says
 * the daemon answered it. Collapsing them would make the surface claim a provider
 * captured no reasoning every time a reader had simply not expanded the row.
 */
export type ReasoningSurfaceReading =
  | { readonly status: "not-asked" }
  | { readonly status: "reading" }
  | { readonly status: "read"; readonly response: ReasoningSurfaceReadResponse }
  | { readonly status: "refused"; readonly refusal: ConsoleRefusal };

/** What one arm says of itself when it carries no entries to show. */
export interface ReasoningArmCopy {
  /** The sentence, in the console's calm register — what happened, never a remedy. */
  readonly title: string;
  /** The second line, saying what remains readable. */
  readonly detail: string;
}

/**
 * A sentence per availability arm.
 *
 * Total over the contract's union by construction. `available` carries an entry
 * of its own because a read that succeeded and served an EMPTY page is still a
 * distinct fact from the three that carry no entries at all — the schema admits it
 * only on the terminal arm, and a reader meeting one is owed the same sentence
 * treatment as the others rather than a blank region.
 */
export const REASONING_ARM_COPY: Readonly<Record<ReasoningAvailability, ReasoningArmCopy>> = {
  available: {
    title: "This turn's reasoning was captured and this page of it is empty.",
    detail: "The read succeeded and served no entries at this position.",
  },
  unavailable: {
    title: "No reasoning was captured for this turn.",
    detail: "The provider recorded none. Nothing is being withheld here.",
  },
  compacted: {
    title: "This turn's reasoning was summarized when the context was compacted.",
    detail: "The entries were discarded at the boundary; the durable summary is what remains.",
  },
  policy_redacted: {
    title: "This turn's reasoning is withheld by policy.",
    detail: "It was captured and is not shown here. The stated reason follows.",
  },
};

/**
 * The run whose reasoning this row belongs to, or `undefined`.
 *
 * The read is RUN-SCOPED, so a row with no run attribution has nothing to ask
 * about — a `general` row, or a projection that could not attribute one. Returning
 * `undefined` rather than inventing an identifier is what keeps the expand control
 * off a row the read could never answer for, which is this surface's fail-closed
 * edge: the renderer derives no eligibility, it reports the absence of one.
 */
export function reasoningRunIdOf(row: TimelineRow): RunId | undefined {
  return row.kind === "run" ? row.runId : undefined;
}
