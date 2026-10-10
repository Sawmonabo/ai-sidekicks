// The hidden frames long tables are measured in before their rows are listed sit in the window's
// document beside the app; a screen reader and axe must find nothing there, not a table, a cell or
// a row the reader cannot see.

import axe from "axe-core";
import { describe, expect, it } from "vitest";

import { liveBridgeWrapper } from "../helpers/app/frame-fixtures.js";
import { renderSettled } from "../helpers/app/harness.js";
import { AXE_TAGS } from "./axe-run.js";

import { installMeridianTokens } from "#renderer/app/token-installation.js";
import { parseMarkdown } from "#renderer/components/Markdown/parse.js";
import { OffListTableFrames } from "#renderer/features/transcript/rows/bodies/OffListTableFrames.js";
import { longTablesOf } from "#renderer/features/transcript/rows/markdown/table-window/long-tables.js";
import { OffListTables } from "#renderer/features/transcript/rows/markdown/table-window/off-list.js";

const FRAMES_SELECTOR = ".meridian-off-list-table-frames";

/** A table longer than any drawn whole, a visible one beside it for axe to find. */
const LONG_TABLE = [
  "| Lane | State |",
  "| --- | --- |",
  ...Array.from({ length: 80 }, (_, index) => `| lane-${String(index)} | running |`),
].join("\n");

describe("accessibility — the frames long tables are measured in off the list", () => {
  it("leave no node for axe to find", async () => {
    installMeridianTokens(document);
    const offList = new OffListTables(document, () => 680);
    const table = longTablesOf(parseMarkdown(LONG_TABLE))[0] ?? expect.fail("a long table");
    const withdraw = offList.measure(table, new Set(), () => undefined);
    const Wrapper = liveBridgeWrapper();
    await renderSettled(
      <Wrapper>
        <table>
          <thead>
            <tr>
              <th>Visible</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>cell</td>
            </tr>
          </tbody>
        </table>
        <OffListTableFrames offList={offList} />
      </Wrapper>,
    );
    expect(document.querySelector(`${FRAMES_SELECTOR} table`)).not.toBe(null);

    const results = await axe.run(document.body, {
      runOnly: { type: "tag", values: [...AXE_TAGS] },
    });
    const found = [...results.violations, ...results.passes, ...results.incomplete].flatMap(
      (result) =>
        result.nodes.map((node) => ({
          rule: result.id,
          element: document.querySelector(node.target.join(" ")),
        })),
    );
    expect(found.length).toBeGreaterThan(0);
    // The frames themselves are seen only as hidden ones holding nothing to focus.
    const frames = document.querySelector(FRAMES_SELECTOR);
    expect(found.filter((node) => node.element === frames).map((node) => node.rule)).toEqual([
      "aria-hidden-focus",
    ]);
    const inside = found.filter(
      (node) => node.element !== frames && node.element?.closest(FRAMES_SELECTOR) !== null,
    );
    expect(inside.map((node) => `${node.rule}: ${node.element?.tagName ?? "?"}`)).toEqual([]);
    withdraw?.();
  });
});
