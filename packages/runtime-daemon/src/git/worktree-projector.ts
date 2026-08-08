// Worktree and ephemeral-clone status-read projection — Plan-010 T2.5.
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
// Spec coverage:
//   • `Spec-010 §Interfaces And Contracts` — "`WorktreeStatusRead` must expose
//     the session's worktree and ephemeral-clone records — lifecycle state,
//     branch, cleanup bookkeeping, and provenance — as a daemon-owned read
//     surface." All four axes are carried below for BOTH record kinds:
//     lifecycle (`state`), branch (`branchName`), cleanup bookkeeping
//     (`cleanedAt`, plus the clone's `cleanupPolicy` + `expiresAt`), and
//     provenance (`createdBySessionId` / `createdByRunId` on the worktree
//     record; the clone's owning `workspaceId`).
//   • `Spec-010 §State And Data Implications` — "Dirty and merged state belong
//     to daemon-owned workspace projections." `dirty` and `merged` are DAEMON
//     verdicts that arrive on the `worktrees` row; their `-> dirty` / `-> merged`
//     transitions belong to the run-integration layer above T2.2, not to any
//     Phase-2 writer (the plan's Phase 3 record carries the ownership). This
//     projection carries whatever state the row holds verbatim and infers
//     cleanliness from nothing — there is no working-tree read here, and there
//     could not be: the module performs no I/O.
//
// Verifies invariant: I-010-20 (daemon half), I-010-19 (daemon half) — both
// statements, and the reasoning for what each half owes, are spelled out below.
//
// Invariants carried here:
//   • I-010-20 (daemon half) — views render daemon verdicts verbatim and
//     derive nothing (no client-side expiry math, no cleanliness inference, no
//     root computation). The VIEW half is Phase 4's (T4.1–T4.4); the half that
//     lands here is its precondition — every value a view renders arrives
//     already resolved daemon-side, byte-identical to the column it came from.
//     Structural rather than merely disciplined: this module owns no clock, so
//     `expiresAt` CANNOT become a remaining-TTL or an `expired` flag, and it
//     owns no filesystem, so `fsRoot` / `cloneRoot` cannot be re-resolved or
//     normalized. The response carries exactly the ratified field set, so
//     there is nowhere to put a derived value even if one existed.
//   • I-010-19 (daemon half) — never-hide: the projection returns EVERY row it
//     is handed, `failed` and `retired` included. The invariant is worded
//     view-side ("status views render every row the status read returns"), and
//     this is its precondition: a view cannot render a row the read filtered
//     away. The only narrowing below is the caller's explicit `repoMountId`
//     filter — a REQUEST parameter, never a state judgement. No branch in this
//     module reads a row's `state` at all; the field is copied across and
//     validated, never tested.
//
// ---------------------------------------------------------------------------
// The row-read seam this projection obliges (T3.4's status-read binder)
// ---------------------------------------------------------------------------
//
// SESSION SCOPING RIDES `repo_mounts`, not the rows themselves. Neither table
// carries the reading session: `worktrees.created_by_session_id` is
// PROVENANCE (which session created this checkout — I-010-3, preserved through
// retirement) and is a different question from which session may read it,
// since a worktree outlives its creating run while the MOUNT is what a session
// holds. So both row shapes below carry a join-supplied `session_id` beside
// the table's own columns, and the projection refuses any row whose value
// disagrees with the request's:
//
//   worktrees         SELECT w.*, m.session_id
//                     FROM worktrees w
//                     JOIN repo_mounts m ON m.id = w.repo_mount_id
//                     WHERE m.session_id = :session_id
//
//   ephemeral_clones  SELECT c.*, ws.repo_mount_id, ws.session_id
//                     FROM ephemeral_clones c
//                     JOIN workspaces ws ON ws.id = c.workspace_id
//                     WHERE ws.session_id = :session_id
//
// The clone side reaches its mount through `workspaces` — its row is
// WORKSPACE-anchored where the worktree row is MOUNT-anchored (the asymmetry
// the ratified response shape carries, faithful to the DDL) — and that single
// join answers both questions at once: `workspaces.session_id` equals
// `repo_mounts.session_id` by construction, because a workspace inherits its
// mount's session at creation and never re-parents (Plan-009's
// `CreateDefaultWorkspaceInput.sessionId`: "the session the mount belongs to —
// the workspace inherits it, never a caller-supplied one").
//
// ORDER IS THE CALLER'S. This fold preserves the order it receives and never
// sorts: sorting would be a derivation, and the ratified response arrays
// declare no ordering. The stable rendering T4.2 needs is therefore the
// query's `ORDER BY` to own, not this module's — pick one there and the view
// inherits it unchanged.
//
// Refs: Plan-010 (worktree lifecycle and execution modes) T2.5, Plan-009 (the
// pure-projector precedent), D-010-17 (the daemon-owned status read),
// CP-010-7 (this Plan-010-owned `src/git/` subtree).

import {
  WorktreeStatusReadResponseSchema,
  type WorktreeStatusReadRequest,
  type WorktreeStatusReadResponse,
} from "@ai-sidekicks/contracts";

// --------------------------------------------------------------------------
// Row inputs — what the caller read, handed in
// --------------------------------------------------------------------------

/**
 * The `worktrees` columns this projection reads, plus the join-supplied
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
   * JOIN-SUPPLIED, not a `worktrees` column: `repo_mounts.session_id` for
   * `repo_mount_id`. The read's SCOPING key, and deliberately distinct from
   * `created_by_session_id` below — see the file header.
   */
  readonly session_id: string;
  /** Creating-session provenance (`NOT NULL`; I-010-3 makes it unconditional). */
  readonly created_by_session_id: string;
  /**
   * Creating-run provenance, `NULL` for a pre-run explicit prepare (D-010-5).
   * The asymmetry with `created_by_session_id` IS the provenance contract, not
   * an inconsistency.
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
  /** The async disk-cleanup stamp; `NULL` until the sweep runs (I-010-9). */
  readonly cleaned_at: string | null;
}

/**
 * The `ephemeral_clones` columns this projection reads, plus the two
 * join-supplied fields the file header's query spells out.
 *
 * `updated_at` is deliberately absent even though the column exists: the
 * ratified clone record carries no such field, and reading a column the
 * projection cannot emit would invite an item key the `.strict()` wire shape
 * refuses.
 */
export interface EphemeralCloneStatusRow {
  /** `ephemeral_clones.id` — the wire's `cloneId`. */
  readonly id: string;
  /** The owning workspace — the anchor the ratified clone record carries. */
  readonly workspace_id: string;
  /**
   * JOIN-SUPPLIED: `workspaces.repo_mount_id`. Not on the clone row and not on
   * the wire — it exists so the request's `repoMountId` filter narrows BOTH
   * arrays rather than only the worktrees.
   */
  readonly repo_mount_id: string;
  /** JOIN-SUPPLIED: `workspaces.session_id`. The scoping key; see the header. */
  readonly session_id: string;
  readonly clone_root: string;
  readonly branch_name: string;
  /** Raw column; the parse boundary refuses a value outside the vocabulary. */
  readonly cleanup_policy: string;
  /** Raw column, for the same reason as {@link WorktreeStatusRow.state}. */
  readonly state: string;
  readonly expires_at: string;
  readonly created_at: string;
  readonly cleaned_at: string | null;
}

/**
 * One read's worth of rows: the two arrays the response's two arrays are
 * folded from. A single parameter rather than two on cohesion grounds: one
 * read's rows are one value, and the two arrays are only ever assembled and
 * consumed together.
 */
export interface WorktreeStatusRowSet {
  readonly worktrees: readonly WorktreeStatusRow[];
  readonly ephemeralClones: readonly EphemeralCloneStatusRow[];
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

interface EphemeralCloneStatusRecordDraft {
  readonly cloneId: string;
  readonly workspaceId: string;
  readonly cloneRoot: string;
  readonly branchName: string;
  readonly state: string;
  readonly cleanupPolicy: string;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly cleanedAt?: string;
}

interface WorktreeStatusReadResponseDraft {
  readonly worktrees: readonly WorktreeStatusRecordDraft[];
  readonly ephemeralClones: readonly EphemeralCloneStatusRecordDraft[];
}

// The drafts above are unbranded restatements of the ratified record shapes,
// so nothing structural ties them to contracts: add a required field there and
// this file still compiles, failing only at runtime on the first read. The
// aliases below close that gap the same way the sibling emitter does. `keyof`
// compares KEY NAMES only — no branded type is reintroduced into the drafts,
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
type _AssertDraftCoversRatifiedCloneRecord = _AssertExtends<
  keyof WorktreeStatusReadResponse["ephemeralClones"][number],
  keyof EphemeralCloneStatusRecordDraft
>;

// --------------------------------------------------------------------------
// The projection (D-010-17)
// --------------------------------------------------------------------------

/**
 * Fold one session's worktree and ephemeral-clone rows onto the ratified
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
 * Both arrays are always present, empty when the session holds no records:
 * required-but-empty is a lawful answer the ratified shape declares (neither
 * array carries `.min(1)`), not a degenerate one.
 */
export function projectWorktreeStatusRead(
  request: WorktreeStatusReadRequest,
  rows: WorktreeStatusRowSet,
): WorktreeStatusReadResponse {
  const worktrees: WorktreeStatusRecordDraft[] = [];
  for (const row of rows.worktrees) {
    assertRowBelongsToReadSession(row.session_id, request.sessionId, "worktree", row.id);
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
      // above describe what the T3.4 query is asked to hand over, and driver
      // rows reach this fold through an unchecked cast: a column the query
      // forgot to select arrives as `undefined`, which a `=== null` test would
      // wave through and ship as a present key with an `undefined` value (Zod
      // preserves explicit-undefined key presence). Requiring a string is the
      // spelling that fails closed on the shape this file cannot type-check.
      ...(typeof row.created_by_run_id === "string"
        ? { createdByRunId: row.created_by_run_id }
        : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      // Same discipline, and here the absence is load-bearing information: a
      // `retired` row with no `cleanedAt` is the observable half of I-010-9's
      // recorded-then-cleaned ordering — missing information about the world,
      // not a missing field.
      ...(typeof row.cleaned_at === "string" ? { cleanedAt: row.cleaned_at } : {}),
    });
  }

  const ephemeralClones: EphemeralCloneStatusRecordDraft[] = [];
  for (const row of rows.ephemeralClones) {
    assertRowBelongsToReadSession(row.session_id, request.sessionId, "ephemeral clone", row.id);
    if (!matchesRequestedMount(row.repo_mount_id, request.repoMountId)) {
      continue;
    }
    ephemeralClones.push({
      cloneId: row.id,
      workspaceId: row.workspace_id,
      cloneRoot: row.clone_root,
      branchName: row.branch_name,
      state: row.state,
      cleanupPolicy: row.cleanup_policy,
      // VERBATIM, and this is the field I-010-20 names first: the stored TTL
      // deadline travels as the instant the daemon computed at prepare time.
      // No comparison against a clock happens here or downstream — an expired
      // clone is reported by its `state` once the sweep retires it, never by
      // arithmetic on this value.
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      ...(typeof row.cleaned_at === "string" ? { cleanedAt: row.cleaned_at } : {}),
    });
  }

  return parseProjection({ worktrees, ephemeralClones });
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
 * state — the never-hide posture (I-010-19) is about lifecycle positions of
 * the session's OWN rows — it is a caller defect, and a silent drop would let
 * a mispaired query keep running.
 *
 * The other session's id is not named in the message: a daemon error can reach
 * a remote caller through the JSON-RPC error mapping, and the row id alone
 * identifies the defect for whoever repairs the query.
 */
function assertRowBelongsToReadSession(
  rowSessionId: string,
  readSessionId: string,
  rowKind: "worktree" | "ephemeral clone",
  rowId: string,
): void {
  if (rowSessionId === readSessionId) {
    return;
  }
  throw new Error(
    `Worktree status-read projection refused a ${rowKind} row owned by a different session than the one ` +
      `being read: row "${rowId}". Projecting it would disclose another session's execution roots on a ` +
      "session-scoped read, and no downstream surface could detect the disclosure. The owning session is " +
      "deliberately not named here.",
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
 * The parse is also what makes the fold above cast-free: branded ids, the two
 * state vocabularies, the cleanup-policy literals, the ISO-8601 instants, and
 * both length caps are all checked by the ratified schema rather than asserted
 * by this module.
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
