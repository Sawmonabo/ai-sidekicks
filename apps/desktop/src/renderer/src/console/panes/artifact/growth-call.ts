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
// bridge throws — passes through with the origin it named, and a JSON-RPC envelope's
// dotted project code and a flat envelope's code and message are kept verbatim. Only
// the remainder reaches the fallback below.
//
// AND THE FALLBACK IS THE PORT'S OWN VOCABULARY, WHICH IT WAS NOT. This function used
// to reach one directory over for `repoCallRefusal`, so a rejected `artifactRead`
// rendered `origin: "repos"` with `code: "call-rejected"` — the repos family's
// daemon-read origin and the DAEMON REPLY vocabulary — while the same operation's
// ANSWERED refusal rendered `origin: "growth-port"` with `code: "wire-unregistered"`.
// One operation, two failure paths, two subsystem names, and neither the origin nor
// the code on the second was a member of the set the growth port declares. Both paths
// now stamp `GROWTH_PORT_REFUSAL_ORIGIN`, and the code is the port's own
// `wire-unregistered`: a growth call reaches the port through a namespace the live
// bridge fills in, so the throw this catches is that namespace being gone, which is
// what that member means. The DETAIL is what separates the two — an answered refusal
// says nobody asked, and this one says the call was rejected. That import of
// `repos/repo-reads.js` was also the only reason `panes/artifact/` reached into
// `repos/` for a read at all, and it is gone with it.
//
// THE THUNK RATHER THAN A PROMISE: a bridge whose namespace is gone can throw
// synchronously, and a promise parameter would have to be built outside the `try` to
// be passed in — which is exactly the call this exists to catch.

import { GROWTH_PORT_REFUSAL_ORIGIN, type GrowthPortRefusalCode } from "../../bridge/index.js";
import { normalizeWireRejection } from "../../core/index.js";
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
    return {
      status: "refused",
      refusal: normalizeWireRejection(GROWTH_PORT_REFUSAL_ORIGIN, rejection, {
        code: "wire-unregistered" satisfies GrowthPortRefusalCode,
        detail: `${operation} was rejected.`,
      }),
    };
  }
}
