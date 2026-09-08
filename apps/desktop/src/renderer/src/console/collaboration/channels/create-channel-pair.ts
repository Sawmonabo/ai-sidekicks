// Who a `direct` channel may be with, and the order its two ids are sent in.
//
// A MODULE BESIDE THE DRAFT, on `create-channel-fields.ts`'s rule and for its reason.
// That one owns the field vocabulary two moments of a draft are compared by; this one
// owns the direct arm's membership rule, and it is split out because the rule has
// THREE readers who must not disagree: the picker draws the candidates, the draft's
// readiness admits a pick, and the request composes the pair. Written beside any one
// of them it would have been that reader's private answer, and the other two would
// have been free to hold a different one — which is exactly the defect this closes.
//
// THE CANDIDATE SET IS THE ADMISSION RULE, NOT A DRAWING CONVENIENCE. A person picks
// from a list of the session's live participants minus this window's own, and the
// same list is what a pick is validated against at readiness — so a candidate who is
// revoked, suspended, or otherwise gone from the live set stops being drawable and
// stops being submittable in the same moment, off one derivation rather than two.
//
// AND WHOSE LIST IT IS. The caller supplies the live participants: who is still in
// the session is a membership fold the store owns (`members/members-model.ts`), and a
// second reading of it here would be a second answer to a question one surface has
// already asked. What lives here is only what that reading MEANS for this form.

/**
 * The people this window may open a `direct` channel with.
 *
 * The viewer is subtracted rather than offered-and-refused: the caller is already one
 * member of every direct channel they can create, and the wire requires two DISTINCT
 * humans — so a control offering the reader themselves would be a control whose only
 * outcome is a refusal.
 *
 * An unread viewer subtracts nobody, which is honest rather than convenient: the form
 * cannot compose a pair at all until that read answers, and quietly dropping a name
 * from the list would report the missing read as a fact about the session's roster.
 */
export function directChannelCandidates(
  participantIds: readonly string[],
  viewerParticipantId: string | undefined,
): readonly string[] {
  return participantIds.filter((participantId) => participantId !== viewerParticipantId);
}

/**
 * Whether this pick is still one the session admits.
 *
 * Membership in {@link directChannelCandidates}, asked as a question rather than
 * recomputed at each site, because "still pickable" and "still submittable" are the
 * same fact and a second spelling of it is how the two drift.
 */
export function isDirectChannelCandidate(
  pickedParticipantId: string,
  participantIds: readonly string[],
  viewerParticipantId: string | undefined,
): boolean {
  return directChannelCandidates(participantIds, viewerParticipantId).includes(pickedParticipantId);
}

/**
 * The two ids in canonical order.
 *
 * Sorted rather than kept as picked, because the pair is a membership and not a
 * sequence: nothing on this wire reads position, so two orderings of one pair are one
 * channel described twice.
 */
export function canonicalMemberPair(
  firstParticipantId: string,
  secondParticipantId: string,
): readonly [string, string] {
  return firstParticipantId <= secondParticipantId
    ? [firstParticipantId, secondParticipantId]
    : [secondParticipantId, firstParticipantId];
}
