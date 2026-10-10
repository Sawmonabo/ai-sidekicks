// A long table measured off the list reads its fingerprint, which walks every row's text, once for
// the check that no geometry is filed for it, its filing, and the listed table that recalls it.
// Measured in the engine that lays its hidden frames out, as the frames are read only after a real
// layout.

import { waitFor } from "@testing-library/react";
import type { Table } from "mdast";
import { describe, expect, it, vi } from "vitest";

import { liveBridgeWrapper } from "../../../helpers/app/frame-fixtures.js";
import { renderSettled } from "../../../helpers/app/harness.js";

import { installMeridianTokens } from "#renderer/app/token-installation.js";
import { parseMarkdown } from "#renderer/components/Markdown/parse.js";
import { OffListTableFrames } from "#renderer/features/transcript/rows/bodies/OffListTableFrames.js";
import { suiteWindowViewport } from "#renderer/features/transcript/rows/bodies/WindowedMarkdown.test-support.js";
import { fingerprintOf } from "#renderer/features/transcript/rows/markdown/body-blocks.js";
import {
  type ListedBodies,
  type TableBodyPlacement,
} from "#renderer/features/transcript/rows/markdown/table-window/context.js";
import { longTablesOf } from "#renderer/features/transcript/rows/markdown/table-window/long-tables.js";
import { TableWindowLayout } from "#renderer/features/transcript/rows/markdown/table-window/layout.js";
import { OffListTables } from "#renderer/features/transcript/rows/markdown/table-window/off-list.js";
import { ManualClock } from "#renderer/lib/clock.js";
import { ScrollController } from "#renderer/lib/scroll/chokepoint.js";

// Each table walk ends in one hash of the text it read.
vi.mock("#renderer/features/transcript/rows/markdown/body-blocks.js", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("#renderer/features/transcript/rows/markdown/body-blocks.js")
    >();
  return { ...original, fingerprintOf: vi.fn(original.fingerprintOf) };
});

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

describe("a long table measured off the list", () => {
  it("walks its rows once for its fingerprint, from its filed check to the listed table's recall", async () => {
    installMeridianTokens(document);
    const offList = new OffListTables(document, () => 680);
    // The feed hands its off-list tables to its listed tables as their listed bodies.
    const listedBodies: ListedBodies = offList;
    const Wrapper = liveBridgeWrapper();
    await renderSettled(
      <Wrapper>
        <OffListTableFrames offList={offList} />
      </Wrapper>,
    );
    // The first table's land reads the body type rows are set at, so the second's filed check
    // reads its fingerprint.
    const firstLanded = vi.fn();
    offList.measure(longTableOf("first"), new Set(), firstLanded);
    await waitFor(() => expect(firstLanded).toHaveBeenCalledOnce(), { timeout: LAND_TIMEOUT_MS });

    vi.mocked(fingerprintOf).mockClear();
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
    expect(vi.mocked(fingerprintOf), "walks of the second table").toHaveBeenCalledOnce();
  });
});
