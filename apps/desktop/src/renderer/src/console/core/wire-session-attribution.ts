// Holding an event payload's own `sessionId` against the envelope that delivered it.
//
// WHY A FOLD HAS TO ASK AT ALL. A projector writes into the partitions of the store
// the envelope was routed to, and `SessionStore` checks only the ENVELOPE's
// `sessionId` before handing the event on. The payload is a second statement of the
// same fact, and nothing above the fold compares the two: the console parses events
// through the tolerant `EventEnvelopeSchema` on purpose (`bridge/daemon/session-event-payload.ts`),
// so a payload variant the strict union does not register — which is most of them —
// arrives whole and unexamined. A frame whose payload names another session therefore
// reaches a fold that keys a mutation off it, and lands that session's entity in this
// session's partition, where every surface reading the partition then treats it as a
// member of this session.
//
// IT LIVES IN `core/` BECAUSE ITS READERS ARE AT THREE DIFFERENT HEIGHTS. The run fold
// is in `frame/`, the approval fold in `bridge/`, and the presence fold in a VIEW
// family — and a view family may import neither of the other two. The floor is the
// only home all three share, and this module needs nothing to be there: no store type,
// no contracts schema, no React. It is `core/wire-strings.ts`'s neighbour rather than
// another of its exports for that module's own stated reason — it is named for the
// noun it owns and its header is the string rule end to end, and none of those
// sentences is about two members that have to agree.
//
// TWO RULES AND NOT ONE, BECAUSE THE CONTRACTS DIFFER. The payload shapes make
// `sessionId` REQUIRED for `run_lifecycle` and `approval_flow`, so a frame that omits
// it there is malformed rather than terse and {@link payloadNamesSession} refuses it.
// A kind whose registered variant is `.strict()` with no `sessionId` in it at all
// would be refused by that rule on every real frame, and
// {@link payloadContradictsSession} is the arm that fits those: an absent member
// contradicts nothing, and a present one that names another session is a payload no
// daemon emits and is refused.
//
// THE COMPARISON IS AGAINST THE RAW MEMBER, never a read one, so a payload naming a
// non-string `sessionId` fails here instead of being read as absence and waved
// through. `core/wire-strings.ts` is the wrong instrument for a member whose only job
// is to equal something already known.
//
// AND `bridge/run-streams/run-stream-shapes.ts` DELIBERATELY DOES NOT CONSUME THIS.
// `refuseSessionDisagreement` makes the same claim at a different boundary and owes
// something a predicate cannot carry: two distinct refusal SENTENCES, one for a beat
// that names no session and one for a beat that names the wrong one, each composed
// into a projection a scenario author reads. A boolean would leave that module
// branching on the same two conditions to choose between them, which is the
// duplication moved rather than removed.

/**
 * Does this payload state the session its envelope was delivered on?
 *
 * The rule for every payload shape whose `sessionId` is REQUIRED: absence fails,
 * because `undefined` equals no session id, and that is the intended reading rather
 * than an accident of the comparison.
 *
 * A TYPE PREDICATE rather than a bare boolean, because a payload that names this
 * session is by construction a payload that exists — and every caller's next line
 * indexes it. Written as a `boolean` the guard would leave each fold re-establishing
 * presence one line later, which is the judgement being hoisted made twice.
 */
export function payloadNamesSession(
  payload: Readonly<Record<string, unknown>> | undefined,
  envelopeSessionId: string,
): payload is Readonly<Record<string, unknown>> {
  return payload?.["sessionId"] === envelopeSessionId;
}

/**
 * Does this payload state a session OTHER than the one its envelope was delivered on?
 *
 * The rule for a payload shape that carries no `sessionId` of its own: there is
 * nothing to agree with, so absence passes and only a present, disagreeing member is
 * refused. Written in terms of {@link payloadNamesSession} so the comparison itself
 * exists once and the two rules cannot drift into disagreeing about what "names" is.
 */
export function payloadContradictsSession(
  payload: Readonly<Record<string, unknown>> | undefined,
  envelopeSessionId: string,
): boolean {
  return payload?.["sessionId"] !== undefined && !payloadNamesSession(payload, envelopeSessionId);
}
