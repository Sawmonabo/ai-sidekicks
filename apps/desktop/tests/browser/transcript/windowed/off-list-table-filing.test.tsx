// A long table's geometry kept for its next mount without reading its rows. Measured off the list,
// a settled block's table is filed by its block's fingerprint, the definitions it is parsed after
// and its place in the block, so the same block parsed anew is filed at once and its listed mount
// draws its window from its first frame; it lands in a task of its own. A streaming table's window
// hands its geometry to its row's next mount starting at the same place in the body's text: the
// table remounted as a block ahead of it settles, its row listed again, or its own block settled.
// Measured in the engine that lays the hidden frames out, as they are read only after a layout.

import { waitFor } from "@testing-library/react";
import type { Table } from "mdast";
import { afterEach, describe, expect, it, vi } from "vitest";

import { liveBridgeWrapper } from "../../../helpers/app/frame-fixtures.js";
import { renderSettled } from "../../../helpers/app/harness.js";

import { installMeridianTokens } from "#renderer/app/token-installation.js";
import { parseMarkdown } from "#renderer/components/Markdown/parse.js";
import { OffListTableFrames } from "#renderer/features/transcript/rows/bodies/OffListTableFrames.js";
import { suiteWindowViewport } from "#renderer/features/transcript/rows/bodies/WindowedMarkdown.test-support.js";
import { type TableBodyPlacement } from "#renderer/features/transcript/rows/markdown/table-window/context.js";
import {
  recallTableGeometry,
  settledTableKeyOf,
  type TableGeometry,
} from "#renderer/features/transcript/rows/markdown/table-window/geometry-memory.js";
import { TableWindowLayout } from "#renderer/features/transcript/rows/markdown/table-window/layout.js";
import { longTablesOf } from "#renderer/features/transcript/rows/markdown/table-window/long-tables.js";
import { OffListTables } from "#renderer/features/transcript/rows/markdown/table-window/off-list.js";
import { ManualClock } from "#renderer/lib/clock.js";
import { ScrollController } from "#renderer/lib/scroll/chokepoint.js";

/** How long a table's hidden frames take to be laid out, read and filed, with room to spare. */
const LAND_TIMEOUT_MS = 10_000;

/** A selection that never starts. */
const NO_SELECTION = { subscribe: () => () => undefined, read: () => undefined };

/** The definitions a block of a body with one footnote is parsed after. */
const FOOTNOTE_PREAMBLE = "[^note]: x\n\n";

/** A block holding one table longer than any drawn whole, its lanes named by `name`. */
function longTableBlockOf(name: string): string {
  return [
    "| Lane | State |",
    "| --- | --- |",
    ...Array.from({ length: 80 }, (_, index) => `| ${name}-${String(index)} | running |`),
  ].join("\n");
}

/** `block` parsed, as its body parses it each time it is drawn: a new table every time. */
function longTableOf(block: string): Table {
  return longTablesOf(parseMarkdown(block))[0] ?? expect.fail("a long table");
}

/** The row the bodies here are drawn in. */
const ROW_KEY = "row";

/**
 * A markdown body of row `rowKey` that has mounted no element, its blocks starting where
 * `blockSourceStart` says: a block is settled while `blockFingerprint` answers one for it, and
 * streaming before.
 */
function bodyPlacementOf(
  blockFingerprint: (index: number) => string | undefined,
  blockSourceStart: (index: number) => number = () => 0,
  rowKey = ROW_KEY,
): TableBodyPlacement {
  return {
    bodyType: undefined,
    ownerDocument: undefined,
    definitionPreamble: "",
    rowKey,
    blockSourceStart,
    blockFingerprint,
    blockParseSource: () => () => expect.fail("no table here is copied"),
    anchorOf: () => null,
    anchorTopPx: () => undefined,
    subscribeToPlacement: () => () => undefined,
  };
}

/** A listed table in block `blockIndex` of `placement`, laid out at `offList`'s listed type. */
function listedTableOf(
  table: Table,
  placement: TableBodyPlacement,
  offList: OffListTables,
  blockIndex = 0,
): TableWindowLayout {
  const viewport = suiteWindowViewport(
    new ScrollController({ clock: new ManualClock() }),
    NO_SELECTION,
  );
  return new TableWindowLayout(
    { viewport, placement },
    table,
    blockIndex,
    () => undefined,
    offList,
  );
}

/** Mounts the hidden frames of `offList`'s tables. */
async function drawFrames(offList: OffListTables): Promise<void> {
  installMeridianTokens(document);
  const Wrapper = liveBridgeWrapper();
  await renderSettled(
    <Wrapper>
      <OffListTableFrames offList={offList} />
    </Wrapper>,
  );
}

/** Measures the table of `block`, fingerprinted `blockFingerprint`, off the list until it lands. */
async function landTable(
  offList: OffListTables,
  block: string,
  blockFingerprint: string,
): Promise<TableGeometry> {
  const table = longTableOf(block);
  const tableKey = settledTableKeyOf(blockFingerprint, "", table);
  const landed = vi.fn();
  offList.measure(table, tableKey, new Set(), landed);
  await waitFor(() => expect(landed).toHaveBeenCalledOnce(), { timeout: LAND_TIMEOUT_MS });
  const bodyType = offList.listedBodyType() ?? expect.fail("a listed body type");
  return recallTableGeometry({ tableKey, bodyType }) ?? expect.fail("the geometry filed");
}

/**
 * Tells each posted task apart: answers the number of the one running, `undefined` outside any.
 */
function followPostedTasks(): () => number | undefined {
  let runningTask: number | undefined;
  let postedCount = 0;
  const postTask = window.scheduler.postTask.bind(window.scheduler);
  vi.spyOn(window.scheduler, "postTask").mockImplementation((callback, options) => {
    postedCount += 1;
    const task = postedCount;
    return postTask(() => {
      runningTask = task;
      try {
        return callback();
      } finally {
        runningTask = undefined;
      }
    }, options);
  });
  return () => runningTask;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a long table's geometry, kept for its next mount", () => {
  it("lands off the list in a task of its own", async () => {
    const offList = new OffListTables(document, () => 680);
    await drawFrames(offList);
    const runningTask = followPostedTasks();
    const table = longTableOf(longTableBlockOf("own-task"));
    let landedIn: number | undefined;
    const landed = vi.fn(() => {
      landedIn = runningTask();
    });
    offList.measure(table, settledTableKeyOf("own-task", "", table), new Set(), landed);
    await waitFor(() => expect(landed).toHaveBeenCalledOnce(), { timeout: LAND_TIMEOUT_MS });
    expect(landedIn, "the posted task the table lands in").not.toBe(undefined);
  });

  it("files a settled block's table so the block parsed anew is filed and drawn from it at once", async () => {
    const offList = new OffListTables(document, () => 680);
    await drawFrames(offList);
    const block = `${longTableBlockOf("settled")}\n\n${longTableBlockOf("settled-next")}`;
    const geometry = await landTable(offList, block, "settled");

    const [parsedAnew, nextInBlock] = longTablesOf(parseMarkdown(block));
    if (parsedAnew === undefined || nextInBlock === undefined) {
      expect.fail("two long tables");
    }
    expect(
      offList.measure(parsedAnew, settledTableKeyOf("settled", "", parsedAnew), new Set(), vi.fn()),
      "the block parsed anew, measured off the list",
    ).toBe(undefined);
    const withFootnotes = longTablesOf(parseMarkdown(FOOTNOTE_PREAMBLE + block))[0];
    const unfiledKeys = {
      "the block parsed after other definitions": settledTableKeyOf(
        "settled",
        FOOTNOTE_PREAMBLE,
        withFootnotes ?? expect.fail("a long table"),
      ),
      "the next table in the block": settledTableKeyOf("settled", "", nextInBlock),
    };
    for (const [unfiled, tableKey] of Object.entries(unfiledKeys)) {
      const withdraw = offList.measure(parsedAnew, tableKey, new Set(), vi.fn());
      expect(withdraw, unfiled).not.toBe(undefined);
      withdraw?.();
    }

    const listed = listedTableOf(
      parsedAnew,
      bodyPlacementOf(() => "settled"),
      offList,
    );
    listed.update();
    expect(listed.heldColumns, "the columns its first frame draws").toBe(geometry.columns);
  });

  it("hands a streaming table's geometry to its remounts and to its settled block", async () => {
    const offList = new OffListTables(document, () => 680);
    await drawFrames(offList);
    const block = longTableBlockOf("streaming");
    const geometry = await landTable(offList, block, "measured-before");
    const paragraph = "Ahead of the table.\n\n";
    // The tail holds the paragraph and the table until the paragraph settles as block 0.
    const settledFingerprints: string[] = [];
    const placement = bodyPlacementOf(
      (index) => settledFingerprints[index],
      (index) => (index === 0 ? 0 : paragraph.length),
    );
    const bodyType = offList.listedBodyType() ?? expect.fail("a listed body type");
    // What an earlier mount of the streaming table handed on.
    offList.streamingTables.hand(ROW_KEY, paragraph.length, { geometry, bodyType });
    const first = listedTableOf(longTableOf(paragraph + block), placement, offList);
    first.update();
    expect(first.heldColumns, "the columns handed to the first mount").toBe(geometry.columns);
    first.release();

    settledFingerprints.push("paragraph");
    const remounted = listedTableOf(longTableOf(block), placement, offList, 1);
    remounted.update();
    expect(remounted.heldColumns, "the columns it draws, a block ahead settled").toBe(
      geometry.columns,
    );
    // A frame of the stream, the table still drawn.
    remounted.update();

    settledFingerprints.push("table");
    const settled = listedTableOf(longTableOf(block), placement, offList, 1);
    settled.update();
    expect(settled.heldColumns, "the columns its settled block draws").toBe(geometry.columns);
    remounted.release();
    settled.release();
  });

  it("keeps a streaming table's geometry while its row leaves the list, until the log lets it go", async () => {
    const offList = new OffListTables(document, () => 680);
    await drawFrames(offList);
    const block = longTableBlockOf("listed-again");
    const geometry = await landTable(offList, block, "measured-before");
    const bodyType = offList.listedBodyType() ?? expect.fail("a listed body type");
    const isStreaming = (): undefined => undefined;
    // What an earlier mount of the streaming table handed on.
    offList.streamingTables.hand(ROW_KEY, 0, { geometry, bodyType });
    const first = listedTableOf(longTableOf(block), bodyPlacementOf(isStreaming), offList);
    first.update();
    // A frame of the stream, then the row leaves the list and its body unmounts.
    first.update();
    first.release();

    const otherRow = listedTableOf(
      longTableOf(block),
      bodyPlacementOf(isStreaming, () => 0, "other-row"),
      offList,
    );
    otherRow.update();
    expect(otherRow.heldColumns, "another row's table at the same place").toBe(undefined);
    otherRow.release();

    // Listed again with no new rows: a new body, a new parse.
    const listedAgain = listedTableOf(longTableOf(block), bodyPlacementOf(isStreaming), offList);
    listedAgain.update();
    expect(listedAgain.heldColumns, "the columns its row draws listed again").toBe(
      geometry.columns,
    );
    listedAgain.release();

    offList.streamingTables.retainRows(new Map());
    const afterLetGo = listedTableOf(longTableOf(block), bodyPlacementOf(isStreaming), offList);
    afterLetGo.update();
    expect(afterLetGo.heldColumns, "the columns after the log let its row go").toBe(undefined);
    afterLetGo.release();
  });
});
