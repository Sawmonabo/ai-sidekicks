// What a held row's long tables wait on: a table prepared before the rows' width is known waits
// for it, undrawn, rather than letting its row in, whatever ends its lines; and all of it is let go
// with the row, leaving no
// table waiting to be drawn and measured off the list.

import { describe, expect, it, vi } from "vitest";

import { parseTree } from "#renderer/components/Markdown/parse/trees.test-support.js";
import { OffListTables } from "./off-list.js";
import { prepareTableWindows } from "./preparation.js";

/** A block holding one table longer than any drawn whole, its lines ended by `lineEnding`. */
function longTableBlock(lineEnding: string): string {
  return [
    "| Lane | State |",
    "| --- | --- |",
    ...Array.from({ length: 80 }, (_, index) => `| lane-${String(index)} | running |`),
  ].join(lineEnding);
}

const LONG_TABLE_BLOCK = longTableBlock("\n");

describe("a block's long tables, measured off the list", () => {
  it.each([
    { lineEnding: "\n", name: "a line feed" },
    { lineEnding: "\r", name: "a carriage return" },
  ])(
    "hold their row while the rows' width is unknown, its lines ending in $name, and are drawn at it once it is read",
    async ({ lineEnding }) => {
      const block = longTableBlock(lineEnding);
      const rows: { widthPx: number | undefined } = { widthPx: undefined };
      const offList = new OffListTables(document, () => rows.widthPx);
      const preparation =
        prepareTableWindows(
          {
            source: block,
            fingerprint: "block",
            definitionPreamble: "",
            root: await parseTree(block),
            definedFootnoteIdentifiers: new Set(),
          },
          offList,
          () => undefined,
        ) ?? expect.fail("a long table waits to be measured");
      expect(preparation.isReady).toBe(false);
      expect(offList.read().map((entry) => entry.rowWidthPx)).toEqual([undefined]);

      rows.widthPx = 680;
      offList.readRowWidth();
      expect(offList.read().map((entry) => entry.rowWidthPx)).toEqual([680]);
      expect(preparation.isReady).toBe(false);
      preparation.release();
    },
  );

  it("are withdrawn from the frames when the row's preparation is released", async () => {
    const offList = new OffListTables(document, () => 680);
    const onReady = vi.fn();
    const preparation =
      prepareTableWindows(
        {
          source: LONG_TABLE_BLOCK,
          fingerprint: "block",
          definitionPreamble: "",
          root: await parseTree(LONG_TABLE_BLOCK),
          definedFootnoteIdentifiers: new Set(),
        },
        offList,
        onReady,
      ) ?? expect.fail("a long table waits to be measured");
    expect(offList.read()).toHaveLength(1);
    expect(preparation.isReady).toBe(false);

    preparation.release();
    expect(offList.read()).toEqual([]);
    expect(onReady).not.toHaveBeenCalled();
  });
});
