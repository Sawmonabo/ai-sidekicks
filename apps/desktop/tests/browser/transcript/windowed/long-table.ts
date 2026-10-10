// A long markdown table to draw as the bench draws it, and the checks that the table drawn as a
// window over its rows lays out as the same table drawn whole.

import { expect } from "vitest";

import { WHOLE_TABLE_MAX_BODY_ROWS } from "#renderer/features/transcript/rows/markdown/table-window/long-tables.js";
import { MARKDOWN_TABLE_ROW_INDEX_ATTRIBUTE } from "#renderer/features/transcript/rows/markdown/block-window/markers.js";
import { mountBodies, scrollTo, settleFrames, type MountedBodies } from "./reply.js";

/** How far apart two layouts of one length may be and still be the same. */
export const SAME_LENGTH_TOLERANCE_PX = 1;

/** The head and delimiter lines of the bench's long table. */
export const TABLE_HEAD: readonly string[] = [
  "| Lane | State | Rows | p95 (ms) | Note |",
  "| :-- | --- | ---: | ---: | --- |",
];

/** One body row as the bench's long table draws it. */
export function benchRow(index: number): string {
  return (
    `| lane-${String(index)} | running | ${String(index * 7)} | ${(index * 0.13).toFixed(2)} | ` +
    `keeps **the reader** in place with \`code\` ${String(index)} |`
  );
}

/**
 * Cells set wider than every bench cell of their column while holding fewer characters, or wrapping
 * over several lines, each in a row near the table's end that a first screen never draws.
 */
export const PLANTED_ROWS: readonly { readonly fromEnd: number; readonly row: string }[] = [
  // Ideographs, each about twice a Latin letter's advance.
  { fromEnd: 1, row: "| 読者位置表 | running | 1 | 0.01 | short |" },
  // Bold capitals.
  { fromEnd: 2, row: "| lane-x | **WMWMWM** | 2 | 0.02 | short |" },
  // A code span, in the code font with its padding.
  { fromEnd: 3, row: "| lane-y | running | `MWMW` | 0.03 | short |" },
  // A long unbroken address, which wraps anywhere.
  {
    fromEnd: 5,
    row: "| lane-z | running | 4 | 0.04 | https://example.com/WWWWMMMM/wwwwmmmm/WWWWMMMM/wwwwmmmm/WWWWMMMM/wwwwmmmm |",
  },
  // A long cell of prose, wrapping over several lines.
  {
    fromEnd: 8,
    row:
      "| lane-w | running | 5 | 0.05 | " +
      "keeps the reader in place while the rows above it measure, ".repeat(6) +
      "|",
  },
];

/** A bench table of `rowCount` body rows, the planted rows among its last. */
export function benchTable(rowCount: number): string {
  const rows = Array.from({ length: rowCount }, (_, index) => benchRow(index));
  for (const planted of PLANTED_ROWS) {
    rows[rowCount - planted.fromEnd] = planted.row;
  }
  return [...TABLE_HEAD, ...rows].join("\n");
}

/** A reply holding `table` between two paragraphs. */
export function replyWith(table: string): string {
  return [
    "The lanes as they stood when the run ended, one row each.",
    table,
    "Every lane above finished in place.",
  ].join("\n\n");
}

/**
 * The table drawn in the scroller and the one drawn whole beside it, past any hidden frame a
 * measurement draws.
 */
export function tablesOf(bodies: MountedBodies): {
  readonly windowed: HTMLTableElement;
  readonly whole: HTMLTableElement;
} {
  const windowed = [...bodies.windowedBody.querySelectorAll("table")].find(
    (table) => table.closest(MEASURING_FRAME_SELECTOR) === null,
  );
  const whole = bodies.flowBody?.querySelector("table");
  if (windowed === undefined || whole === null || whole === undefined) {
    throw new Error("both tables did not mount");
  }
  return { windowed, whole };
}

/** The windowed table's drawn body rows, by index. */
export function drawnRows(table: HTMLTableElement): Map<number, HTMLTableRowElement> {
  const rows = new Map<number, HTMLTableRowElement>();
  for (const row of table.querySelectorAll<HTMLTableRowElement>(
    `tr[${MARKDOWN_TABLE_ROW_INDEX_ATTRIBUTE}]`,
  )) {
    rows.set(Number(row.getAttribute(MARKDOWN_TABLE_ROW_INDEX_ATTRIBUTE)), row);
  }
  return rows;
}

export function headWidthsOf(table: HTMLTableElement): number[] {
  return [...(table.tHead?.rows[0]?.cells ?? [])].map((cell) => cell.getBoundingClientRect().width);
}

/** Scrolls the scroller so that body row `index` of the whole table's layout sits at its top. */
export async function scrollToRow(bodies: MountedBodies, index: number): Promise<void> {
  const { whole } = tablesOf(bodies);
  const wholeRow = whole.tBodies[0]?.rows[index];
  if (wholeRow === undefined) {
    throw new Error(`the whole table has no body row ${String(index)}`);
  }
  // Both bodies start at the top of their columns, so a row's offset in one is its offset in both.
  const offsetPx =
    wholeRow.getBoundingClientRect().top - (bodies.flowBody?.getBoundingClientRect().top ?? 0);
  await scrollTo(bodies.scroller, offsetPx);
}

/**
 * Checks that the windowed table lays its columns out at the whole table's widths and each drawn
 * row at the whole table's height and place. Returns how many rows it compared.
 */
export function expectSameLayout(bodies: MountedBodies, where: string): number {
  const { windowed, whole } = tablesOf(bodies);
  const wholeWidths = headWidthsOf(whole);
  const widths = headWidthsOf(windowed);
  expect(widths, where).toHaveLength(wholeWidths.length);
  for (const [column, widthPx] of widths.entries()) {
    expect(
      Math.abs(widthPx - (wholeWidths[column] ?? 0)),
      `${where}, column ${String(column)}: windowed ${String(widthPx)}, whole ${String(wholeWidths[column])}`,
    ).toBeLessThanOrEqual(SAME_LENGTH_TOLERANCE_PX);
  }
  // The rows not drawn hold the room the whole table's rows take, so the reply is as tall.
  const windowedBox = windowed.getBoundingClientRect();
  const wholeBox = whole.getBoundingClientRect();
  expect(
    Math.abs(windowedBox.height - wholeBox.height),
    `${where}, table height: windowed ${String(windowedBox.height)}, whole ${String(wholeBox.height)}`,
  ).toBeLessThanOrEqual(SAME_LENGTH_TOLERANCE_PX);
  const windowedTopPx = windowedBox.top;
  const wholeTopPx = wholeBox.top;
  const drawn = drawnRows(windowed);
  for (const [index, row] of drawn) {
    const wholeRow = whole.tBodies[0]?.rows[index] ?? expect.fail(`whole row ${String(index)}`);
    const rowBox = row.getBoundingClientRect();
    const wholeRowBox = wholeRow.getBoundingClientRect();
    expect(
      Math.abs(rowBox.height - wholeRowBox.height),
      `${where}, row ${String(index)} height: windowed ${String(rowBox.height)}, whole ${String(wholeRowBox.height)}`,
    ).toBeLessThanOrEqual(SAME_LENGTH_TOLERANCE_PX);
    expect(
      Math.abs(rowBox.top - windowedTopPx - (wholeRowBox.top - wholeTopPx)),
      `${where}, row ${String(index)} place`,
    ).toBeLessThanOrEqual(SAME_LENGTH_TOLERANCE_PX);
  }
  return drawn.size;
}

/** Mounts `reply` windowed and whole, once the web fonts the cells draw in are loaded. */
export async function mountWithWhole(
  reply: string,
  options: { readonly isComplete: boolean; readonly drawsInFrame?: boolean },
): Promise<MountedBodies> {
  const bodies = await mountBodies(reply, { ...options, drawsFlowBody: true });
  await bodies.windowedBody.ownerDocument.fonts.ready;
  await settleTableWindow(bodies);
  return bodies;
}

/**
 * Waits until the scroller's long tables draw as windows with no measurement left running: no
 * hidden frame drawn for `QUIET_ROUNDS` rounds of frames in a row, the slices between the
 * frames a measurement draws having run. Throws past `TABLE_WINDOW_SETTLE_ROUNDS` rounds.
 */
export async function settleTableWindow(bodies: MountedBodies): Promise<void> {
  let quietRounds = 0;
  for (let round = 0; round < TABLE_WINDOW_SETTLE_ROUNDS; round += 1) {
    await settleFrames();
    const isMeasuring =
      bodies.windowedBody.querySelector(MEASURING_FRAME_SELECTOR) !== null ||
      ![...bodies.windowedBody.querySelectorAll("table")].every((table) => isWindowed(table));
    quietRounds = isMeasuring ? 0 : quietRounds + 1;
    if (quietRounds === QUIET_ROUNDS) {
      return;
    }
  }
  throw new Error("the long table never settled as a window");
}

/** The hidden frame a long table's measurement draws its sample rows in. */
const MEASURING_FRAME_SELECTOR = ".meridian-table-sample-frame";

/** How many rounds of frames a long table's measuring may take before a case gives up. */
const TABLE_WINDOW_SETTLE_ROUNDS = 100;

/** How many rounds in a row with no hidden frame drawn count as no measurement running. */
const QUIET_ROUNDS = 3;

/**
 * Whether `table` draws as it settles: as a window over its rows, or whole for a table short
 * enough to draw whole, rather than whole while its columns are measured.
 */
function isWindowed(table: HTMLTableElement): boolean {
  return (
    table.hasAttribute("aria-rowcount") ||
    (table.tBodies[0]?.rows.length ?? 0) <= WHOLE_TABLE_MAX_BODY_ROWS
  );
}
