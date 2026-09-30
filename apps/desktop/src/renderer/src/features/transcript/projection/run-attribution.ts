// Which run a wire payload names, and which of its members may say so. Its subject is the
// contracts package's registered payload shapes, not the projection: it reads an open record
// and answers with a run id or nothing.

import {
  type InterventionRequestPayload,
  type RunRolledBackEvent,
  type RunStateChangeEvent,
  type SessionEvent,
  TIMELINE_RUN_ATTRIBUTION_PAYLOAD_KEYS,
} from "@ai-sidekicks/contracts";

/**
 * The payload members that attribute a row to a run: the contract's own list, `runId` and
 * `targetRunId`. Interventions name the run `targetRunId`; reading only `runId` would project
 * every `intervention.*` event as a session-level `general` row outside its run group.
 * Consumed, not re-derived, so there is one list.
 */
const RUN_ATTRIBUTION_PAYLOAD_MEMBERS: readonly string[] = TIMELINE_RUN_ATTRIBUTION_PAYLOAD_KEYS;

/** Every run-naming payload member across the registered payload shapes. */
export type RunNamingPayloadKey = RunNamingMemberOf<
  SessionEvent["payload"] | RunStateChangeEvent | RunRolledBackEvent | InterventionRequestPayload
>;

/** Whether a member names the run the event is about, or some other run. */
export type RunAttributionRole = "this-run" | "another-run";

/**
 * Every payload member in the registered shapes that names a run.
 *
 * The completeness proof for the list above, matched per arm because a naked `keyof` over a
 * union yields only the members all arms share. `SessionEvent["payload"]` covers every arm
 * the contracts package registers; the three run-control shapes beside it are not in that
 * union, so a fourth has to be added by hand.
 */
type RunNamingMemberOf<TPayload> = TPayload extends unknown
  ? Extract<keyof TPayload, "runId" | `${string}RunId`>
  : never;

/**
 * The decision, one row per run-naming member. A compile gate: the record is total over the
 * derived member union, so a payload that grows a run-naming member fails to compile until
 * this says which run it names. `parentRunId` is `another-run`, so a child's rows are never
 * filed in its parent's group. The contract's list holds only `this-run` keys, so the filter
 * below drops nothing today; it fails closed for a key added there but not reviewed here.
 */
export const RUN_ATTRIBUTION_BY_PAYLOAD_KEY: Readonly<
  Record<RunNamingPayloadKey, RunAttributionRole>
> = {
  runId: "this-run",
  targetRunId: "this-run",
  parentRunId: "another-run",
  // A workflow run, which is not one of the session's runs.
  workflowRunId: "another-run",
  // The run holding a terminal: the row is about the terminal, not that run.
  holderRunId: "another-run",
};

/** The decided members that attribute, as the lookup below asks them. */
const ATTRIBUTING_PAYLOAD_MEMBERS: ReadonlySet<string> = new Set(
  Object.entries(RUN_ATTRIBUTION_BY_PAYLOAD_KEY)
    .filter(([, role]) => role === "this-run")
    .map(([member]) => member),
);

/**
 * Reads the run a payload belongs to, or `undefined` where it belongs to none.
 *
 * Takes the open record, not an event, so this module stays free of the store's projection
 * contract; members are `unknown` there, so the string is checked.
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
