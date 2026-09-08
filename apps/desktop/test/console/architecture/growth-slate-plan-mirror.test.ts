// The growth slate has two homes, and this is the gate that makes them one ledger.
//
// `docs/plans/023-desktop-shell-and-renderer.md` §Console growth slate is the plan's
// table of every wire the console builds against the fixture and does not yet have, and
// `console/bridge/growth-port/growth-slate.ts` is that ledger as data. The invariant
// pairing them (I-023-13) says the two move together: "a row leaves the table when its
// amendment lands", and the fixture's live-status field "is checked against this table".
//
// Until this file there was no such test. The code-side halves exist — the manifest maps
// every slate row to a ledger entry and refuses an entry naming a row that is not on the
// slate — but every one of them reads the CODE table, so a row deleted from the plan the
// day its amendment lands was invisible: the console kept a row for a wire that had
// landed and nothing went red. That is the moment the invariant exists to catch.
//
// HOW THE TWO SIDES ARE PAIRED, AND WHY NOT BY TEXT. The plan table has no id column,
// and the two `wire` prose cells are deliberately not the same sentence: the plan
// writes wire method strings (`invites.list`) and the console module writes them out
// in words ("the invites list read"), because console source states no wire method it
// cannot call. Matching on that prose would be a similarity score dressed up as a
// gate. What both sides do state in one vocabulary is the governing document each
// row's wire belongs to, so that is the key — compared as a MULTISET over the whole
// table rather than row by row.
//
// A multiset and not a positional pairing, which was tried first and is wrong here:
// the ledger module says its insertion order is the table's, and measured against the
// plan on 2026-09-08 the two orders diverge from the twenty-fourth row onward. Order is
// legibility and membership is the claim; a positional gate would be paid for by
// reordering fifty-nine rows in a file several lanes are adding rows to, and would
// report an ordinary mid-table insertion as a fifty-row failure.
//
// THE KEY IS THE DOCUMENT NUMBER SET AND NOT THE FULL IDENTIFIER, for a measured
// reason: a spec and its paired plan are one governing document in two halves, and
// which half a cell cites is an editorial choice the two tables make differently —
// seven of the fifty-nine rows on 2026-09-08, one of them owned to `Spec-016` by the
// plan and to `Plan-016` by the mirror. Keying on the prefix would fail those seven
// forever while proving nothing about membership, so `016` is the key.
//
// WHAT A FAILURE MEANS: a count mismatch is a row added or deleted on one side only.
// A multiset difference names the governing-document key of every row one table
// carries and the other does not — a deleted plan row, a row added to the mirror
// alone, and a re-owned wire each look like that.
//
// THE LIVE-STATUS HALF RIDES THE SAME COMPARISON. Once the tables are shown to hold
// the same rows, "this row is still on the plan table" is true of every ledger row, so
// every growth entry serving one must still declare itself fixture-only. An entry
// marked live for a row the plan carries is the same drift from the other side.
//
// Every helper below is exercised on synthetic input at the bottom, including the
// planted deletion this file exists to catch.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { GROWTH_OPERATIONS } from "../../../src/renderer/src/console/bridge/growth-operations/index.js";
import {
  GROWTH_PREREQUISITES,
  GROWTH_SLATE_ROWS,
} from "../../../src/renderer/src/console/bridge/growth-port/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, "..", "..", "..");
const REPOSITORY_ROOT = resolve(PACKAGE_ROOT, "..", "..");
const PLAN_PATH = join(REPOSITORY_ROOT, "docs", "plans", "023-desktop-shell-and-renderer.md");

/** The plan heading whose first table is the slate. */
const SLATE_HEADING = "### Console growth slate";

/**
 * The table's own header cells. Asserted rather than assumed: the parser finds the
 * FIRST table under the heading, and a section that grew a second one above it would
 * otherwise be read silently as the slate.
 */
const SLATE_TABLE_HEADER: readonly string[] = [
  "Wire the console needs",
  "Owning document",
  "Console surface that consumes it",
];

/** One parsed plan-table row, cells in table order. */
interface PlanTableRow {
  readonly wire: string;
  readonly owningDocument: string;
  readonly consumingSurface: string;
}
/**
 * The lines of one `###`-level section, heading excluded. Stops at the next heading of
 * any level up to three, so a `####` subsection stays inside and a sibling `###` ends
 * it. Throws when the heading is absent, because a section that silently came back
 * empty would make every claim below vacuously true.
 */
export function readSectionLines(markdown: string, heading: string): readonly string[] {
  const lines = markdown.split("\n");
  const headingIndex = lines.findIndex((line) => line.trimEnd() === heading);
  if (headingIndex === -1) {
    throw new Error(`no \`${heading}\` heading`);
  }
  const sectionLines: string[] = [];
  for (const line of lines.slice(headingIndex + 1)) {
    if (/^#{1,3} /.test(line)) {
      break;
    }
    sectionLines.push(line);
  }
  return sectionLines;
}

/**
 * Split one markdown table row into its cells. Hand-scanned rather than split on `|`,
 * for the one case that matters here: a cell may carry an escaped pipe, and splitting
 * naively would cut a row in half and report a column-count failure that is really a
 * parser bug.
 */
export function splitTableRow(rowText: string): readonly string[] {
  const cells: string[] = [];
  let current = "";
  for (let index = 0; index < rowText.length; index += 1) {
    const character = rowText[index];
    if (character === "\\" && rowText[index + 1] === "|") {
      current += "|";
      index += 1;
      continue;
    }
    if (character === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }
  cells.push(current.trim());
  // A markdown row is fenced by leading and trailing pipes, which produce one empty
  // cell at each end. Dropping exactly those two keeps an interior empty cell.
  return cells.slice(1, -1);
}

/**
 * The rows of the first markdown table in `sectionLines`. Throws when the section holds
 * no table, when the header cells are not the ones this file was written against, or
 * when a row's column count disagrees with the header's — each of which would
 * otherwise degrade into a quietly wrong row set.
 */
export function parseSlateTable(
  sectionLines: readonly string[],
  expectedHeader: readonly string[],
): readonly PlanTableRow[] {
  const tableStart = sectionLines.findIndex((line) => line.trimStart().startsWith("|"));
  if (tableStart === -1) {
    throw new Error("the section holds no table");
  }
  const header = splitTableRow(sectionLines[tableStart] ?? "");
  if (header.join(" | ") !== expectedHeader.join(" | ")) {
    throw new Error(`unexpected table header: ${header.join(" | ")}`);
  }
  const rows: PlanTableRow[] = [];
  for (const line of sectionLines.slice(tableStart + 1)) {
    if (!line.trimStart().startsWith("|")) {
      break;
    }
    const cells = splitTableRow(line);
    if (cells.every((cell) => /^-{3,}$/.test(cell))) {
      continue; // the alignment row
    }
    if (cells.length !== expectedHeader.length) {
      throw new Error(`row with ${cells.length} cells: ${line.slice(0, 80)}`);
    }
    rows.push({
      wire: cells[0] ?? "",
      owningDocument: cells[1] ?? "",
      consumingSurface: cells[2] ?? "",
    });
  }
  if (rows.length === 0) {
    throw new Error("the table declares no rows");
  }
  return rows;
}

/**
 * The governing documents a cell names, as numbers, sorted and de-duplicated. A plan
 * cell may spell a document as a markdown link and the console module as bare text, and
 * both carry the same `Spec-NNN` / `Plan-NNN` / `ADR-NNN` token inside. Exactly three
 * digits, so "Plan-12" or a stray "Spec-0" contributes nothing. The kind prefix is
 * dropped for the reason the header states.
 */
export function documentNumbersIn(cell: string): readonly string[] {
  const numbers = [...cell.matchAll(/\b(?:Spec|Plan|ADR)-(\d{3})\b/g)].map(
    (match) => match[1] ?? "",
  );
  return [...new Set(numbers)].sort();
}

/** The rows one table holds and the other does not, keyed by governing documents. */
interface MembershipDifference {
  /** Keys the plan table carries more copies of than the mirror does, and the reverse. */
  readonly onlyInThePlanTable: readonly string[];
  readonly onlyInTheMirror: readonly string[];
}
/** One row's key: the governing documents its cell names, in one stable string. */
export function documentSetKey(cell: string): string {
  const numbers = documentNumbersIn(cell);
  // A row whose cell names a document that does not exist yet ("a new spec") keys on
  // that absence rather than on nothing, so two such rows are still two members.
  return numbers.length === 0 ? "(no governing document named)" : numbers.join(", ");
}

/**
 * The multiset difference between the two tables' rows, on the document key. Multiset
 * and not set: two rows may legitimately share an owner, and losing one of them must
 * still report.
 */
export function compareTableMembership(
  planRows: readonly PlanTableRow[],
  codeRows: readonly { readonly id: string; readonly owningDocument: string }[],
): MembershipDifference {
  const remainingCodeKeys = codeRows.map((row) => documentSetKey(row.owningDocument));
  const onlyInThePlanTable: string[] = [];
  for (const planRow of planRows) {
    const key = documentSetKey(planRow.owningDocument);
    const matchIndex = remainingCodeKeys.indexOf(key);
    if (matchIndex === -1) {
      onlyInThePlanTable.push(key);
      continue;
    }
    remainingCodeKeys.splice(matchIndex, 1);
  }
  return {
    onlyInThePlanTable: [...onlyInThePlanTable].sort(),
    onlyInTheMirror: [...remainingCodeKeys].sort(),
  };
}

const planSectionLines = readSectionLines(readFileSync(PLAN_PATH, "utf8"), SLATE_HEADING);
const planRows = parseSlateTable(planSectionLines, SLATE_TABLE_HEADER);

describe("the growth slate's plan table and its in-tree mirror are one ledger", () => {
  it("reads a table whose key discriminates", () => {
    // Every claim below is vacuous over no rows, and the membership check is only as
    // strong as the number of keys it can tell apart: a key collapsing the table into
    // a few buckets would pass a deletion whenever another row shared its owner.
    expect(planRows.length).toBeGreaterThan(1);
    expect(GROWTH_SLATE_ROWS.length).toBeGreaterThan(1);
    const planKeys = planRows.map((row) => documentSetKey(row.owningDocument));
    expect(new Set(planKeys).size, "distinct governing-document keys").toBeGreaterThan(20);
  });

  it("carries the same number of rows on both sides", () => {
    expect(
      planRows.length,
      "a row was added or deleted on one side only: the plan table and " +
        "`console/bridge/growth-port/growth-slate.ts` move together, in one PR",
    ).toBe(GROWTH_SLATE_ROWS.length);
  });

  it("holds the same rows on both sides, keyed by governing document", () => {
    expect(
      compareTableMembership(planRows, GROWTH_SLATE_ROWS),
      "a row is on one side only: `onlyInThePlanTable` is a wire the console mirror " +
        "never recorded, `onlyInTheMirror` is a row whose amendment landed and whose " +
        "plan row was deleted without its mirror",
    ).toStrictEqual({ onlyInThePlanTable: [], onlyInTheMirror: [] });
  });

  it("leaves every mirrored row unregistered", () => {
    // Being ON the slate is what `wireRegistered: false` means; the field exists so a
    // half-landed row is representable rather than implied.
    expect(GROWTH_SLATE_ROWS.filter((row) => row.wireRegistered !== false)).toStrictEqual([]);
  });

  it("marks no growth entry live while the plan still carries its row", () => {
    const rowsOnThePlanTable = new Set(GROWTH_SLATE_ROWS.map((row) => row.id));
    const liveEntries = [
      ...Object.values(GROWTH_OPERATIONS),
      ...Object.values(GROWTH_PREREQUISITES),
    ]
      .filter((entry) => entry.liveStatus === "live")
      .filter((entry) => rowsOnThePlanTable.has(entry.slateRow))
      .map((entry) => `${entry.id} (${entry.slateRow})`)
      .sort();
    expect(
      liveEntries,
      "an entry claims its wire is live while its row is still on the plan table: " +
        "the row leaves the table in the PR that wires it",
    ).toStrictEqual([]);
  });
});

// Negative controls. Each helper above is the reason a clean result means anything,
// so each is shown failing on an input built to defeat it — the deleted row first,
// because it is the failure this file was written for.
describe("the plan-table reader itself can fail", () => {
  const TABLE_FIXTURE = [
    "### Console growth slate",
    "",
    "Prose above the table.",
    "",
    "| Wire the console needs | Owning document | Console surface that consumes it |",
    "| --- | --- | --- |",
    "| `alpha.read` | [Spec-001](../specs/001-a.md) | alpha pane |",
    "| `beta.read` \\| the other one | Spec-002, [Plan-002](./002-b.md) | beta pane |",
    "| `gamma.read` | ADR-028 | gamma pane |",
    "",
    "## Invariants",
    "",
    "| ID | Invariant |",
    "| --- | --- |",
    "| I-1 | not the slate |",
  ].join("\n");

  const fixtureRows = parseSlateTable(readSectionLines(TABLE_FIXTURE, SLATE_HEADING), [
    ...SLATE_TABLE_HEADER,
  ]);

  const fixtureCodeRows = [
    { id: "alpha", owningDocument: "Spec-001" },
    { id: "beta", owningDocument: "Spec-002; Plan-002 (the client half)" },
    { id: "gamma", owningDocument: "the embedded ADR-028 posture" },
  ];
  it("stops the section at the next heading", () => {
    expect(fixtureRows).toHaveLength(3);
    expect(fixtureRows[2]?.consumingSurface).toBe("gamma pane");
  });

  it("keeps an escaped pipe inside its cell", () => {
    expect(fixtureRows[1]?.wire).toBe("`beta.read` | the other one");
  });

  it("refuses a missing heading, a section with no table, and a moved header", () => {
    expect(() => readSectionLines("# Something else\n", SLATE_HEADING)).toThrow(/heading/);
    expect(() => parseSlateTable(["prose only"], SLATE_TABLE_HEADER)).toThrow(/no table/);
    const movedHeader = ["| Wire | Owner |", "| --- | --- |", "| a | b |"];
    expect(() => parseSlateTable(movedHeader, SLATE_TABLE_HEADER)).toThrow(/unexpected table/);
  });

  it("reads a document number through a link and refuses a near miss", () => {
    expect(documentNumbersIn("[Spec-001](../specs/001-a.md)")).toStrictEqual(["001"]);
    expect(documentNumbersIn("Spec-002, [Plan-002](./002-b.md)")).toStrictEqual(["002"]);
    expect(documentNumbersIn("Plan-12 and Spec-0 and Spec-1234 and Note-003")).toStrictEqual([]);
  });

  it("reports membership as clean when the two tables agree, in any order", () => {
    expect(compareTableMembership(fixtureRows, fixtureCodeRows)).toStrictEqual({
      onlyInThePlanTable: [],
      onlyInTheMirror: [],
    });
    const shuffled = [fixtureCodeRows[2], fixtureCodeRows[0], fixtureCodeRows[1]].filter(
      (row): row is (typeof fixtureCodeRows)[number] => row !== undefined,
    );
    expect(compareTableMembership(fixtureRows, shuffled)).toStrictEqual({
      onlyInThePlanTable: [],
      onlyInTheMirror: [],
    });
  });

  it("reports a plan row deleted while its mirror row survives", () => {
    // The planted failure this file was written for: the middle row's amendment
    // landed, the plan row was deleted, and the console module still carries it.
    const planWithBetaDeleted = [fixtureRows[0], fixtureRows[2]].filter(
      (row): row is PlanTableRow => row !== undefined,
    );
    expect(compareTableMembership(planWithBetaDeleted, fixtureCodeRows)).toStrictEqual({
      onlyInThePlanTable: [],
      onlyInTheMirror: ["002"],
    });
  });

  it("reports a row added to the plan table alone", () => {
    expect(compareTableMembership(fixtureRows, fixtureCodeRows.slice(0, 2))).toStrictEqual({
      onlyInThePlanTable: ["028"],
      onlyInTheMirror: [],
    });
  });
  it("reports a row whose owning document changed on one side", () => {
    const rowsWithAlphaReowned = [
      { id: "alpha", owningDocument: "Spec-030" },
      ...fixtureCodeRows.slice(1),
    ];
    expect(compareTableMembership(fixtureRows, rowsWithAlphaReowned)).toStrictEqual({
      onlyInThePlanTable: ["001"],
      onlyInTheMirror: ["030"],
    });
  });

  it("counts two rows that share an owner as two members", () => {
    const twoAlphas = [...fixtureCodeRows, { id: "alpha-two", owningDocument: "Spec-001" }];
    expect(compareTableMembership(fixtureRows, twoAlphas)).toStrictEqual({
      onlyInThePlanTable: [],
      onlyInTheMirror: ["001"],
    });
  });

  it("keys a row naming no document on that absence, not on nothing", () => {
    expect(documentSetKey("a new spec")).toBe("(no governing document named)");
    expect(documentSetKey("[Spec-001](../specs/001-a.md)")).toBe("001");
    expect(documentSetKey("Plan-016"), "the two halves key alike").toBe(
      documentSetKey("[Spec-016](../specs/016-m.md)"),
    );
  });
});
