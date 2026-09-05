// The one narrowing both ingest legs read a growth answer through.
//
// A MODULE OF ITS OWN BECAUSE IT IS A SEAM AND NOT A DETAIL. The protocol
// (`attachment-ingest-machine.ts`) and the reclaim (`attachment-ingest-abort.ts`)
// each call the growth port and each read the same three things off what comes back:
// whether it was served, the code if it was not, and the sentence that goes with the
// code. Two copies of that narrowing would be two copies of one seam, which
// `apps/desktop/AGENTS.md` rejects for the reason it always gives — they drift, and
// the gate stays green while they do. Declaring it here also keeps the dependency
// one-way: the machine imports the reclaim, the reclaim imports nothing of the
// machine's, and neither has to reach for the other to describe an answer.
//
// NARROWER THAN `GrowthOutcome` ON PURPOSE. The bridge's own outcome type carries the
// operation id, the slate row, and the owning document, which are what a REFUSAL CARD
// renders. Neither leg here renders one — the refusal is written onto a ledger entry
// or onto the diagnostic band — so requiring those members would make every test
// double build a card's worth of shape to answer a call.

/** One growth-port answer, narrowed to what an ingest leg reads off it. */
export interface PortAnswer<TValue> {
  readonly status: "served" | "unavailable";
  readonly value?: TValue;
  readonly code?: string;
  readonly detail?: string;
}
