// How a growth read ENDS, when the seam it travels can also REJECT.
//
// A growth operation answers with an outcome a surface narrows on, and the reads
// built on it were written as though that were the only way one could finish. It is
// not. The scripted-reply seam has a fourth settlement the outcome union deliberately
// has no arm for: a scenario that scripts a DAEMON refusal is thrown verbatim and
// unwrapped, because a growth-scoped code for it would paraphrase the daemon's own
// envelope — and the live seam will throw the same shape the day the wire lands and
// the operation becomes an ordinary bridge call.
//
// Attaching only a fulfilment handler therefore left the rejection unhandled and the
// surface in `reading` for the life of the window: a spinner over an answer that had
// already arrived. That is the one shape a read must never take, because rule 8's
// `not-loaded` promises an answer that is still coming, and here none is.
//
// WHY IT LIVES IN `bridge/` RATHER THAN IN THE FAMILY THAT FIRST NEEDED IT. It is
// generic over the whole outcome and knows nothing about workflows: what it settles
// is a promise the GROWTH PORT returned, so `bridge/` is the lowest family on the
// console's DAG that owns its input. It was written inside `workflows/`, which made
// it unreachable to `seats/session-directory.ts` — the fourth read on this same seam,
// one family below — and that read went without it, settling its rejection arm
// through the growth port's own builder instead: the port's `call-rejected` stamped
// over whatever the daemon had said, so the console held two refusal vocabularies for
// one seam and a person met whichever the surface they were on happened to use. That
// read settles here now, and every growth read in the console does.
//
// AND THIS PAIR LEAVES THROUGH `bridge/index.ts` AND THROUGH NO INNER DOOR. Every
// reader is a view family or `seats/`; no module inside `bridge/` takes it, so a
// `readings/index.ts` would publish a name no sibling reaches — the dead export
// `structure:dead-code` reports. The door states the consequence and this states the
// rule, which is the one place it is decided.
//
// WHAT IS LEFT HERE IS THE SETTLEMENT, AND THE CLASSIFICATION IS NOT. This module
// used to carry its own four-armed reading of a thrown value — a bare refusal, one
// carried inside a `ConsoleRefusalError`, a flat wire envelope, and everything else —
// and it is one of six families that each wrote that reading down. `core/
// wire-rejection.ts` is now the one that runs, and it is strictly better on two
// counts this copy got wrong: it recovers the dotted project code the JSON-RPC
// envelope carries at `data.type`, which this copy dropped on the floor, and it
// rebuilds every arm from bounded strings rather than letting the thrown value ride
// onto the refusal, where its next property access is a throw outside every `catch`.
//
// ONE ORIGIN, WHERE THIS MODULE USED TO NAME TWO. A wire envelope was attributed to
// `daemon` and everything else to this seam, and the distinction does not need the
// origin to carry it: the daemon's own CODE arrives verbatim under rule 9 and a
// synthesized one is built from the origin, so `workflow.session_not_found` and
// `growth-read-call-failed` are already the two different things a reader is being
// told. What the origin says now is which seam the refusal surfaced at, which is what
// it says everywhere else in the console.
//
// WHY THIS IS NOT A SECOND REFUSAL VOCABULARY. `GrowthUnavailable` already extends
// `ConsoleRefusal`, so an outcome the port itself refused passes through untouched and
// both arms reach one `RefusalBanner` with no translation between them. What this adds
// is the settlement, not a shape.

import { useEffect } from "react";

import { normalizeWireRejection, type WireRefusal } from "../../core/index.js";
import {
  useSubjectScopedState,
  type SubjectKey,
  type SubjectScopedPublish,
} from "../../store/index.js";
import type { GrowthPort } from "../growth-port/index.js";

/** The origin on a refusal this seam composes, and the one it relays under. */
export const READ_SETTLEMENT_REFUSAL_ORIGIN = "growth-read";

/**
 * A refusal a settled read carries, whoever raised it.
 *
 * The console's one refusal shape plus the discriminant the outcome union narrows on,
 * and nothing more: `GrowthUnavailable` widens this same shape with what the growth
 * port knows, so a port refusal satisfies it without being rebuilt. `WireRefusal` and
 * not `ConsoleRefusal`, so the retry bound a rate-limited refusal carries is on the
 * type a surface reads rather than riding along unannounced.
 */
export type SettledReadRefusal = WireRefusal & { readonly status: "unavailable" };

/**
 * Settle a growth read, so its caller has one value to narrow on.
 *
 * Generic over the whole outcome rather than over its served value: what the port
 * answers with is the port's business, and this seam only adds the arm a rejection
 * takes. Typed the other way it would have to name `GrowthOutcome`, which does not
 * leave the bridge's door, and a second declaration of the served arm here would be
 * one closed shape with two homes.
 *
 * No fallback is supplied, and that is the reading rather than an omission: the
 * fallback arm answers a FIXED sentence, and the text a rejection carried is the only
 * account of what happened. The normalizer's terminal arm keeps it — an `Error` gives
 * up its message and anything else goes through the total stringifier — under a code
 * built from the origin above, so a read that failed for a reason nobody can read is
 * still distinguishable from one that was never put.
 */
export async function settleGrowthRead<TOutcome>(
  read: Promise<TOutcome>,
): Promise<TOutcome | SettledReadRefusal> {
  try {
    return await read;
  } catch (rejection) {
    return {
      ...normalizeWireRejection(READ_SETTLEMENT_REFUSAL_ORIGIN, rejection),
      status: "unavailable",
    };
  }
}

/** A settled read's current value, and the publisher its own answers arrive through. */
export interface SettledGrowthRead<TState> {
  readonly value: TState;
  readonly publish: SubjectScopedPublish<TState>;
}

/**
 * How a caller turns one read into the two states a surface renders.
 *
 * TWO PROJECTIONS AND NOT ONE, because a read has two moments and they are answered
 * by different things. `unsettled` is what is true before an answer exists — which is
 * `unasked` or `reading` depending on whether there was a question to put, a rule
 * `store/subject-read-start.ts` already owns — and `settled` is the caller's reading
 * of the port's own outcome. Handed as one object rather than as two positional
 * callbacks so a call site cannot silently pass them in the wrong order.
 */
export interface SettledGrowthReadProjection<TOutcome, TState> {
  readonly unsettled: (key: SubjectKey) => TState;
  readonly settled: (settlement: TOutcome | SettledReadRefusal) => TState;
}

/**
 * Put one growth read per subject, settle it, and hold its answer against that subject.
 *
 * FOUR READS WERE THIS BLOCK, TOKEN FOR TOKEN. The session directory, the definitions
 * directory, the runs directory and the run snapshot each held state against the port
 * and their own key, seeded it from `subjectReadStart`, put the read inside an effect
 * keyed on `[growth, key, publish]`, settled it through `settleGrowthRead`, and
 * published a projection of the outcome. The only tokens that differed were which
 * operation was called and which member the served arm carried — so a discarded-answer
 * bug fixed in one of them stayed in the other three, which is the defect class this
 * console's shared substrate exists to end.
 *
 * WHETHER THERE IS A QUESTION TO PUT IS THE CALLER'S, and it is expressed once, where
 * the request is built: `read` answers `undefined` when its wire's request cannot be
 * formed. Three of the four reads carry a required session or run id and say so there;
 * the session directory's request carries nothing and always answers a promise. Read
 * off the key here instead, this hook would be restating each wire's own request shape
 * and would be wrong for the fourth.
 *
 * NO MOUNT FLAG AND NO RESET, for the reasons the holder already owns: `publish`
 * carries the addressing it was captured under, so an answer arriving after the
 * subject moved writes nowhere, and the holder re-seeds during the render that brings
 * a new subject rather than in an effect one commit later.
 */
export function useSettledGrowthRead<TOutcome, TState>(
  growth: GrowthPort,
  key: SubjectKey,
  read: (key: SubjectKey) => Promise<TOutcome> | undefined,
  project: SettledGrowthReadProjection<TOutcome, TState>,
): SettledGrowthRead<TState> {
  const { value, publish } = useSubjectScopedState<TState>(growth, key, () =>
    project.unsettled(key),
  );
  const { settled } = project;
  useEffect(() => {
    const pending = read(key);
    if (pending === undefined) {
      return;
    }
    void settleGrowthRead(pending).then((settlement) => {
      publish(settled(settlement));
    });
    // `publish` re-identifies exactly when the holder is re-addressed, so it is both
    // the guard on this read's answer and the whole of what tells this effect to run
    // again — the dependency list the four hand-written copies of this effect already
    // carried. `read` and `settled` are deliberately not in it: each is a closure the
    // caller rebuilds every render over exactly the port and key already named here,
    // so listing them would re-read on every render of every surface.
  }, [growth, key, publish]);
  return { value, publish };
}
