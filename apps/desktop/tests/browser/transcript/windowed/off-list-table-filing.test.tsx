// A long table measured off the list reads its fingerprint, which walks every row's text, once for
// the check that no geometry is filed for it, its filing, and the listed table that recalls it,
// and never whole in one task: measured, it reads it beside its row estimates and lands in a task
// of its own; parsed anew while its geometry is filed, it reads it in slices and lands from the
// filing. Measured in the engine that lays its hidden frames out, as the frames are read only
// after a real layout.

import { waitFor } from "@testing-library/react";
import type { Table } from "mdast";
import { afterEach, describe, expect, it, vi } from "vitest";

import { liveBridgeWrapper } from "../../../helpers/app/frame-fixtures.js";
import { renderSettled } from "../../../helpers/app/harness.js";

import { installMeridianTokens } from "#renderer/app/token-installation.js";
import { parseMarkdown } from "#renderer/components/Markdown/parse.js";
import { OffListTableFrames } from "#renderer/features/transcript/rows/bodies/OffListTableFrames.js";
import { suiteWindowViewport } from "#renderer/features/transcript/rows/bodies/WindowedMarkdown.test-support.js";
import { TextFingerprint } from "#renderer/features/transcript/rows/markdown/body-blocks.js";
import {
  type ListedBodies,
  type TableBodyPlacement,
} from "#renderer/features/transcript/rows/markdown/table-window/context.js";
import { recallTableGeometry } from "#renderer/features/transcript/rows/markdown/table-window/geometry-memory.js";
import { longTablesOf } from "#renderer/features/transcript/rows/markdown/table-window/long-tables.js";
import { TableWindowLayout } from "#renderer/features/transcript/rows/markdown/table-window/layout.js";
import { OffListTables } from "#renderer/features/transcript/rows/markdown/table-window/off-list.js";
import { TableFingerprints } from "#renderer/features/transcript/rows/markdown/table-window/table-text.js";
import { ManualClock } from "#renderer/lib/clock.js";
import { ScrollController } from "#renderer/lib/scroll/chokepoint.js";

/** How long a table's hidden frames take to be laid out, read and filed, with room to spare. */
const LAND_TIMEOUT_MS = 10_000;

/** A selection that never starts. */
const NO_SELECTION = { subscribe: () => () => undefined, read: () => undefined };

/** A markdown body that has mounted no element and placed no block. */
const UNLAID_PLACEMENT: TableBodyPlacement = {
  bodyType: undefined,
  ownerDocument: undefined,
  definitionPreambleLength: 0,
  blockSourceStart: () => 0,
  anchorOf: () => null,
  anchorTopPx: () => undefined,
  subscribeToPlacement: () => () => undefined,
};

/** A parsed table longer than any drawn whole, its lanes named by `name`. */
function longTableOf(name: string): Table {
  const source = [
    "| Lane | State |",
    "| --- | --- |",
    ...Array.from({ length: 80 }, (_, index) => `| ${name}-${String(index)} | running |`),
  ].join("\n");
  return longTablesOf(parseMarkdown(source))[0] ?? expect.fail("a long table");
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

/** The posted task each row's text was read in for a fingerprint, as `readRunningTask` answers. */
function followRowReads(readRunningTask: () => number | undefined): (number | undefined)[] {
  const read = TextFingerprint.prototype.read;
  const tasks: (number | undefined)[] = [];
  vi.spyOn(TextFingerprint.prototype, "read").mockImplementation(function (
    this: TextFingerprint,
    text: string,
  ) {
    tasks.push(readRunningTask());
    read.call(this, text);
  });
  return tasks;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a long table measured off the list", () => {
  it("walks its rows once for its fingerprint, from its filed check to the listed table's recall", async () => {
    const offList = new OffListTables(document, () => 680);
    // The feed hands its off-list tables to its listed tables as their listed bodies.
    const listedBodies: ListedBodies = offList;
    await drawFrames(offList);
    // The first table's land reads the body type rows are set at, so the second's filed check
    // reads its fingerprint.
    const firstLanded = vi.fn();
    offList.measure(longTableOf("first"), new Set(), firstLanded);
    await waitFor(() => expect(firstLanded).toHaveBeenCalledOnce(), { timeout: LAND_TIMEOUT_MS });

    const rowReads = vi.spyOn(TextFingerprint.prototype, "read");
    const second = longTableOf("second");
    const secondLanded = vi.fn();
    expect(offList.measure(second, new Set(), secondLanded)).not.toBe(undefined);
    await waitFor(() => expect(secondLanded).toHaveBeenCalledOnce(), { timeout: LAND_TIMEOUT_MS });
    // Filed: measured again, it is not drawn off the list.
    expect(offList.measure(second, new Set(), () => undefined)).toBe(undefined);
    // Listed, in a body not yet laid out: it lays out at the listed bodies' type and recalls the
    // geometry filed there.
    const listed = new TableWindowLayout(
      {
        viewport: suiteWindowViewport(
          new ScrollController({ clock: new ManualClock() }),
          NO_SELECTION,
        ),
        placement: UNLAID_PLACEMENT,
      },
      second,
      0,
      () => undefined,
      listedBodies,
    );
    listed.update();
    expect(listed.heldColumns, "the columns the listed table recalls").not.toBe(undefined);
    expect(rowReads, "rows read of the second table").toHaveBeenCalledTimes(second.children.length);
  });

  it("reads its fingerprint beside its row estimates, and lands in a task of its own", async () => {
    const offList = new OffListTables(document, () => 680);
    await drawFrames(offList);
    const runningTask = followPostedTasks();
    const rowReadTasks = followRowReads(runningTask);
    const table = longTableOf("sliced");
    let landedIn: number | undefined;
    const landed = vi.fn(() => {
      landedIn = runningTask();
    });
    offList.measure(table, new Set(), landed);
    await waitFor(() => expect(landed).toHaveBeenCalledOnce(), { timeout: LAND_TIMEOUT_MS });

    expect(landedIn, "the posted task the table lands in").not.toBe(undefined);
    expect(rowReadTasks, "rows read").toHaveLength(table.children.length);
    expect(
      rowReadTasks.filter((task) => task === landedIn),
      "rows read in the task the table lands in",
    ).toEqual([]);
    expect(offList.tableFingerprints.fingerprintOf(table), "the fingerprint read in slices").toBe(
      new TableFingerprints().fingerprintOf(table),
    );
  });

  it("lands a table parsed anew while its geometry is filed, its fingerprint read in slices", async () => {
    const offList = new OffListTables(document, () => 680);
    await drawFrames(offList);
    const filed = longTableOf("filed");
    const filedLanded = vi.fn();
    offList.measure(filed, new Set(), filedLanded);
    await waitFor(() => expect(filedLanded).toHaveBeenCalledOnce(), { timeout: LAND_TIMEOUT_MS });
    const geometryKey = {
      fingerprint: offList.tableFingerprints.fingerprintOf(filed),
      bodyType: offList.listedBodyType() ?? expect.fail("a listed body type"),
    };
    const geometry = recallTableGeometry(geometryKey);

    const rowReadTasks = followRowReads(followPostedTasks());
    // The same text parsed again: a table whose fingerprint is not read yet.
    const parsedAnew = longTableOf("filed");
    const landed = vi.fn();
    expect(
      offList.measure(parsedAnew, new Set(), landed),
      "the withdrawal of a table not read yet",
    ).not.toBe(undefined);
    expect(rowReadTasks, "rows read as it is measured").toEqual([]);
    await waitFor(() => expect(landed).toHaveBeenCalledOnce(), { timeout: LAND_TIMEOUT_MS });
    expect(rowReadTasks, "rows read").toHaveLength(parsedAnew.children.length);
    expect(
      rowReadTasks.filter((task) => task === undefined),
      "rows read outside a slice",
    ).toEqual([]);
    expect(recallTableGeometry(geometryKey), "the geometry it landed with").toBe(geometry);
    expect(offList.read(), "the tables still measured").toEqual([]);
  });
});
