// Every growth-slate row names a consuming surface. This is the gate that makes that
// name resolve to a module.
//
// A slate row is a promise: the console needs a wire, this document owes it, and THIS
// surface is what will render it. The first two halves are checkable by reading the
// row — the wire string and the owning document are right there. The third was not
// checkable at all: `consumingSurface` is English prose, and a row whose surface was
// deleted, renamed, or never built kept its sentence and nobody found out. The slate
// is the console's own record of what it is waiting for, and a record that can go
// quietly wrong is worse than none.
//
// WHAT IS CHECKED IS THE OPERATION, NOT THE PROSE. The row's sentence stays prose,
// because it is written for a person reading the plan's table. What resolves is the
// operation: every slate row is named by at least one entry in the growth-operation
// ledger, each entry has an id, and a consumed operation is one some console module
// outside `bridge/` calls by that id. So the claim this gate makes is exact — "a
// surface reaches for this row's wire" — and it is derived from the ledger rather than
// from a second table anyone has to keep in step.
//
// THE BRIDGE FAMILY IS SUBTRACTED FROM THE SEARCH, and that subtraction is the whole
// difficulty. Every operation id appears in `bridge/` by construction — in the id
// union, the ledger, the refusing port, and the fixture's served set — so a scan that
// counted those would report every row as consumed and prove nothing. What counts is a
// reference from a module that is not part of the seam.
//
// A ROW WHOSE CONSUMER IS ANOTHER LANE'S IS NAMED, NEVER SKIPPED. The allow-list below
// carries one entry per such row with the lane that owes it. An entry is a debt with a
// name on it; a silent skip is a debt nobody holds.

import { beforeAll, describe, expect, it } from "vitest";

import { GROWTH_OPERATIONS } from "../../../src/renderer/src/console/bridge/growth-operations/index.js";
import {
  GROWTH_SLATE_ROWS,
  type GrowthSlateRowId,
} from "../../../src/renderer/src/console/bridge/growth-port/growth-slate.js";
import { ConsoleSourceTree, type ConsoleModuleText } from "../console-source-modules.js";

/**
 * The families that are the SEAM rather than a consumer.
 *
 * `bridge/` declares every operation id four times over and the fixture serves them;
 * counting either as a consumer would make this gate pass on an empty console.
 */
const SEAM_PATH_FRAGMENTS: readonly string[] = ["console/bridge/"];

/**
 * Rows whose consuming surface is owned by a lane other than the one that authored
 * this gate, with the lane that owes it.
 *
 * EVERY ENTRY IS A DEBT WITH A NAME. A row here is one the console has promised a
 * surface for and has not built yet; when its lane lands, its entry comes off and the
 * derived check starts covering it. Deleting an entry to make the gate pass is the one
 * move this table exists to make visible.
 */
const CONSUMER_OWED_BY_ANOTHER_LANE: Readonly<Record<string, string>> = {
  // browser lane — the browser pane and its dev-server chip.
  "browser-tool-relay": "browser lane — the browser pane",
  "dev-server-probe": "browser lane — the browser pane's dev-server chip",
  // sessions lane — the all-sessions list and the workspace header. The import flow
  // came off this list when that lane landed it: `provider-session-import` is reached
  // by `sessions/acts/provider-import.ts` now, so the derived check covers it.
  "session-lifecycle-verbs": "sessions lane — the all-sessions list and workspace header",
  "session-search": "sessions lane — the all-sessions list's search, and the palette row it feeds",
  // ledger lane — the timeline's own reads. The first-run frame came off this list
  // when the onboarding lane landed it: `onboarding-methods` is reached by
  // `console/onboarding/`, so the derived check covers it.
  "timeline-epoch-attestation": "ledger lane — the timeline pane",
  "timeline-path-reference": "ledger lane — the timeline pane",
  "hydrated-event-read": "ledger lane — the timeline pane and the ledger rows",
  // collaboration lanes — the health strip, the park banner, and the composer's chip.
  "health-subscribe": "collaboration lane — the health strip and park banner",
  "agent-provider-switch-failure": "composer lane — the target chip",
  // repos lane — the worktree recipe the repos surface renders.
  "worktree-setup-recipe": "repos lane — the repos surface",
  // workflows lanes — the run pane and the builder.
  "workflow-event-registration": "workflows lane — the workflow-run pane",
  "workflow-definition-scope": "workflows lane — the workflow-builder pane",
  // approvals lane — the remembered-rule arm, the amendment arm, and the callback
  // registry the approvals pane reads a tool's identity from.
  "approval-remembered-rule": "approvals lane — the approvals pane",
  "approval-amendment-arm": "approvals lane — the approvals pane",
  "callback-tool-registry-read": "approvals lane — the approvals pane",
  // shell lane — the window controls the workspace deck and auxiliary windows take.
  "window-control-namespace": "shell lane — the workspace deck and auxiliary windows",
};

describe("growth slate — every row's consuming surface resolves to a module", () => {
  const tree = new ConsoleSourceTree({});
  beforeAll(() => {
    tree.read();
  });
  const slateRowIds: readonly GrowthSlateRowId[] = GROWTH_SLATE_ROWS.map((row) => row.id);
  const consumers = (): readonly ConsoleModuleText[] =>
    tree.reading.texts.filter(
      (text) => !SEAM_PATH_FRAGMENTS.some((fragment) => text.displayPath.includes(fragment)),
    );

  it("walks a console large enough for the search to mean anything", () => {
    // The vacuity floor every gate in this tier asserts: a walk that found nothing
    // would report every row as consumed and every allow-list entry as needed.
    expect(consumers().length).toBeGreaterThan(200);
  });

  it("carries exactly the recorded set of rows that name no ledger operation", () => {
    const rowsNamedByAnOperation = new Set<GrowthSlateRowId>(
      Object.values(GROWTH_OPERATIONS).map((operation) => operation.slateRow),
    );
    const withoutOperation = slateRowIds.filter((rowId) => !rowsNamedByAnOperation.has(rowId));
    // PINNED RATHER THAN FORBIDDEN, because these rows are legitimate: what each owes
    // is an event kind, a payload member, or a registration, and none of those is a
    // callable operation the ledger could carry. The pin is what makes the class a
    // tripwire anyway — a new row that names no operation lands here and has to be
    // classified deliberately, rather than falling silently outside the check below.
    expect([...withoutOperation].sort()).toEqual([...ROWS_WITH_NO_LEDGER_OPERATION].sort());
  });

  it("finds a console module outside the bridge for every row's operations", () => {
    const texts = consumers();
    const unconsumed = slateRowIds
      .filter((rowId) => CONSUMER_OWED_BY_ANOTHER_LANE[rowId] === undefined)
      .filter((rowId) => !isRowConsumed(rowId, texts));
    expect(
      unconsumed,
      "each of these slate rows names a consuming surface that no module reaches for — " +
        "build the surface, or name the lane that owes it in CONSUMER_OWED_BY_ANOTHER_LANE",
    ).toEqual([]);
  });

  it("reports a row whose consumer does not exist — the planted control", () => {
    // The negative control this gate is only trustworthy with. `Object.keys` above
    // walks the real slate, so the control is a row id the ledger names and no
    // surface calls: `PLANTED_UNCONSUMED_OPERATION_ID` is spelled in a way no module
    // contains, which is exactly the shape of a row whose surface was deleted.
    expect(isRowConsumed(PLANTED_ROW_ID, consumers())).toBe(false);
  });

  it("reports a row whose consumer DOES exist — the positive control", () => {
    // The other half: without it, a search that matched nothing at all would pass the
    // negative control and report every real row as unconsumed for the wrong reason.
    const consumedRow = Object.values(GROWTH_OPERATIONS).find(
      (operation) => operation.id === "sessionRead",
    );
    expect(consumedRow).toBeDefined();
    expect(isRowConsumed(consumedRow?.slateRow ?? PLANTED_ROW_ID, consumers())).toBe(true);
  });

  it("holds no allow-list entry for a row the slate no longer carries", () => {
    const stale = Object.keys(CONSUMER_OWED_BY_ANOTHER_LANE).filter(
      (rowId) => !slateRowIds.includes(rowId as GrowthSlateRowId),
    );
    expect(stale, "an allow-list entry for a row that is gone is a debt nobody owes").toEqual([]);
  });

  it("holds no allow-list entry for a row that IS consumed", () => {
    const texts = consumers();
    const nowConsumed = Object.keys(CONSUMER_OWED_BY_ANOTHER_LANE).filter((rowId) =>
      isRowConsumed(rowId as GrowthSlateRowId, texts),
    );
    expect(
      nowConsumed,
      "these rows have their surface now — take them off CONSUMER_OWED_BY_ANOTHER_LANE",
    ).toEqual([]);
  });
});

/**
 * The rows whose wire is not a callable operation.
 *
 * An event kind the console has to be told about, a payload member on a reply it
 * already receives, or a registration performed elsewhere: each is a real thing the
 * console is waiting for and none of them is something a surface CALLS, so the
 * operation-id search below cannot reach them. They are recorded here so the class is
 * counted rather than assumed, and they are on the lane table above for the same
 * reason every unreachable row is: a debt with a name on it.
 */
const ROWS_WITH_NO_LEDGER_OPERATION: readonly GrowthSlateRowId[] = [
  "agent-provider-switch-failure",
  "worktree-setup-recipe",
  "workflow-event-registration",
  "workflow-definition-scope",
  "timeline-epoch-attestation",
  "timeline-path-reference",
  "approval-remembered-rule",
  "approval-amendment-arm",
] as GrowthSlateRowId[];

/** A row id no ledger operation and no module can match. The negative control's. */
const PLANTED_ROW_ID = "planted-row-with-no-consumer" as GrowthSlateRowId;

/**
 * Whether any module outside the seam calls one of a row's operations by id.
 *
 * Matched as a WHOLE WORD, so `daemonStop` does not answer for `daemonStopped` and an
 * id that is a prefix of another cannot borrow its consumer.
 */
function isRowConsumed(rowId: GrowthSlateRowId, texts: readonly ConsoleModuleText[]): boolean {
  const operationIds = Object.values(GROWTH_OPERATIONS)
    .filter((operation) => operation.slateRow === rowId)
    .map((operation) => operation.id);
  return operationIds.some((operationId) => {
    const pattern = new RegExp(`\\b${operationId}\\b`, "u");
    return texts.some((text) => pattern.test(text.source));
  });
}
