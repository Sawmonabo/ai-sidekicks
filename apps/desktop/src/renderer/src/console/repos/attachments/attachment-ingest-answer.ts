// The one narrowing every ingest leg reads a growth answer through, and the one door
// every one of them calls through.
//
// A MODULE OF ITS OWN BECAUSE IT IS A SEAM AND NOT A DETAIL. The protocol
// (`attachment-ingest-stream.ts`, `attachment-ingest-chunks.ts`) and the reclaim
// (`attachment-ingest-abort.ts`)
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

import { repoCallRefusal } from "../repo-reads.js";

/** One growth-port answer, narrowed to what an ingest leg reads off it. */
export interface PortAnswer<TValue> {
  readonly status: "served" | "unavailable";
  readonly value?: TValue;
  readonly code?: string;
  readonly detail?: string;
}

/**
 * Put one leg's call and read what came back — INCLUDING a rejection.
 *
 * THE ONE DOOR EVERY INGEST AWAIT GOES THROUGH, because all of them can fail in a way
 * {@link PortAnswer} cannot express: the three protocol calls ask a bridge whose
 * namespace disappears on an IPC disconnect, and the payload read reads a `Blob` whose
 * backing file the participant may have moved. Both arrive as a throw and both mean the
 * same thing to the entry — this leg did not happen — so both become the unavailable
 * answer the ledger's refusal write already knows how to record, and the retry the
 * disposition offers is the participant's.
 *
 * THROUGH THE REPOS FAMILY'S NORMALIZER RATHER THAN A SECOND ONE, on the artifact
 * pane's reason one directory over: `repo-reads.ts` owns turning a rejection into this
 * console's one refusal shape, and its ordering is what matters — a value that already
 * IS a `ConsoleRefusal` keeps the origin it named, a typed wire envelope keeps the
 * daemon's code and message verbatim, and only the remainder becomes `call-rejected`. A
 * copy here would relabel codes the console may not paraphrase.
 *
 * The THUNK rather than a promise: a bridge whose namespace is gone can throw
 * synchronously, and a promise parameter would be built outside the `try`.
 */
export async function answerOrRefusal<TValue>(
  leg: string,
  call: () => Promise<PortAnswer<TValue>>,
): Promise<PortAnswer<TValue>> {
  try {
    return await call();
  } catch (rejection) {
    const refusal = repoCallRefusal(leg, rejection);
    return { status: "unavailable", code: refusal.code, detail: refusal.detail };
  }
}
