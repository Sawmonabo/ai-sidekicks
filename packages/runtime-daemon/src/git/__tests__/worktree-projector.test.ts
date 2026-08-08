// worktree-projector — Plan-010 Phase 2 T2.5.
//
// Exercises the daemon-owned status-read projection the Phase-3 binder answers
// `repo.worktreeStatusRead` from. No database, no temp directory, no clock: the
// module under test performs no I/O, so every branch is driven by handing it
// rows directly — which is itself the property the purity block at the bottom
// pins.
//
// Coverage map (cites are the authoritative contract, not just the ACs):
//   * Never-hide: a fixture generated FROM the pinned state rosters — one row
//     per member of both vocabularies — projects every row, `failed` and
//     `retired` included, in the order it was handed in. Roster-generated
//     rather than hand-listed, so a seventh worktree state added to contracts
//     fails the roster's compile-time completeness pin AND forces a fixture
//     row, instead of landing silently uncovered while every assertion below
//     still passes.
//   * The four axes of the status-read bullet, for BOTH record kinds:
//     lifecycle state, branch, cleanup bookkeeping (`cleanedAt`, plus the
//     clone's `cleanupPolicy` + `expiresAt`), and provenance
//     (`createdBySessionId` / `createdByRunId`; the clone's `workspaceId`) —
//     including the two cleanup-bookkeeping shapes that differ only by
//     absence: a `retired` row before the sweep carries no `cleanedAt`, and
//     one after it does.
//   * Provenance survives: a worktree created by an EARLIER session on a
//     shared mount still reports its creator, unchanged — the read scopes on
//     the mount's session, never on the creating one.
//   * Daemon-owned verdicts, tested against inputs that would tempt a
//     derivation: an ALREADY-EXPIRED `expiresAt` projects byte-identical with
//     no expiry field anywhere, a non-normalized root passes through
//     untouched, and `dirty` / `merged` — the daemon's cleanliness verdicts —
//     are carried verbatim with no cleanliness field invented. The record key
//     census is what closes "no derived field": equality of values cannot
//     catch a field that was ADDED.
//   * Omitted-optional discipline by KEY census, not value equality: under
//     `exactOptionalPropertyTypes` plus `.strict()`, both an absent key and an
//     explicit `undefined` typecheck and parse, so only `Object.keys` catches
//     the second. Two INPUT shapes reach that census — a `null` column, and a
//     column the query never selected, which arrives `undefined` through
//     T3.4's unchecked row cast — and both must project as an absent key.
//   * The `repoMountId` filter narrows BOTH arrays; omitted returns the whole
//     session; a mount holding nothing returns two empty arrays, as does an
//     empty read.
//   * Session binding: a row owned by another session is REFUSED, for both
//     record kinds, before the mount filter can hide the mispairing — the
//     ordering pinned once PER ARM, since the two loops can be reordered
//     independently — and the other session's id stays out of the message.
//   * The parse boundary can actually fail (negative control): a state outside
//     the closed vocabulary, a cleanup policy outside its own, and a
//     non-ISO instant each throw at the projection with the `ZodError` as
//     cause.
//   * Purity: the module's static-import census is exactly the contracts
//     package — no sibling module that could pull I/O in transitively — with
//     no dynamic-import or require escape hatch, checked by an extractor that
//     is itself negative-controlled across all three static import forms.
//
// Spec coverage: `Spec-010 §Interfaces And Contracts` (the `WorktreeStatusRead`
// bullet — the session's worktree and ephemeral-clone records exposing
// lifecycle state, branch, cleanup bookkeeping, and provenance as a
// daemon-owned read surface); `Spec-010 §State And Data Implications` (dirty
// and merged state belong to daemon-owned projections — carried verbatim here,
// inferred nowhere).
// Verifies invariant: I-010-20 (the daemon half — every rendered value is
// resolved daemon-side and travels byte-identical to its column, so no view
// does expiry math, cleanliness inference, or root computation), I-010-19 (the
// daemon half — the projection filters no row out by state, so a view has
// every row to render).

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  WorktreeStatusReadRequestSchema,
  type EphemeralCloneState,
  type WorktreeState,
  type WorktreeStatusReadRequest,
  type WorktreeStatusReadResponse,
} from "@ai-sidekicks/contracts";

import { projectWorktreeStatusRead } from "../worktree-projector.js";
import type {
  EphemeralCloneStatusRow,
  WorktreeStatusRow,
  WorktreeStatusRowSet,
} from "../worktree-projector.js";

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------

// Real UUIDs: every id below is parsed through a branded UUID schema at the
// projection's parse boundary, so counters would fail for the wrong reason.
const SESSION_ID: string = randomUUID();
const OTHER_SESSION_ID: string = randomUUID();
const CREATING_SESSION_ID: string = randomUUID();
const MOUNT_A_ID: string = randomUUID();
const MOUNT_B_ID: string = randomUUID();
const WORKSPACE_A_ID: string = randomUUID();
const WORKSPACE_B_ID: string = randomUUID();
const RUN_ID: string = randomUUID();

// RFC 3339 UTC with milliseconds — the form every daemon surface writes
// (`new Date().toISOString()`) and the form `z.iso.datetime({ offset: true })`
// accepts.
const CREATED_AT: string = "2026-08-04T12:00:00.000Z";
const UPDATED_AT: string = "2026-08-04T12:05:00.000Z";
const CLEANED_AT: string = "2026-08-04T12:30:00.000Z";

// Paths are never touched — nothing here opens a file — so they need not
// exist. The clone root is deliberately NON-NORMALIZED (trailing slash): the
// projection must not tidy it.
const WORKTREE_FS_ROOT: string = "/srv/sessions/execution-roots/worktrees/task-a";
const CLONE_ROOT: string = "/srv/sessions/execution-roots/clones/task-b/";

// The full worktree and clone vocabularies. Each roster carries the SAME pair
// of checks the shipped `workspace-projector.test.ts` applies to its own:
// `satisfies` proves every element is a real member, and the `_AssertExtends`
// alias beneath proves every member is an element. With only the first, a
// state added to contracts would leave the never-hide fixture passing
// VACUOUSLY over a stale roster — precisely the drift I-010-19's daemon half
// exists to catch.
const ALL_WORKTREE_STATES = [
  "creating",
  "ready",
  "dirty",
  "merged",
  "retired",
  "failed",
] as const satisfies readonly WorktreeState[];

const ALL_EPHEMERAL_CLONE_STATES = [
  "creating",
  "ready",
  "retired",
  "failed",
] as const satisfies readonly EphemeralCloneState[];

// Contracts exports no `CleanupPolicy` type by design, so the roster below
// recovers the wire union by indexed access into the ratified response — the
// same idiom `worktree-event-emitter.ts` uses to recover event names from its
// variant interfaces. Without it this roster would be the one pin with no
// completeness check, and a third policy would leave the cleanup-bookkeeping
// axis of `Spec-010 §Interfaces And Contracts` asserted over a stale pair.
type CleanupPolicyOnTheWire =
  WorktreeStatusReadResponse["ephemeralClones"][number]["cleanupPolicy"];

const ALL_CLEANUP_POLICIES = [
  "on_run_complete",
  "manual",
] as const satisfies readonly CleanupPolicyOnTheWire[];

// The `_` prefix is what the root eslint config's `varsIgnorePattern` exempts
// from `no-unused-vars`; the aliases exist to be type-checked, not read.
type _AssertExtends<A extends B, B> = A;
type _AssertWorktreeStateRosterIsComplete = _AssertExtends<
  WorktreeState,
  (typeof ALL_WORKTREE_STATES)[number]
>;
type _AssertEphemeralCloneStateRosterIsComplete = _AssertExtends<
  EphemeralCloneState,
  (typeof ALL_EPHEMERAL_CLONE_STATES)[number]
>;
type _AssertCleanupPolicyRosterIsComplete = _AssertExtends<
  CleanupPolicyOnTheWire,
  (typeof ALL_CLEANUP_POLICIES)[number]
>;

const BASE_WORKTREE_ROW: WorktreeStatusRow = {
  id: randomUUID(),
  repo_mount_id: MOUNT_A_ID,
  session_id: SESSION_ID,
  created_by_session_id: SESSION_ID,
  created_by_run_id: null,
  branch_name: "sidekicks/8f2a1c/add-status-view",
  fs_root: WORKTREE_FS_ROOT,
  state: "ready",
  created_at: CREATED_AT,
  updated_at: UPDATED_AT,
  cleaned_at: null,
};

const BASE_CLONE_ROW: EphemeralCloneStatusRow = {
  id: randomUUID(),
  workspace_id: WORKSPACE_A_ID,
  repo_mount_id: MOUNT_A_ID,
  session_id: SESSION_ID,
  clone_root: CLONE_ROOT,
  branch_name: "sidekicks/8f2a1c/probe-run",
  cleanup_policy: "on_run_complete",
  state: "ready",
  expires_at: "2026-08-05T12:00:00.000Z",
  created_at: CREATED_AT,
  cleaned_at: null,
};

/** A `worktrees` row with a fresh id, overridden field by field. */
function worktreeRow(overrides: Partial<WorktreeStatusRow> = {}): WorktreeStatusRow {
  return { ...BASE_WORKTREE_ROW, id: randomUUID(), ...overrides };
}

/** An `ephemeral_clones` row with a fresh id, overridden field by field. */
function cloneRow(overrides: Partial<EphemeralCloneStatusRow> = {}): EphemeralCloneStatusRow {
  return { ...BASE_CLONE_ROW, id: randomUUID(), ...overrides };
}

function rowSet(
  worktrees: readonly WorktreeStatusRow[] = [],
  ephemeralClones: readonly EphemeralCloneStatusRow[] = [],
): WorktreeStatusRowSet {
  return { worktrees, ephemeralClones };
}

/**
 * A row as a query that FORGOT a column hands it over: the key is absent, so
 * the field reads `undefined` rather than `null`. The row interfaces cannot
 * express that — hence the one row-shape cast in this file — but T3.4's rows
 * will arrive through an unchecked cast of their own, which is exactly why
 * the projection tests positive membership rather than `=== null`.
 */
function withColumnOmitted<Row extends object>(row: Row, column: keyof Row & string): Row {
  const { [column]: _omittedColumn, ...withoutColumn } = row;
  return withoutColumn as Row;
}

/**
 * A request built the way the Phase-3 binder builds it — through the ratified
 * schema, so the branded ids the projection compares against are real parses
 * rather than casts.
 */
function readRequest(repoMountId?: string): WorktreeStatusReadRequest {
  return WorktreeStatusReadRequestSchema.parse(
    repoMountId === undefined ? { sessionId: SESSION_ID } : { sessionId: SESSION_ID, repoMountId },
  );
}

function project(rows: WorktreeStatusRowSet, repoMountId?: string): WorktreeStatusReadResponse {
  return projectWorktreeStatusRead(readRequest(repoMountId), rows);
}

/**
 * The single worktree record of a one-row projection.
 *
 * Both accessors below THROW on an empty array rather than returning
 * `undefined`, and that is the point: every absence assertion in this file
 * (`Object.keys(...)` not containing an optional key, `"field" in record`)
 * would pass VACUOUSLY against a missing record — an optional-chained read of
 * a row the projection dropped looks exactly like a row it projected without
 * the field. A projection that returned nothing at all would then satisfy the
 * omitted-optional tests it was written to constrain.
 */
function onlyWorktreeRecord(
  response: WorktreeStatusReadResponse,
): WorktreeStatusReadResponse["worktrees"][number] {
  const [record] = response.worktrees;
  if (record === undefined || response.worktrees.length !== 1) {
    throw new Error(
      `expected exactly one projected worktree record, got ${String(response.worktrees.length)}`,
    );
  }
  return record;
}

/** The single ephemeral-clone record of a one-row projection; see above. */
function onlyCloneRecord(
  response: WorktreeStatusReadResponse,
): WorktreeStatusReadResponse["ephemeralClones"][number] {
  const [record] = response.ephemeralClones;
  if (record === undefined || response.ephemeralClones.length !== 1) {
    throw new Error(
      `expected exactly one projected clone record, got ${String(response.ephemeralClones.length)}`,
    );
  }
  return record;
}

/** The message of whatever the call threw, or `""` when it did not throw. */
function messageThrownBy(call: () => unknown): string {
  try {
    call();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "";
}

// ----------------------------------------------------------------------------
// Never-hide — I-010-19's daemon half
// ----------------------------------------------------------------------------

describe("projectWorktreeStatusRead — never-hide (I-010-19, daemon half)", () => {
  it("projects a worktree row in EVERY state, `failed` and `retired` included", () => {
    const rows = ALL_WORKTREE_STATES.map((state) => worktreeRow({ state }));

    const response = project(rowSet(rows));

    // Length and per-position state together: a projection that dropped one
    // row and duplicated another would satisfy either check alone.
    expect(response.worktrees).toHaveLength(ALL_WORKTREE_STATES.length);
    expect(response.worktrees.map((record) => record.state)).toEqual([...ALL_WORKTREE_STATES]);
    // Named explicitly, because these two are the invariant's whole subject:
    // the admit-not-eject posture is about the states a filter would be
    // tempted to eject.
    expect(response.worktrees.map((record) => record.state)).toContain("failed");
    expect(response.worktrees.map((record) => record.state)).toContain("retired");
  });

  it("projects an ephemeral-clone row in EVERY state, `failed` and `retired` included", () => {
    const rows = ALL_EPHEMERAL_CLONE_STATES.map((state) => cloneRow({ state }));

    const response = project(rowSet([], rows));

    expect(response.ephemeralClones).toHaveLength(ALL_EPHEMERAL_CLONE_STATES.length);
    expect(response.ephemeralClones.map((record) => record.state)).toEqual([
      ...ALL_EPHEMERAL_CLONE_STATES,
    ]);
    expect(response.ephemeralClones.map((record) => record.state)).toContain("failed");
    expect(response.ephemeralClones.map((record) => record.state)).toContain("retired");
  });

  it("preserves the caller's row order and never sorts", () => {
    // Ordering is the query's to own (the module header's seam note), so the
    // fold must not impose one of its own — a view that re-reads gets the same
    // sequence its ORDER BY produced.
    const rows = [
      worktreeRow({ state: "retired" }),
      worktreeRow({ state: "creating" }),
      worktreeRow({ state: "merged" }),
    ];

    const response = project(rowSet(rows));

    expect(response.worktrees.map((record) => record.worktreeId)).toEqual(
      rows.map((row) => row.id),
    );
  });

  it("returns two empty arrays for a session holding no records", () => {
    // Required-but-empty is a lawful answer the ratified shape declares
    // (neither array carries `.min(1)`), which is what keeps the Phase-4 views
    // from distinguishing "no records" from "field omitted".
    expect(project(rowSet())).toEqual({ worktrees: [], ephemeralClones: [] });
  });
});

// ----------------------------------------------------------------------------
// Lifecycle, branch, cleanup bookkeeping, provenance
// (`Spec-010 §Interfaces And Contracts`)
// ----------------------------------------------------------------------------

describe("projectWorktreeStatusRead — the four axes of the status read", () => {
  it("carries all four axes of a worktree record, field for field", () => {
    const row = worktreeRow({
      state: "retired",
      created_by_session_id: CREATING_SESSION_ID,
      created_by_run_id: RUN_ID,
      cleaned_at: CLEANED_AT,
    });

    const record = onlyWorktreeRecord(project(rowSet([row])));

    expect(record).toEqual({
      worktreeId: row.id,
      repoMountId: MOUNT_A_ID,
      // BRANCH.
      branchName: row.branch_name,
      fsRoot: WORKTREE_FS_ROOT,
      // LIFECYCLE STATE.
      state: "retired",
      // PROVENANCE — both halves, the required creating session and the
      // optional creating run.
      createdBySessionId: CREATING_SESSION_ID,
      createdByRunId: RUN_ID,
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
      // CLEANUP BOOKKEEPING.
      cleanedAt: CLEANED_AT,
    });
  });

  it("carries all four axes of an ephemeral-clone record, field for field", () => {
    const row = cloneRow({
      state: "retired",
      cleanup_policy: "manual",
      cleaned_at: CLEANED_AT,
      workspace_id: WORKSPACE_B_ID,
    });

    const record = onlyCloneRecord(project(rowSet([], [row])));

    expect(record).toEqual({
      cloneId: row.id,
      // PROVENANCE, clone-side: the owning workspace this root was
      // provisioned for (the clone record is workspace-anchored where the
      // worktree record is mount-anchored).
      workspaceId: WORKSPACE_B_ID,
      cloneRoot: CLONE_ROOT,
      // BRANCH.
      branchName: row.branch_name,
      // LIFECYCLE STATE.
      state: "retired",
      // CLEANUP BOOKKEEPING — all three of the clone's.
      cleanupPolicy: "manual",
      expiresAt: row.expires_at,
      createdAt: CREATED_AT,
      cleanedAt: CLEANED_AT,
    });
  });

  it("omits `createdByRunId` for a pre-run prepare rather than sending it undefined", () => {
    const record = onlyWorktreeRecord(project(rowSet([worktreeRow({ created_by_run_id: null })])));

    // KEY census, not `toBeUndefined()`: an explicit `undefined` would pass a
    // value check and still ship a present key.
    expect(Object.keys(record)).not.toContain("createdByRunId");
    expect("createdByRunId" in record).toBe(false);
  });

  it("omits `cleanedAt` on a retired-but-unswept row — I-010-9's observable half", () => {
    // A `retired` row whose disk removal has not run yet carries no cleanup
    // stamp. That absence is missing information about the WORLD, not a
    // missing field, and the two shapes must stay distinguishable.
    const beforeSweep = onlyWorktreeRecord(
      project(rowSet([worktreeRow({ state: "retired", cleaned_at: null })])),
    );
    const afterSweep = onlyWorktreeRecord(
      project(rowSet([worktreeRow({ state: "retired", cleaned_at: CLEANED_AT })])),
    );

    expect(Object.keys(beforeSweep)).not.toContain("cleanedAt");
    expect(beforeSweep.state).toBe("retired");
    expect(afterSweep.cleanedAt).toBe(CLEANED_AT);
  });

  it("omits `cleanedAt` on an unswept clone and carries it once stamped", () => {
    const beforeSweep = onlyCloneRecord(
      project(rowSet([], [cloneRow({ state: "retired", cleaned_at: null })])),
    );
    const afterSweep = onlyCloneRecord(
      project(rowSet([], [cloneRow({ state: "retired", cleaned_at: CLEANED_AT })])),
    );

    expect(Object.keys(beforeSweep)).not.toContain("cleanedAt");
    expect(beforeSweep.state).toBe("retired");
    expect(afterSweep.cleanedAt).toBe(CLEANED_AT);
  });

  it("omits an optional field when the QUERY omitted the column, not just when it is null", () => {
    // The row interfaces declare these columns `string | null`, so this shape
    // is one the compiler says cannot happen — and T3.4 will produce it
    // anyway, because driver rows reach the fold through an unchecked cast and
    // a `SELECT` that forgets a column yields `undefined`, not `null`. A
    // null-only test would ship `{ createdByRunId: undefined }`: a present key
    // carrying nothing, which is the one shape the census above forbids.
    //
    // Each fixture is SEEDED with a non-null value for the column it then
    // drops. The base rows already carry `null` there, so omitting from an
    // unseeded row would leave the assertions green even if the helper stopped
    // omitting — the projection would drop the key for being null, and this
    // test, the sole detector of the present-undefined-key class, would cover
    // nothing. Seeding makes a no-op helper fail loudly.
    const worktreeMissingRun = withColumnOmitted(
      worktreeRow({ created_by_run_id: RUN_ID }),
      "created_by_run_id",
    );
    const worktreeMissingCleanup = withColumnOmitted(
      worktreeRow({ cleaned_at: CLEANED_AT }),
      "cleaned_at",
    );
    const cloneMissingCleanup = withColumnOmitted(
      cloneRow({ cleaned_at: CLEANED_AT }),
      "cleaned_at",
    );

    const worktreeWithoutRun = onlyWorktreeRecord(project(rowSet([worktreeMissingRun])));
    const worktreeWithoutCleanup = onlyWorktreeRecord(project(rowSet([worktreeMissingCleanup])));
    const cloneWithoutCleanup = onlyCloneRecord(project(rowSet([], [cloneMissingCleanup])));

    expect("createdByRunId" in worktreeWithoutRun).toBe(false);
    expect("cleanedAt" in worktreeWithoutCleanup).toBe(false);
    expect("cleanedAt" in cloneWithoutCleanup).toBe(false);
  });

  it("carries either cleanup policy verbatim, in the snake_case wire spelling", () => {
    const rows = ALL_CLEANUP_POLICIES.map((cleanupPolicy) =>
      cloneRow({ cleanup_policy: cleanupPolicy }),
    );

    const response = project(rowSet([], rows));

    expect(response.ephemeralClones.map((record) => record.cleanupPolicy)).toEqual([
      ...ALL_CLEANUP_POLICIES,
    ]);
  });

  it("reports the CREATING session, not the reading one — provenance survives", () => {
    // The read scopes on the mount's session; `created_by_session_id` answers
    // a different question and is untouched by scoping (I-010-3: provenance is
    // unconditional and survives retirement). A worktree an earlier session
    // created on a mount this session now reads still names its creator.
    const row = worktreeRow({
      session_id: SESSION_ID,
      created_by_session_id: CREATING_SESSION_ID,
      state: "retired",
    });

    const record = onlyWorktreeRecord(project(rowSet([row])));

    expect(record.createdBySessionId).toBe(CREATING_SESSION_ID);
    expect(record.createdBySessionId).not.toBe(SESSION_ID);
  });
});

// ----------------------------------------------------------------------------
// Daemon-owned projections — `Spec-010 §State And Data Implications`, I-010-20
// ----------------------------------------------------------------------------

describe("projectWorktreeStatusRead — daemon-owned verdicts (I-010-20, daemon half)", () => {
  it("carries the daemon's `dirty` and `merged` verdicts verbatim, inferring neither", () => {
    // Spec-010: dirty and merged state belong to daemon-owned projections.
    // They are resolved onto the row by the transitioning service; this fold
    // reports them and reads no working tree — it could not, owning no I/O.
    const dirtyRow = worktreeRow({ state: "dirty" });
    const mergedRow = worktreeRow({ state: "merged" });

    const response = project(rowSet([dirtyRow, mergedRow]));

    expect(response.worktrees.map((record) => record.state)).toEqual(["dirty", "merged"]);
    // And no cleanliness field is invented alongside them — the view has the
    // verdict and nothing to infer from.
    const dirtyRecordKeys = Object.keys(onlyWorktreeRecord(project(rowSet([dirtyRow]))));
    expect(dirtyRecordKeys).not.toContain("isClean");
    expect(dirtyRecordKeys).not.toContain("dirty");
  });

  it("carries an ALREADY-EXPIRED `expiresAt` byte-identical, with no expiry math", () => {
    // The sharp case: a future-only fixture proves nothing, because a module
    // doing expiry math would still report a future deadline unchanged. A
    // deadline years in the past is what a clock-reading projection could not
    // resist annotating.
    const expiredAt = "2020-01-01T00:00:00.000Z";
    const row = cloneRow({ state: "ready", expires_at: expiredAt });

    const record = onlyCloneRecord(project(rowSet([], [row])));

    expect(record.expiresAt).toBe(expiredAt);
    // Still `ready`: expiry is the sweep's transition to make, not this
    // module's to derive.
    expect(record.state).toBe("ready");
    const keys = Object.keys(record);
    expect(keys).not.toContain("expired");
    expect(keys).not.toContain("expiresIn");
    expect(keys).not.toContain("remainingMs");
  });

  it("passes a non-normalized root through untouched — no root computation", () => {
    const trailingSlashRoot = "/srv/sessions/execution-roots/worktrees/task-a/";
    const response = project(rowSet([worktreeRow({ fs_root: trailingSlashRoot })], [cloneRow()]));

    expect(onlyWorktreeRecord(response).fsRoot).toBe(trailingSlashRoot);
    expect(onlyCloneRecord(response).cloneRoot).toBe(CLONE_ROOT);
  });

  it("emits exactly the ratified worktree fields — nothing derived", () => {
    // Value equality cannot catch a field that was ADDED, so the key set is
    // asserted directly. Written in wire order and sorted here, so the literal
    // stays readable against the ratified block.
    const row = worktreeRow({ created_by_run_id: RUN_ID, cleaned_at: CLEANED_AT });

    const record = onlyWorktreeRecord(project(rowSet([row])));

    expect(Object.keys(record).sort()).toEqual(
      [
        "worktreeId",
        "repoMountId",
        "branchName",
        "fsRoot",
        "state",
        "createdBySessionId",
        "createdByRunId",
        "createdAt",
        "updatedAt",
        "cleanedAt",
      ].sort(),
    );
  });

  it("emits exactly the ratified clone fields — nothing derived", () => {
    const row = cloneRow({ cleaned_at: CLEANED_AT });

    const record = onlyCloneRecord(project(rowSet([], [row])));

    expect(Object.keys(record).sort()).toEqual(
      [
        "cloneId",
        "workspaceId",
        "cloneRoot",
        "branchName",
        "state",
        "cleanupPolicy",
        "expiresAt",
        "createdAt",
        "cleanedAt",
      ].sort(),
    );
  });

  it("emits exactly the two ratified arrays at the envelope level", () => {
    expect(Object.keys(project(rowSet())).sort()).toEqual(["ephemeralClones", "worktrees"]);
  });
});

// ----------------------------------------------------------------------------
// The `repoMountId` filter
// ----------------------------------------------------------------------------

describe("projectWorktreeStatusRead — the repoMountId filter", () => {
  const mountAWorktree = worktreeRow({ repo_mount_id: MOUNT_A_ID });
  const mountBWorktree = worktreeRow({ repo_mount_id: MOUNT_B_ID });
  const mountAClone = cloneRow({ repo_mount_id: MOUNT_A_ID, workspace_id: WORKSPACE_A_ID });
  const mountBClone = cloneRow({ repo_mount_id: MOUNT_B_ID, workspace_id: WORKSPACE_B_ID });
  const everything = rowSet([mountAWorktree, mountBWorktree], [mountAClone, mountBClone]);

  it("returns the whole session when the filter is omitted", () => {
    const response = project(everything);

    expect(response.worktrees.map((record) => record.worktreeId)).toEqual([
      mountAWorktree.id,
      mountBWorktree.id,
    ]);
    expect(response.ephemeralClones.map((record) => record.cloneId)).toEqual([
      mountAClone.id,
      mountBClone.id,
    ]);
  });

  it("narrows BOTH arrays when the filter names a mount", () => {
    // The clone side is the one that could silently escape the filter: its row
    // is workspace-anchored, so its mount arrives join-supplied.
    const response = project(everything, MOUNT_A_ID);

    expect(response.worktrees.map((record) => record.worktreeId)).toEqual([mountAWorktree.id]);
    expect(response.ephemeralClones.map((record) => record.cloneId)).toEqual([mountAClone.id]);
  });

  it("returns two empty arrays for a mount of this session that holds nothing", () => {
    const response = project(rowSet([mountAWorktree], [mountAClone]), MOUNT_B_ID);

    expect(response).toEqual({ worktrees: [], ephemeralClones: [] });
  });

  it("never filters on state — the filter is a mount key, not a lifecycle judgement", () => {
    const rows = ALL_WORKTREE_STATES.map((state) =>
      worktreeRow({ state, repo_mount_id: MOUNT_A_ID }),
    );

    const response = project(rowSet(rows), MOUNT_A_ID);

    expect(response.worktrees).toHaveLength(ALL_WORKTREE_STATES.length);
  });
});

// ----------------------------------------------------------------------------
// Session binding — the fail-closed guard
// ----------------------------------------------------------------------------

describe("projectWorktreeStatusRead — session binding", () => {
  it("refuses a worktree row owned by another session", () => {
    const foreign = worktreeRow({ session_id: OTHER_SESSION_ID });

    expect(() => project(rowSet([foreign]))).toThrow(/owned by a different session/);
  });

  it("refuses an ephemeral-clone row owned by another session", () => {
    const foreign = cloneRow({ session_id: OTHER_SESSION_ID });

    expect(() => project(rowSet([], [foreign]))).toThrow(/owned by a different session/);
  });

  // The guard-before-filter ordering is pinned PER ARM. The two loops are
  // separate code with separate orderings, so one case covering "the
  // projection checks before it filters" would leave the other arm free to
  // reorder — every other foreign-session fixture in this file projects with
  // NO filter, where the two orderings are indistinguishable.
  it("checks every handed-in WORKTREE row BEFORE the mount filter could hide it", () => {
    // A foreign row sitting on a mount the filter excludes must still be
    // refused: filtering first would let the mispaired query pass here and
    // leak on the next call, which omits the filter.
    const foreign = worktreeRow({ session_id: OTHER_SESSION_ID, repo_mount_id: MOUNT_B_ID });

    expect(() => project(rowSet([foreign]), MOUNT_A_ID)).toThrow(/owned by a different session/);
  });

  it("checks every handed-in CLONE row BEFORE the mount filter could hide it", () => {
    // Exact twin of the worktree case above, against the second loop. The
    // clone arm's `repo_mount_id` is join-supplied from the owning workspace,
    // so the filter reaches it too — and so must the guard, first.
    const foreign = cloneRow({ session_id: OTHER_SESSION_ID, repo_mount_id: MOUNT_B_ID });

    expect(() => project(rowSet([], [foreign]), MOUNT_A_ID)).toThrow(
      /owned by a different session/,
    );
  });

  it("keeps the other session's id OUT of the refusal message", () => {
    // The row id identifies the defect for whoever repairs the query; the
    // owning session id would be a disclosure to the session that asked.
    const foreign = cloneRow({ session_id: OTHER_SESSION_ID });

    const message = messageThrownBy(() => project(rowSet([], [foreign])));

    expect(message).not.toBe("");
    expect(message).toContain(foreign.id);
    expect(message).not.toContain(OTHER_SESSION_ID);
  });

  it("admits a row of this session on a DIFFERENT mount — scoping is not filtering", () => {
    const sibling = worktreeRow({ repo_mount_id: MOUNT_B_ID });

    expect(project(rowSet([sibling])).worktrees).toHaveLength(1);
  });
});

// ----------------------------------------------------------------------------
// The parse boundary (negative control for every clean-fixture test above)
// ----------------------------------------------------------------------------

describe("projectWorktreeStatusRead — the parse boundary", () => {
  it("refuses a worktree state outside the closed vocabulary", () => {
    // A raw database row can carry a string the compiler never saw — the row
    // type declares `state: string` precisely so this refusal happens at the
    // projection rather than at a cast in the caller.
    const corrupt = worktreeRow({ state: "hibernating" });

    expect(() => project(rowSet([corrupt]))).toThrow(/WorktreeStatusReadResponse shape\s+refuses/);
  });

  it("refuses a clone cleanup policy outside its vocabulary", () => {
    const corrupt = cloneRow({ cleanup_policy: "on_tuesday" });

    expect(() => project(rowSet([], [corrupt]))).toThrow(/refuses/);
  });

  it("refuses a non-ISO instant at the projection, not at the wire", () => {
    const corrupt = worktreeRow({ created_at: "4 August 2026, just after lunch" });

    expect(() => project(rowSet([corrupt]))).toThrow(/refuses/);
  });

  it("refuses an id that is not a UUID", () => {
    const corrupt = worktreeRow({ id: "worktree-7" });

    expect(() => project(rowSet([corrupt]))).toThrow(/refuses/);
  });

  it("carries the validation failure as `cause`, with the array and field named", () => {
    // The ZodError rides unmodified: its issue path IS the attribution, so
    // nothing here re-derives a row id from an array index.
    const corrupt = worktreeRow({ state: "hibernating" });
    let cause: unknown;

    try {
      project(rowSet([corrupt]));
    } catch (error) {
      cause = error instanceof Error ? error.cause : undefined;
    }

    expect(cause).toBeInstanceOf(Error);
    expect(String((cause as Error).message)).toMatch(/worktrees/);
  });
});

// ----------------------------------------------------------------------------
// Purity — the property every test above depends on
// ----------------------------------------------------------------------------

describe("worktree-projector — purity", () => {
  // Matches one whole static import statement per match — the named/default
  // `from` form, the type-only form, and the bare side-effect form
  // (`import "node:fs";`, no `from` at all) — including the multi-line block
  // shape. `[^;]*?` cannot run past the statement's own semicolon, so each
  // match is exactly one import. (The shipped `workspace-projector.test.ts`
  // extractor, reused verbatim for the sibling module.)
  const IMPORT_SPECIFIER_PATTERN = /^import\b[^;]*?"([^"]+)";$/gm;

  const projectorSource: string = readFileSync(
    new URL("../worktree-projector.ts", import.meta.url),
    "utf8",
  );

  function importedSpecifiersOf(source: string): string[] {
    return [...source.matchAll(IMPORT_SPECIFIER_PATTERN)].map((match) => match[1] ?? "");
  }

  it("detects every static import form when one is present (negative control)", () => {
    // Proves the extractor can FAIL. Without it, a broken pattern would report
    // a clean module by matching nothing at all — and the bare side-effect
    // form is the classic evasion a `from`-anchored pattern waves through.
    const fixture = [
      'import "node:fs";',
      'import { openSync } from "node:fs";',
      "",
      "import {",
      "  something,",
      '} from "@ai-sidekicks/contracts";',
      "",
    ].join("\n");

    expect(importedSpecifiersOf(fixture)).toEqual([
      "node:fs",
      "node:fs",
      "@ai-sidekicks/contracts",
    ]);
  });

  it("imports the contracts package and NOTHING else", () => {
    // The EXACT list, not a `node:`-prefix screen: the realistic purity break
    // is not a direct builtin import but a sibling import (a service module,
    // the database layer) that pulls I/O in transitively — which a prefix
    // filter waves through untouched. It is also what keeps the no-clock claim
    // structural: a module that cannot reach `Date` through an import cannot
    // derive expiry, whatever a later edit intends.
    expect(importedSpecifiersOf(projectorSource)).toEqual(["@ai-sidekicks/contracts"]);
  });

  it("contains no dynamic import() or require() escape hatch", () => {
    // The static census above cannot see a lazy `await import(...)` or a
    // CommonJS `require(...)`, either of which would reach I/O at call time
    // while the import list stays clean.
    expect(projectorSource).not.toMatch(/\bimport\s*\(/);
    expect(projectorSource).not.toMatch(/\brequire\s*\(/);
  });

  it("reads no clock — `Date` and `performance` appear nowhere in the source", () => {
    // I-010-20's daemon half in its structural form: expiry math is
    // unavailable to this module, not merely unwritten.
    expect(projectorSource).not.toMatch(/\bDate\b/);
    expect(projectorSource).not.toMatch(/\bperformance\b/);
  });
});
