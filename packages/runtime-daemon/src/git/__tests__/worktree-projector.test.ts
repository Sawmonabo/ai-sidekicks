// worktree-projector behavior.
//
// No database, no temp directory, no clock: the module under test performs no
// I/O, so every branch is driven by handing it rows directly. Both halves of
// that are enforced statically in eslint.config.mjs: a `no-restricted-imports`
// allow-list holding the module to `@ai-sidekicks/contracts` alone, so no
// sibling can pull I/O in behind it, and a `no-restricted-globals` ban on
// `Date` / `performance` making the clock math unavailable rather than merely
// unwritten.
//
// Coverage map (cites are the authoritative contract, not just the ACs):
//   * Never-hide: a fixture generated FROM the pinned state roster — one row
//     per member of the vocabulary — projects every row, `failed` and
//     `retired` included, in the order it was handed in. Roster-generated
//     rather than hand-listed, so a seventh worktree state added to contracts
//     fails the roster's compile-time completeness pin AND forces a fixture
//     row, instead of landing silently uncovered while every assertion below
//     still passes.
//   * The four axes of the status-read bullet: lifecycle state, branch,
//     cleanup bookkeeping (`cleanedAt`), and provenance (`createdBySessionId` /
//     `createdByRunId`) — including the two cleanup-bookkeeping shapes that
//     differ only by absence: a `retired` row before the sweep carries no
//     `cleanedAt`, and one after it does.
//   * Provenance survives: a worktree created by an EARLIER session still
//     reports its creator, unchanged — the read scopes on the reading
//     session, never on the creating one.
//   * Daemon-owned verdicts, tested against inputs that would tempt a
//     derivation: a non-normalized root passes through untouched, and
//     `dirty` / `merged` — the daemon's cleanliness verdicts —
//     are carried verbatim with no cleanliness field invented. The record key
//     census is what closes "no derived field": equality of values cannot
//     catch a field that was ADDED.
//   * Omitted-optional discipline by KEY census, not value equality: under
//     `exactOptionalPropertyTypes` plus `.strict()`, both an absent key and an
//     explicit `undefined` typecheck and parse, so only `Object.keys` catches
//     the second. Two INPUT shapes reach that census — a `null` column, and a
//     column the query never selected, which arrives `undefined` through the
//     unchecked row cast — and both must project as an absent key.
//   * The `repoMountId` filter narrows the array; omitted returns the whole
//     session; a mount holding nothing returns an empty array, as does an
//     empty read.
//   * Session binding: a row owned by another session is REFUSED before the
//     mount filter can hide the mispairing, and the other session's id stays
//     out of the message.
//   * The parse boundary can actually fail (negative control): a state outside
//     the closed vocabulary and a non-ISO instant each throw at the projection
//     with the `ZodError` as cause.
//

import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  WorktreeStatusReadRequestSchema,
  type WorktreeState,
  type WorktreeStatusReadRequest,
  type WorktreeStatusReadResponse,
} from "@ai-sidekicks/contracts";

import { projectWorktreeStatusRead } from "../worktree-projector.js";
import type { WorktreeStatusRow, WorktreeStatusRowSet } from "../worktree-projector.js";

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
const RUN_ID: string = randomUUID();

// RFC 3339 UTC with milliseconds — the form every daemon surface writes
// (`new Date().toISOString()`) and the form `z.iso.datetime({ offset: true })`
// accepts.
const CREATED_AT: string = "2026-08-04T12:00:00.000Z";
const UPDATED_AT: string = "2026-08-04T12:05:00.000Z";
const CLEANED_AT: string = "2026-08-04T12:30:00.000Z";

// Paths are never touched — nothing here opens a file — so they need not
// exist.
const WORKTREE_FS_ROOT: string = "/srv/sessions/execution-roots/worktrees/task-a";

// The full worktree vocabulary. The roster carries the SAME pair of checks the
// shipped `workspace-projector.test.ts` applies to its own: `satisfies` proves
// every element is a real member, and the `_AssertExtends` alias beneath proves
// every member is an element. With only the first, a state added to contracts
// would leave the never-hide fixture passing VACUOUSLY over a stale roster —
// precisely the drift the daemon half exists to catch.
const ALL_WORKTREE_STATES = [
  "creating",
  "ready",
  "dirty",
  "merged",
  "retired",
  "failed",
] as const satisfies readonly WorktreeState[];

// The `_` prefix is what the root eslint config's `varsIgnorePattern` exempts
// from `no-unused-vars`; the alias exists to be type-checked, not read.
type _AssertExtends<A extends B, B> = A;
type _AssertWorktreeStateRosterIsComplete = _AssertExtends<
  WorktreeState,
  (typeof ALL_WORKTREE_STATES)[number]
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

/** A `worktrees` row with a fresh id, overridden field by field. */
function worktreeRow(overrides: Partial<WorktreeStatusRow> = {}): WorktreeStatusRow {
  return { ...BASE_WORKTREE_ROW, id: randomUUID(), ...overrides };
}

function rowSet(worktrees: readonly WorktreeStatusRow[] = []): WorktreeStatusRowSet {
  return { worktrees };
}

/**
 * A row as a query that FORGOT a column hands it over: the key is absent, so
 * the field reads `undefined` rather than `null`. The row interfaces cannot
 * express that — hence the one row-shape cast in this file — but the rows
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
 * THROWS on an empty array rather than returning
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
// Never-hide — the daemon half
// ----------------------------------------------------------------------------

describe("projectWorktreeStatusRead — never-hide (daemon half)", () => {
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

  it("returns an empty array for a session holding no records", () => {
    // Required-but-empty is a lawful answer the ratified shape declares (the
    // array carries no `.min(1)`), which is what keeps the views from
    // distinguishing "no records" from "field omitted".
    expect(project(rowSet())).toEqual({ worktrees: [] });
  });
});

// ----------------------------------------------------------------------------
// Lifecycle, branch, cleanup bookkeeping, provenance
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

  it("omits `createdByRunId` for a pre-run prepare rather than sending it undefined", () => {
    const record = onlyWorktreeRecord(project(rowSet([worktreeRow({ created_by_run_id: null })])));

    // KEY census, not `toBeUndefined()`: an explicit `undefined` would pass a
    // value check and still ship a present key.
    expect(Object.keys(record)).not.toContain("createdByRunId");
    expect("createdByRunId" in record).toBe(false);
  });

  it("omits `cleanedAt` on a retired-but-unswept row — the observable half", () => {
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

  it("omits an optional field when the QUERY omitted the column, not just when it is null", () => {
    // The row interfaces declare these columns `string | null`, so this shape
    // is one the compiler says cannot happen — and will produce it anyway,
    // because driver rows reach the fold through an unchecked cast and a
    // `SELECT` that forgets a column yields `undefined`, not `null`. A
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

    const worktreeWithoutRun = onlyWorktreeRecord(project(rowSet([worktreeMissingRun])));
    const worktreeWithoutCleanup = onlyWorktreeRecord(project(rowSet([worktreeMissingCleanup])));

    expect("createdByRunId" in worktreeWithoutRun).toBe(false);
    expect("cleanedAt" in worktreeWithoutCleanup).toBe(false);
  });

  it("reports the CREATING session, not the reading one — provenance survives", () => {
    // A worktree an earlier session created, read by this session, still names
    // its creator.
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
// ----------------------------------------------------------------------------

describe("projectWorktreeStatusRead — daemon-owned verdicts (daemon half)", () => {
  it("carries the daemon's `dirty` and `merged` verdicts verbatim, inferring neither", () => {
    // Dirty and merged state belong to daemon-owned projections. They are
    // resolved onto the row by the transitioning service; this fold reports
    // them and reads no working tree — it could not, owning no I/O.
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

  it("passes a non-normalized root through untouched — no root computation", () => {
    const trailingSlashRoot = "/srv/sessions/execution-roots/worktrees/task-a/";
    const response = project(rowSet([worktreeRow({ fs_root: trailingSlashRoot })]));

    expect(onlyWorktreeRecord(response).fsRoot).toBe(trailingSlashRoot);
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
});

// ----------------------------------------------------------------------------
// The `repoMountId` filter
// ----------------------------------------------------------------------------

describe("projectWorktreeStatusRead — the repoMountId filter", () => {
  const mountAWorktree = worktreeRow({ repo_mount_id: MOUNT_A_ID });
  const mountBWorktree = worktreeRow({ repo_mount_id: MOUNT_B_ID });
  const everything = rowSet([mountAWorktree, mountBWorktree]);

  it("returns the whole session when the filter is omitted", () => {
    const response = project(everything);

    expect(response.worktrees.map((record) => record.worktreeId)).toEqual([
      mountAWorktree.id,
      mountBWorktree.id,
    ]);
  });

  it("narrows the array when the filter names a mount", () => {
    const response = project(everything, MOUNT_A_ID);

    expect(response.worktrees.map((record) => record.worktreeId)).toEqual([mountAWorktree.id]);
  });

  it("returns an empty array for a mount of this session that holds nothing", () => {
    const response = project(rowSet([mountAWorktree]), MOUNT_B_ID);

    expect(response).toEqual({ worktrees: [] });
  });

  it("never filters on state — the filter is a mount key, not a lifecycle judgment", () => {
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

  it("checks every handed-in WORKTREE row BEFORE the mount filter could hide it", () => {
    // Every other foreign-session fixture in this file projects with NO filter,
    // where the two orderings are indistinguishable. A foreign row sitting on a
    // mount the filter excludes must still be refused: filtering first would
    // let the mispaired query pass here and leak on the next call, which omits
    // the filter.
    const foreign = worktreeRow({ session_id: OTHER_SESSION_ID, repo_mount_id: MOUNT_B_ID });

    expect(() => project(rowSet([foreign]), MOUNT_A_ID)).toThrow(/owned by a different session/);
  });

  it("keeps the other session's id OUT of the refusal message", () => {
    // The row id identifies the defect for whoever repairs the query; the
    // owning session id would be a disclosure to the session that asked.
    const foreign = worktreeRow({ session_id: OTHER_SESSION_ID });

    const message = messageThrownBy(() => project(rowSet([foreign])));

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
