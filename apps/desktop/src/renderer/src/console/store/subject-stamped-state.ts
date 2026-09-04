// A settled value belongs to the inputs that produced it.
//
// THE FAILURE THIS CLOSES. A view that reads through a transport for a subject
// holds two things at once: what it last learned, and what it is currently being
// asked about. Those are separate facts, and a holder that keeps only the first
// answers the NEW question with the OLD reading for as long as the replacement read
// takes — which is unbounded, because nothing behind the bridge is cancellable and a
// read that never settles never corrects it. The window is invisible in every test
// that settles before asserting, and on screen it is a roster, a roll, or a count
// that belongs to a session or a transport that is gone.
//
// Reset-on-change is the near miss. Comparing one input during render and clearing
// the held value is the React "adjusting some state when a prop changes" pattern,
// and it closes the window for the input it names and for no other: a subject with
// two inputs needs both compared, and every site that writes the comparison by hand
// writes it over the inputs it happened to think of. `store/hooks.ts` reached this
// conclusion first — `useCallerMembershipRole` stamps its settled identity with BOTH
// the reader and the store, and says why in its own words — and this module is that
// rule with the subject left open, so a holder states which identities its answer
// belongs to rather than restating the comparison.
//
// WHAT A STAMP IS AND IS NOT. It is the list of identities that decide what a
// correct answer would be: a session id, a transport, a reader. It is not a
// freshness check — an answer for the right subject is not thereby current — and it
// is not a cancellation, because the read it supersedes is still running. A caller
// that also needs "the newest of several in-flight reads for ONE subject" keeps its
// own monotonic counter beside this (`core/attempt-generation.ts` owns that shape);
// the two guards are independent and both are usually needed.

import { useCallback, useState } from "react";

/**
 * The identities a held value belongs to, one entry per deciding input.
 *
 * An array rather than a single value, because the interesting cases have more than
 * one: a view reads for a SESSION through a TRANSPORT, and a change to either makes
 * the held answer an answer to a question nobody is asking. Compared element-wise
 * with `Object.is`, which is the same rule React applies to an effect's dependency
 * list — so a caller that already knows which dependencies its read is keyed on
 * knows its stamp without deciding anything twice.
 */
export type SubjectStamp = readonly unknown[];

/**
 * A held value together with the subject it was published for.
 *
 * Kept in state rather than in a ref so the render that first sees a new subject is
 * the one that adjusts it — a ref written during render is the write React's own
 * rules refuse, and a ref written from an effect is one commit too late, which is
 * the frame the stale value is on screen for.
 */
interface StampedHolding<TValue> {
  readonly subject: SubjectStamp;
  readonly value: TValue;
}

/** Whether two stamps name the same subject. Element-wise `Object.is`. */
function isSameSubject(held: SubjectStamp, current: SubjectStamp): boolean {
  return (
    held.length === current.length &&
    held.every((identity, position) => Object.is(identity, current[position]))
  );
}

/**
 * Hold a value against the subject it answers for.
 *
 * Returns the held value while its stamp still names the current subject, and
 * `unstampedValue` — the "nothing has been read for THIS subject yet" answer —
 * whenever it does not. That substitution happens in the render that first sees the
 * new subject, before the effect that will start the replacement read has run, so
 * there is no pass in which the previous subject's answer is painted under the new
 * one's question.
 *
 * The publisher hands in the subject IT was working for, not the one currently
 * rendered, and a publish whose subject has since been replaced is dropped rather
 * than installed — so a reply from a retired transport cannot overwrite the answer a
 * live one has already given. Callers still keep their own teardown guard: this
 * makes a superseded reply harmless, it does not make the read stop.
 *
 * `unstampedValue` should be a stable reference (a module constant, not a fresh
 * literal per render) for the same reason `store/hooks.ts` freezes its own: a
 * consumer keying a `useMemo` or an effect on the result should not see the answer
 * change identity because the same absence was reported twice.
 */
export function useSubjectStampedState<TValue>(
  subject: SubjectStamp,
  unstampedValue: TValue,
): readonly [TValue, (publishedSubject: SubjectStamp, value: TValue) => void] {
  const [holding, setHolding] = useState<StampedHolding<TValue>>(() => ({
    subject,
    value: unstampedValue,
  }));

  // Render-phase adjustment, so the stamp the publisher is checked against is the
  // subject this render is about. Without it the holding would keep naming the
  // subject of the last publish, and the first reply for the NEW subject would be
  // dropped as stale — the opposite failure, and the harder one to see.
  if (!isSameSubject(holding.subject, subject)) {
    setHolding({ subject, value: unstampedValue });
  }

  const publish = useCallback(
    (publishedSubject: SubjectStamp, value: TValue): void => {
      setHolding((held) =>
        isSameSubject(held.subject, publishedSubject) ? { subject: held.subject, value } : held,
      );
    },
    // Stable for the life of the mount: it compares against the stamp in state
    // rather than against anything it closed over, so a caller may name it in an
    // effect's dependency list without the effect re-running on every render.
    [],
  );

  const value = isSameSubject(holding.subject, subject) ? holding.value : unstampedValue;
  return [value, publish];
}
