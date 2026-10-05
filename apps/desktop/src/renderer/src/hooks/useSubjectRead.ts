// One read per subject, held against that subject.
//
// The workflows readers, the session directory and the session header each ask a question
// about one subject that can change under a mounted caller. The state lives in
// `lib/subject-scoped/`, and a read that loses a race with a re-address is abandoned through
// `lib/reads/read-scope.ts`; this is the one effect that ties the two together.
//
// A rejected call is not caught here: the rejection surfaces unhandled from the effect
// rather than becoming a state.

import { useEffect } from "react";

import type {
  SubjectKey,
  SubjectScopedPublish,
} from "@renderer/lib/subject-scoped/subject-scoped-holder.js";
import { useSubjectScopedState } from "./subject-scoped/useSubjectScopedState.js";
import { isReadAbandoned, settleUnlessAbandoned } from "@renderer/lib/reads/read-scope.js";
import { useReadScope } from "./useReadScope.js";

/** How a caller turns one read into the states a view renders. */
export interface SubjectReadProjection<TValue, TState> {
  /** What is true before an answer exists: nothing asked, or a read in flight. */
  readonly unsettled: (key: SubjectKey) => TState;
  /** The state an answer becomes. */
  readonly settled: (value: TValue) => TState;
}

/**
 * Put one read per subject and hold its answer against that subject.
 *
 * `read` answers `undefined` when the question cannot be formed, for example when no
 * subject is named. `subject` is the object the state is held against: a different one
 * starts the read over, so the call a caller passes must be stable across renders.
 * `readRevision` asks the same question again when the answer went stale under a
 * subject that did not move; the previous answer stays on screen until the new one
 * lands.
 */
export function useSubjectRead<TValue, TState>(
  subject: object,
  key: SubjectKey,
  read: (key: SubjectKey, signal: AbortSignal) => Promise<TValue> | undefined,
  project: SubjectReadProjection<TValue, TState>,
  readRevision = 0,
): {
  readonly value: TState;
  readonly publish: SubjectScopedPublish<TState>;
} {
  const { value, publish } = useSubjectScopedState<TState>(subject, key, () =>
    project.unsettled(key),
  );
  const readScope = useReadScope(subject, key);
  const { settled } = project;
  useEffect(() => {
    const round = readScope.openRound();
    // A round that is already over: React's double mount abandons the scope this render
    // captured before the effect re-runs.
    if (isReadAbandoned(round.signal)) {
      return;
    }
    const pending = read(key, round.signal);
    if (pending === undefined) {
      return;
    }
    void settleUnlessAbandoned(pending, round.signal).then((settlement) => {
      if (settlement.status === "abandoned") {
        return;
      }
      round.settle(() => {
        publish(settled(settlement.value));
      });
    });
    // `read` and `settled` are closures rebuilt every render over the subject and key already
    // named here, so listing them would re-read on every render.
  }, [subject, key, publish, readRevision, readScope]);
  return { value, publish };
}
