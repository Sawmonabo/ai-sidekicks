// Worktree status-read projection
//
// PURE FOLD, per the shipped `workspace/workspace-projector.ts` precedent and
// the `session/session-projector.ts` one behind it: no filesystem call, no
// clock read, no database handle, no I/O of any kind. The caller reads the
// rows; this module turns the rows it is HANDED into the ratified
// `WorktreeStatusReadResponse` and does nothing else. Rows arrive as
// arguments, never through an import — which is what lets every branch below
// be driven deterministically from a test with no database and no temp
// directory.
//
//   • "`WorktreeStatusRead` must expose the session's worktree records —
//     lifecycle state, branch, cleanup bookkeeping, and provenance — as a
//     daemon-owned read surface." All four axes are carried below: lifecycle
//     (`state`), branch (`branchName`), cleanup bookkeeping (`cleanedAt`), and
//     provenance (`createdBySessionId` / `createdByRunId`).
//   • "Dirty and merged state belong to daemon-owned workspace projections."
//     `dirty` and `merged` are DAEMON verdicts that arrive on the `worktrees`
//     row; their `-> dirty` / `-> merged` transitions belong to the
//     run-integration layer above not to any Phase-2 writer (the plan's Phase 3
//     record carries the ownership). This projection carries whatever state the
//     row holds verbatim and infers cleanliness from nothing — there is no
//     working-tree read here, and there could not be: the module performs no I/O.
//
// Both statements, and the reasoning for what each half owes, are spelled out
// below.
//
// Invariants carried here:
//   • Views render daemon verdicts verbatim and derive nothing (no client-side
//     expiry math, no cleanliness inference, no root computation). Structural
//     rather than merely disciplined: this module owns no clock and no
//     filesystem, so `fsRoot` cannot be re-resolved or normalized. The response
//     carries exactly the ratified field set, so there is nowhere to put a
//     derived value even if one existed.
//   • Never-hide: the projection returns EVERY row it is handed, `failed` and
//     `retired` included. The invariant is worded view-side ("status views
//     render every row the status read returns"), and this is its
//     precondition: a view cannot render a row the read filtered away. The
//     only narrowing below is the caller's explicit `repoMountId` filter — a
//     REQUEST parameter, never a state judgment. No branch in this module
//     reads a row's `state` at all; the field is copied across and validated,
//     never tested.
//
// ---------------------------------------------------------------------------
// The rows it takes
// ---------------------------------------------------------------------------
//
// The caller reads the rows; this module reads no table. Each row carries a
// `session_id` beside the `worktrees` columns: the session the caller read it
// for, which is not a `worktrees` column and is distinct from
// `created_by_session_id`. The projection refuses any row whose `session_id`
// disagrees with the request's, so a caller that mis-scoped its read fails
// loudly instead of leaking another session's worktrees.
//
// ORDER IS THE CALLER'S. This fold preserves the order it receives and never
// sorts: the response array declares no ordering, so a stable order is the
// caller's `ORDER BY` to choose.
//

import {
  WorktreeStatusReadResponseSchema,
  type WorktreeStatusReadRequest,
  type WorktreeStatusReadResponse,
} from "@ai-sidekicks/contracts";

// --------------------------------------------------------------------------
// Row inputs — what the caller read, handed in
// --------------------------------------------------------------------------

/**
 * The `worktrees` columns this projection reads, plus the caller-supplied
 * `session_id` documented in the file header.
 *
 * snake_case, matching the DDL and what `better-sqlite3` hands back verbatim.
 * The COLUMN → WIRE-FIELD rename IS the fold this module owns, which is why
 * the input is the raw row rather than the camelCase structural view the
 * sibling `workspace-projector.ts` takes: that projector consumes a VERDICT (a
 * probe result) plus a column or two, so adapting at the call site costs
 * nothing, while here an adapter at the call site would relocate half the
 * projection into a caller where nothing tests it.
 */
export interface WorktreeStatusRow {
  /** `worktrees.id` — the wire's `worktreeId` (qualified there, bare here). */
  readonly id: string;
  /** The owning mount. Also the key the request's optional filter narrows on. */
  readonly repo_mount_id: string;
  /**
   * Not a `worktrees` column: the session the caller read this row for. The
   * read's scoping key, distinct from `created_by_session_id` below — see the
   * file header.
   */
  readonly session_id: string;
  /** Creating-session provenance (`NOT NULL` makes it unconditional). */
  readonly created_by_session_id: string;
  /**
   * Creating-run provenance, `NULL` for a pre-run explicit prepare. The
   * asymmetry with `created_by_session_id` IS the provenance contract, not an
   * inconsistency.
   */
  readonly created_by_run_id: string | null;
  readonly branch_name: string;
  readonly fs_root: string;
  /**
   * The raw column, typed `string` rather than `WorktreeState` on purpose: a
   * database row can carry a value the compiler never saw, and the parse
   * boundary at the end of the fold is what refuses it. Typing the row as the
   * enum would move that refusal to a cast in the caller, where it checks
   * nothing.
   */
  readonly state: string;
  readonly created_at: string;
  readonly updated_at: string;
  /** The async disk-cleanup stamp; `NULL` until the sweep runs. */
  readonly cleaned_at: string | null;
}

/** One read's worth of rows: the array the response's array is folded from. */
export interface WorktreeStatusRowSet {
  readonly worktrees: readonly WorktreeStatusRow[];
}

// --------------------------------------------------------------------------
// Drafts — the fold's output, before the parse brands it
// --------------------------------------------------------------------------
//
// Module-private and unbranded: the fold produces plain strings, and
// `WorktreeStatusReadResponseSchema.parse` is what turns them into the branded
// wire type. That ordering is what keeps this file free of a single `as` cast
// — every id, enum member, timestamp, and length bound is checked by the
// canonical schema rather than asserted by the author.

interface WorktreeStatusRecordDraft {
  readonly worktreeId: string;
  readonly repoMountId: string;
  readonly branchName: string;
  readonly fsRoot: string;
  readonly state: string;
  readonly createdBySessionId: string;
  readonly createdByRunId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly cleanedAt?: string;
}

interface WorktreeStatusReadResponseDraft {
  readonly worktrees: readonly WorktreeStatusRecordDraft[];
}

// The draft above is an unbranded restatement of the ratified record shape,
// so nothing structural ties them to contracts: add a required field there and
// this file still compiles, failing only at runtime on the first read. The
// alias below closes that gap the same way the sibling emitter does. `keyof`
// compares KEY NAMES only — no branded type is reintroduced into the draft,
// so the fold keeps producing plain strings and the parse stays the single
// place a brand is minted.
//
// Direction matters: ratified keys must be assignable to draft keys, which
// catches a field added to contracts. The converse is already covered at
// runtime by the schema's `.strict()` at the item level, which refuses a draft
// key contracts does not know.
type _AssertExtends<A extends B, B> = A;
type _AssertDraftCoversRatifiedWorktreeRecord = _AssertExtends<
  keyof WorktreeStatusReadResponse["worktrees"][number],
  keyof WorktreeStatusRecordDraft
>;

// --------------------------------------------------------------------------
// --------------------------------------------------------------------------

/**
 * Fold one session's worktree rows onto the ratified
 * `repo.worktreeStatusRead` response.
 *
 * Two narrowings, and it is worth being precise about which is which. The
 * request's `repoMountId` is an OPTIONAL FILTER the caller asked for — absent
 * means the whole session, present means one mount's records — and it is the
 * only reason a handed-in row may be left out. The session guard is not a
 * filter at all: a row from another session is refused outright, because it is
 * not this read's row in any sense and dropping it silently would hide the
 * caller's mispaired query rather than report it.
 *
 * Every row is session-checked BEFORE the mount filter runs. The reverse order
 * would let a foreign row that happens to sit on a filtered-out mount slip
 * past the guard unexamined — a leak the next call, with no filter, would then
 * commit.
 *
 * The array is always present, empty when the session holds no records:
 * required-but-empty is a lawful answer the ratified shape declares (it
 * carries no `.min(1)`), not a degenerate one.
 */
export function projectWorktreeStatusRead(
  request: WorktreeStatusReadRequest,
  rows: WorktreeStatusRowSet,
): WorktreeStatusReadResponse {
  const worktrees: WorktreeStatusRecordDraft[] = [];
  for (const row of rows.worktrees) {
    assertRowBelongsToReadSession(row.session_id, request.sessionId, row.id);
    if (!matchesRequestedMount(row.repo_mount_id, request.repoMountId)) {
      continue;
    }
    // Field by field, never a spread of the row: the record schema carries
    // `.strict()` at the ITEM level as well as the envelope level, so a stray
    // column carried across by a spread would fail the whole read rather than
    // be dropped.
    worktrees.push({
      worktreeId: row.id,
      repoMountId: row.repo_mount_id,
      branchName: row.branch_name,
      fsRoot: row.fs_root,
      state: row.state,
      createdBySessionId: row.created_by_session_id,
      // OMITTED, never `undefined`: `exactOptionalPropertyTypes` plus the
      // schema's `.optional()` accept both spellings, and an explicit
      // `undefined` would survive to the wire as a present key with a null-ish
      // value in some serializers. Absence is what "no run to attribute" means.
      //
      // The test is POSITIVE MEMBERSHIP, not `=== null`. The row interfaces
      // above describe what query is asked to hand over, and driver rows reach
      // this fold through an unchecked cast: a column the query forgot to
      // select arrives as `undefined`, which a `=== null` test would wave
      // through and ship as a present key with an `undefined` value (Zod
      // preserves explicit-undefined key presence). Requiring a string is the
      // spelling that fails closed on the shape this file cannot type-check.
      ...(typeof row.created_by_run_id === "string"
        ? { createdByRunId: row.created_by_run_id }
        : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      // Same discipline, and here the absence is load-bearing information: a
      // `retired` row with no `cleanedAt` is the observable half of the
      // recorded-then-cleaned ordering — missing information about the world,
      // not a missing field.
      ...(typeof row.cleaned_at === "string" ? { cleanedAt: row.cleaned_at } : {}),
    });
  }

  return parseProjection({ worktrees });
}

// --------------------------------------------------------------------------
// Guards
// --------------------------------------------------------------------------

/**
 * Refuse a row the read's session does not own.
 *
 * The session-scoped twin of the sibling projector's mispaired-probe guard,
 * and the reasoning is the same one step up in severity: attributing another
 * subject's data to this one produces a confident, wrong answer that no
 * downstream surface can detect. Here the wrong answer would disclose another
 * session's execution roots and branch names on a session-scoped read.
 *
 * THROWS rather than filters, deliberately. A foreign row is not a hidden
 * state — the never-hide posture is about lifecycle positions of the
 * session's OWN rows — it is a caller defect, and a silent drop would let a
 * mispaired query keep running.
 *
 * The other session's id is not named in the message: a daemon error can reach
 * a remote caller through the JSON-RPC error mapping, and the row id alone
 * identifies the defect for whoever repairs the query.
 */
function assertRowBelongsToReadSession(
  rowSessionId: string,
  readSessionId: string,
  rowId: string,
): void {
  if (rowSessionId === readSessionId) {
    return;
  }
  throw new Error(
    "Worktree status-read projection refused a worktree row owned by a different session " +
      `than the one being read: row "${rowId}". Projecting it would disclose another session's ` +
      "execution roots on a session-scoped read, and no downstream surface could detect the " +
      "disclosure. The owning session is deliberately not named here.",
  );
}

/** The request's optional mount filter: absent admits every mount. */
function matchesRequestedMount(
  rowRepoMountId: string,
  requestedRepoMountId: string | undefined,
): boolean {
  return requestedRepoMountId === undefined || rowRepoMountId === requestedRepoMountId;
}

/**
 * Validate the folded response through the canonical schema — the same stance
 * the sibling projector takes on `RepoMountHealthSchema`: this is a wire shape,
 * so a row that cannot be projected fails HERE, at the projection that produced
 * it, instead of surviving to the outbound response-validation boundary where
 * the failure would be attributed to the whole read.
 *
 * The parse is also what makes the fold above cast-free: branded ids, the
 * state vocabulary, the ISO-8601 instants, and the length caps are all checked
 * by the ratified schema rather than asserted by this module.
 *
 * The `ZodError` rides as `cause` rather than being re-formatted: its issue
 * path already names the array, the record's index, and the field
 * (`worktrees[3].state`), which is the attribution — re-deriving a row id from
 * that index would be archaeology over an array the mount filter has already
 * narrowed.
 */
function parseProjection(draft: WorktreeStatusReadResponseDraft): WorktreeStatusReadResponse {
  try {
    return WorktreeStatusReadResponseSchema.parse(draft);
  } catch (error) {
    throw new Error(
      "Worktree status-read projection produced a value the ratified WorktreeStatusReadResponse shape " +
        "refuses. A row that cannot be projected fails the read at the projection that produced it; the " +
        "cause names the array, the record index, and the field.",
      { cause: error },
    );
  }
}
