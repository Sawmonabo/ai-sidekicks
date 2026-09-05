// The one door every growth-port call in this pane goes through.
//
// A CALL THAT REJECTS IS AN ANSWER, AND THE PORT'S OWN UNION CANNOT SAY SO. The live
// bridge crosses a process boundary, so an IPC disconnect makes a call THROW rather
// than answer a refusal — and `growthAnswerReading` is total over what a call ANSWERS
// and is never reached by one that threw. Both halves of this pane learned that the
// same way: the acts left a fetch on the `fetching` arm forever, and the reader's two
// legs were joined by a `Promise.all` that took the whole refresh down when either
// one rejected, discarding the other leg's valid answer with it.
//
// SO IT IS ONE FUNCTION AND NOT TWO. `apps/desktop/AGENTS.md` hoists a helper on its
// second use, and this is the second: the acts call it three times and the reader
// twice. Written twice, the two copies would be two chances to relabel a code the
// console is not allowed to paraphrase.
//
// THROUGH THE CONSOLE'S NORMALIZER RATHER THAN A SECOND ONE. `core/wire-rejection.ts`
// owns turning a rejection into this console's one refusal shape, and its arm ordering
// is what matters: a value that already IS a `ConsoleRefusal` — which the fixture
// bridge throws — passes through with the origin it named, a JSON-RPC envelope's dotted
// project code and a flat envelope's code and message are kept verbatim, and only the
// remainder becomes `call-rejected`. `repo-reads.ts` supplies the two things that are
// this family's — the origin and the sentence — and reads nothing itself.
//
// THE THUNK RATHER THAN A PROMISE: a bridge whose namespace is gone can throw
// synchronously, and a promise parameter would have to be built outside the `try` to
// be passed in — which is exactly the call this exists to catch.

import { repoCallRefusal } from "../../repos/repo-reads.js";
import {
  growthAnswerReading,
  type GrowthAnswer,
  type GrowthAnswerReading,
} from "./artifact-pane-reading.js";

/** Put one call to the port and read what came back — including a rejection. */
export async function readGrowthAnswer<TValue>(
  operation: string,
  call: () => Promise<GrowthAnswer<TValue>>,
): Promise<GrowthAnswerReading<TValue>> {
  try {
    return growthAnswerReading(operation, await call());
  } catch (rejection) {
    return { status: "refused", refusal: repoCallRefusal(operation, rejection) };
  }
}
