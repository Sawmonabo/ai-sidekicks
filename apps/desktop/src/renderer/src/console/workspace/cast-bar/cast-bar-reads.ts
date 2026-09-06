// The three reads the cast bar puts, and the one shape all three settle into.
//
// WHY THE BAR READS ANYTHING AT ALL. The session store answers what the LOG says —
// who joined, what they did, when. Three of the things the bar has to render are not
// in the log and never will be: a session's display title and its state are
// projections the daemon serves, the node's health is a measurement, and the
// committed spend is one accountant's figure that `Spec-023 §Rules every console
// surface obeys` forbids this renderer to compute. Each is a read, and each is on the
// growth slate.
//
// ONE PROJECTION FOR THREE READS, because they differ in exactly one thing — which
// operation is called — and in nothing else. Each is a one-shot read keyed on the
// port and its subject, each settles through the console's single read chokepoint,
// and each renders the same three facts: nobody has answered yet, here is the answer,
// or here is why there is none. Three hand-written copies of that would be three
// places for the discarded-answer bug the chokepoint exists to prevent.
//
// AND NO POLLING. The read is put once per subject, from the effect the chokepoint
// arms, and again only when the port or the subject moves. A bar that refreshed its
// own spend on a timer would be a second cadence beside the event stream, which
// `apps/desktop/AGENTS.md` §Chokepoints forbids by name.

import {
  useSettledGrowthRead,
  type GrowthPort,
  type SettledReadRefusal,
} from "../../bridge/index.js";

/**
 * What the bar knows about one of its reads at one moment.
 *
 * `unasked` is deliberately absent, and its absence is the whole reason this is not
 * the four-state seed rule: every one of these three reads has a subject the bar
 * either holds or does not, and where it does not the bar renders no reading at all
 * rather than a state for one. A route naming no session has no identity to read, and
 * the surface says that in its own words.
 */
export type CastBarReadState<TValue> =
  | { readonly status: "reading" }
  | { readonly status: "served"; readonly value: TValue }
  | { readonly status: "unavailable"; readonly refusal: SettledReadRefusal };

/** The reading every unsettled arm answers with, as one identity across renders. */
const READING: CastBarReadState<never> = { status: "reading" };

/**
 * Put one of the bar's reads, and hold its answer against the subject it was put for.
 *
 * `read` answers `undefined` where there is no question — the caller holds no session
 * id, so there is nothing to ask about — and the chokepoint then puts nothing and
 * leaves the seed standing, which is the `reading` arm. That is honest for this
 * surface: a bar with no session is a bar whose reads have not resolved, and the
 * caller's own absence renders above them.
 */
export function useCastBarRead<TValue>(
  growth: GrowthPort,
  subject: string | undefined,
  read: (
    subject: string,
  ) => Promise<{ readonly status: "served"; readonly value: TValue } | SettledReadRefusal>,
): CastBarReadState<TValue> {
  return useSettledGrowthRead<
    { readonly status: "served"; readonly value: TValue } | SettledReadRefusal,
    CastBarReadState<TValue>
  >(growth, subject, (key) => (typeof key === "string" ? read(key) : undefined), {
    unsettled: () => READING,
    settled: (settlement) =>
      settlement.status === "served"
        ? { status: "served", value: settlement.value }
        : { status: "unavailable", refusal: settlement },
  }).value;
}
