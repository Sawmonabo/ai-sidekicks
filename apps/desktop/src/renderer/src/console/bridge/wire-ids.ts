// A console-held id string, as the branded id a registered request declares.
//
// The id brands in `@ai-sidekicks/contracts` are compile-time nominal typing over
// plain `string`, and the console holds its ids as plain strings throughout: they
// arrive from route params, from authored scenario data, and off rendered rows,
// none of which carries a brand. So every caller that sends one has to widen at the
// seam where a held id meets a registered request, and the console has been writing
// that widening — plus a paragraph explaining it — once per call site. The absorbed
// mounts in `seats/absorbed-surfaces.ts` carry one; the sent-invite ledger carried a
// second.
//
// WHY IT SITS BESIDE THE CALL DOOR AND NOWHERE ELSE. `callDaemon` parses the whole
// request through the contracts schema before anything is sent, and that schema is
// what OWNS the brand. So a widening performed for a call is checked rather than
// merely asserted: a string that is not a well-formed id is refused as
// `request-unsendable`, by the brand's own author, before the daemon sees it. The
// same cast written anywhere else in the console would carry no such guarantee,
// which is the whole reason this module holds exactly one function and takes no
// other job.

/**
 * Widen one held id string to the branded id a request member declares.
 *
 * The brand is inferred from the member being filled, so a held id offered where a
 * request wants a different id still fails to compile — this widens `string` to a
 * brand, and never one brand to another.
 */
export function heldIdAsWireId<TWireId extends string>(heldId: string): TWireId {
  return heldId as TWireId;
}
