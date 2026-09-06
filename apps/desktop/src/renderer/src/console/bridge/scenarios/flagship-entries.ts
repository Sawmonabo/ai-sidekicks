// The two entry builders the flagship script needs and no other scenario has.
//
// Split from the script beside it for the reason `apps/desktop/AGENTS.md` gives: one
// file holding both was 450 lines. The seam is the honest one — a builder answers
// what SHAPE a row of a given kind has, and the script answers WHICH rows this
// session plays and when. They change for different reasons: a builder changes when
// the registered payload does, and the script changes when a surface needs a beat.
//
// STILL LOCAL RATHER THAN HOISTED INTO THE SHARED VOCABULARY. This is the only
// scenario that meters a cost or raises an approval today, and that document hoists
// a helper on its SECOND use. A module beside the one caller is not a second home
// for these shapes; it is the same home, split at a seam.

import { type LedgerScriptEntry } from "./ledger-script.js";
import { RUN_IMPLEMENTER, SESSION_ID } from "./flagship-cast.js";

/**
 * One cost reading, in the shape `Spec-006 §Usage Telemetry (usage_telemetry)` registers for it.
 *
 * The three required members are carried in full — `usage.cost_update` MUST set
 * `costStatus` and `costSource`, and post-2026-08-26 emitters MUST set
 * `effectivePrincipal` — because a partial row here would teach a meter to read a
 * shape no emitter produces, which is the defect `scenarios/wire-truth.ts`'
 * taxonomy-leg rule exists to prevent and which the code leg cannot see: no strict
 * variant is registered for this type yet.
 */
export function costUpdateEntry(input: {
  readonly atMs: number;
  readonly runId: string;
  readonly costCents: number;
  readonly causedBy: string;
}): LedgerScriptEntry {
  return {
    atMs: input.atMs,
    kind: "usage.cost_update",
    payload: {
      sessionId: SESSION_ID,
      runId: input.runId,
      costCents: input.costCents,
      costStatus: "priced",
      costSource: "provider_reported",
      effectivePrincipal: { kind: "participant", participantId: input.causedBy },
    },
  };
}

/**
 * The one approval this session raises, and the identity every row of it shares.
 *
 * A request and its grant are two rows about ONE request, so they carry one id: a
 * pair with two would be two approvals, one of them never answered and one answered
 * without ever having been asked.
 */
const APPROVAL_REQUEST_ID = "019b79ee-0280-7b12-8150-a11a0c150001";

/** What was asked for, in the vocabulary the approval contract types as free text. */
export const APPROVAL_SCOPE = "run";

/** The provider account this session's lanes are admitted against. */
export const PROVIDER_ACCOUNT_ID = "019b79ee-0280-7c34-8160-b21a0c150001";

/**
 * One approval row, in the shape `Spec-006 §Approval Flow (approval_flow)` registers.
 *
 * The members that differ between a request and its resolution are the caller's —
 * that spec's row makes `requestedBy` and `resourceDescriptor` present on the
 * request and `approver` and `effectiveScope` present on the resolution, and a row
 * carrying the other pair would be a shape no emitter produces.
 */
export function approvalEntry(input: {
  readonly atMs: number;
  readonly kind: string;
  readonly actorId?: string;
  readonly members: Readonly<Record<string, unknown>>;
}): LedgerScriptEntry {
  return {
    atMs: input.atMs,
    kind: input.kind,
    ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
    payload: {
      sessionId: SESSION_ID,
      runId: RUN_IMPLEMENTER,
      approvalRequestId: APPROVAL_REQUEST_ID,
      // The category the wire's closed set names for a write to the working tree,
      // which is what this run asked to do.
      category: "file_write",
      scope: APPROVAL_SCOPE,
      ...input.members,
    },
  };
}
