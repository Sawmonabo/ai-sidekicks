// What identifies one provider ask, and why its `askId` alone does not.
//
// A provider mints its ask ids per provider SESSION, so two runs blocked at once
// legitimately raise `ask-1` each. Every surface that files a driver ask under that id
// alone therefore lets one run's answer settle the other's, and the two shipped
// surfaces fail in the two directions one defect has: the ledger's ask card reads as
// answered and loses its answer controls while its own run stays blocked, and the cast
// bar's fold deletes the only entry it had and prints its all-clear line over a run
// nobody can reach. This module is the one place the identity is composed, so those
// two surfaces cannot disagree about what "the same ask" is.
//
// AT THE FLOOR because its readers are two VIEW families — the ledger's ask card and
// the workspace's cast bar — and view families are siblings, so neither may reach the
// other and no family between them owns the question. That is `core/structural-key.ts`'
// own stated reason applied to a second subject, and this module needs nothing to be
// here: no store type, no contracts schema, no React.
//
// ITS OWN MODULE and not another export of that encoder, on
// `core/wire-session-attribution.ts`' stated precedent — that file is named for the
// noun it owns and its header is the encoding rule end to end, and none of those
// sentences is about which two members name one ask.
//
// SEGMENTS AND NOT A FINISHED KEY, because the two readers file the ask in different
// maps: the ledger's holds driver asks alone, and the cast bar's holds three request
// lifecycles at once and namespaces each by the event that opens it. Handing back the
// segments lets each compose its own key through the one encoder rather than encoding
// an already-encoded key, and it leaves the ORDER — the run first, the provider's own
// id last — spelled exactly once.
//
// AND `undefined` IS A REFUSAL TO IDENTIFY rather than a run-less key. An ask naming no
// run cannot be answered at all — the registered answer request addresses a run — so
// filing one under a partial key would make an unanswerable ask able to settle an
// answerable one. What each caller does with the refusal is its own fail-closed arm:
// the ledger settles nothing, and the cast bar holds the ask open under a key of its
// own. Neither may fall back to the bare `askId`, which is the defect itself.

/**
 * The segments one driver ask is identified by, or `undefined` where none identify it.
 *
 * Both members are required and an empty string counts as absent: a wire string this
 * console did not author is present only when it carries something, and `""` as a
 * segment would be one key shared by every ask whose run the payload omitted.
 *
 * @param runId The run the ask blocks — the scope that makes the provider's id unique.
 * @param askId The provider's own ask id, unique only within one provider session.
 */
export function driverAskIdentitySegments(
  runId: string | undefined,
  askId: string | undefined,
): readonly string[] | undefined {
  if (runId === undefined || runId.length === 0) {
    return undefined;
  }
  if (askId === undefined || askId.length === 0) {
    return undefined;
  }
  return [runId, askId];
}
