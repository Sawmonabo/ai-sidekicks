// Which run a wire payload names, and which of its members is allowed to say so.
//
// WHY IT IS ITS OWN MODULE. `fixture-shell-projection.ts` is a projection: it folds
// this window's log into rows, deriving position, epoch, and identity. Deciding
// whether a payload member names the row's OWN run is a different job, and its
// subject is not the shell at all — it is the contracts package's registered payload
// shapes. Nothing here reads an event, a store, or a row; it reads an open record
// and answers with a run id or nothing, which is the whole of it.
//
// It is reached deep by the sibling that folds the log rather than through
// `index.ts`, on that door's own terms: no symbol declared here leaves `cards/`, so
// publishing it on the family door would be a name whose home takes two hops to
// find and whose only consumer is one file away.

import {
  type InterventionRequestPayload,
  type RunRolledBackEvent,
  type RunStateChangeEvent,
  type SessionEvent,
  TIMELINE_RUN_ATTRIBUTION_PAYLOAD_KEYS,
} from "@ai-sidekicks/contracts";

/**
 * The payload members that attribute a row to a run — THE CONTRACT'S OWN LIST.
 *
 * `TIMELINE_RUN_ATTRIBUTION_PAYLOAD_KEYS` is `["runId", "targetRunId"]`, and the
 * second one is the whole finding: `Spec-006` spells run identity `runId` on every
 * run-attributed family except interventions, whose registered shape names the run
 * `targetRunId`. The shell read the first member and nothing else, so every
 * `intervention.*` event projected as a session-level `general` row and sat outside
 * the run chapter it belongs to — on a ledger whose whole shape is runs.
 *
 * CONSUMED RATHER THAN RE-DERIVED, because the contracts package already declares
 * this set once, with its reasoning, in the package that owns the wire. A second
 * list here would be the drift a closed set is declared once to prevent.
 */
const RUN_ATTRIBUTION_PAYLOAD_MEMBERS: readonly string[] = TIMELINE_RUN_ATTRIBUTION_PAYLOAD_KEYS;

/**
 * Every payload member in the registered shapes that NAMES a run, decided.
 *
 * THE COMPLETENESS PROOF FOR THE LIST ABOVE, and it catches what a shared runtime
 * constant cannot: a run-naming member added to a payload type that nobody adds to
 * that constant either. The union takes every member of every arm called `runId`
 * or ending in `RunId` — matched per arm, because a naked `keyof` over a union
 * yields only the members all its arms share — and the table is total over it, so
 * such a member fails to compile here until somebody says which run it names.
 *
 * Deciding every member rather than listing the attributing ones is what states
 * `parentRunId`'s case at all: `run.queued` carries it beside its own `runId`, and
 * reading whichever run-naming member turned up first would file a child run's rows
 * in its parent's chapter — the same defect pointing the other way. What KEEPS it
 * out at runtime is the contract's own list, which does not carry it; what this
 * table adds is that nobody can add a member to a payload and leave that question
 * unanswered.
 *
 * HOW FAR THE COMPLETENESS CLAIM REACHES, which is a fact about what the contracts
 * package publishes. `SessionEvent` is that package's own registered discriminated
 * union, so `SessionEvent["payload"]` is EVERY payload shape it registers under it:
 * an arm added there carrying a run-naming member arrives at this table with nobody
 * having to widen a list here. The three shapes named beside it are `runControl.ts`',
 * which that union does not carry — they are the payloads of the run and
 * intervention kinds this shell also reads, and the package publishes no union over
 * them — so those three are enumerated and the claim is bounded to exactly them: a
 * FOURTH run-control shape has to be added here by hand.
 */
type RunNamingMemberOf<TPayload> = TPayload extends unknown
  ? Extract<keyof TPayload, "runId" | `${string}RunId`>
  : never;

export type RunNamingPayloadMember = RunNamingMemberOf<
  SessionEvent["payload"] | RunStateChangeEvent | RunRolledBackEvent | InterventionRequestPayload
>;

/** Whether a member names the run the event is ABOUT, or some other run. */
export type RunAttributionRole = "this-run" | "another-run";

/**
 * The decision, one row per run-naming member. A COMPILE GATE, and stated as one.
 *
 * WHAT IT IS LOAD-BEARING FOR, exactly: the annotation is a total record over the
 * derived member union, so a payload this shell reads that grows a run-naming member
 * does not compile until this table says which run that member names — and a member
 * the union does not carry is refused as an excess property, so the table cannot
 * drift ahead of the wire either. That is the whole of its live effect, and
 * `run-attribution.test.ts` drives it with a table the compiler rejects rather than
 * asserting it in prose.
 *
 * WHAT IT IS NOT. It is not a second filter over the contract's attributing list.
 * `TIMELINE_RUN_ATTRIBUTION_PAYLOAD_KEYS` names exactly the two spellings a row uses
 * to name its own run, and `timeline/row.ts` says so where it declares them —
 * `parentRunId` is absent there deliberately, not accidentally — so every key that
 * list carries is decided `this-run` here and the intersection below removes nothing
 * at today's contract. It is kept, and kept honest: it is the fail-closed arm for a
 * contract that grows an attributing key this file has not reviewed, DECLARED AND
 * DORMANT, and the test pins the dormancy by checking each listed key's decision
 * rather than leaving "removes nothing" as a claim.
 */
export const RUN_ATTRIBUTION_BY_PAYLOAD_MEMBER: Readonly<
  Record<RunNamingPayloadMember, RunAttributionRole>
> = {
  runId: "this-run",
  targetRunId: "this-run",
  parentRunId: "another-run",
};

/** The decided members that attribute, as the lookup below asks them. */
const ATTRIBUTING_PAYLOAD_MEMBERS: ReadonlySet<string> = new Set(
  Object.entries(RUN_ATTRIBUTION_BY_PAYLOAD_MEMBER)
    .filter(([, role]) => role === "this-run")
    .map(([member]) => member),
);

/**
 * Read the run a payload belongs to, or `undefined` where it belongs to none.
 *
 * Taken as the open record rather than as an event, because that is all the answer
 * depends on and it keeps this module free of the store's projection contract.
 * Narrowed on the way out: a payload member is `unknown` by that contract — the
 * projector that claims a kind is what narrows it, and the shell claims every kind.
 */
export function attributedRunIdOf(
  payload: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
  for (const member of RUN_ATTRIBUTION_PAYLOAD_MEMBERS) {
    if (!ATTRIBUTING_PAYLOAD_MEMBERS.has(member)) {
      continue;
    }
    const candidate = payload?.[member];
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate;
    }
  }
  return undefined;
}
